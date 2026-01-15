from __future__ import annotations

import asyncio
import base64
import binascii
import dataclasses
import json
import os
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from noshitproxy.models import (
    FlowCompact,
    FlowQuery,
    FlowSummary,
    RepeatResponse,
    SseEvent,
)

from .repeater import repeat_request
from .store import Store, StoreConfig

APP_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = APP_ROOT / "frontend"
INDEX_HTML = FRONTEND_DIR / "index.html"

_db_path = os.environ.get("NO_SHIT_PROXY_DB", "noshitproxy.sqlite3")
store = Store(StoreConfig(db_path=_db_path))

_subscribers: set[asyncio.Queue[str]] = set()
_sub_lock = asyncio.Lock()

_HOP_BY_HOP_HEADERS = {
    "connection",
    "proxy-connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "content-encoding",
}

_replay_lock = asyncio.Lock()
_replay_requests: dict[str, tuple[float, str, str, list[tuple[str, str]], bytes]] = {}
_REPLAY_TTL_S = 60.0
_REPLAY_PARAM = "__nsp"


class FlowCompactIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    ts: float
    method: str
    url: str
    host: str | None = None
    path: str | None = None
    status: int | None = None
    duration: float | None = None
    req_headers: list[tuple[str, str]] = Field(default_factory=list)
    resp_headers: list[tuple[str, str]] = Field(default_factory=list)
    req_size: int = 0
    resp_size: int = 0
    req_body_b64: str | None = None
    req_preview: str | None = None
    resp_preview: str | None = None
    resp_body_b64: str | None = None


class IngestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["flow"]
    data: FlowCompactIn


class FlowListQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    limit: int = Field(default=200, ge=1, le=2000)
    offset: int = Field(default=0, ge=0)
    q: str | None = None
    host: str | None = None
    method: str | None = None
    status: int | None = None
    url_contains: str | None = None
    body_contains: str | None = None
    duration_min: float | None = Field(default=None, ge=0)
    duration_max: float | None = Field(default=None, ge=0)
    resp_size_min: int | None = Field(default=None, ge=0)
    resp_size_max: int | None = Field(default=None, ge=0)
    sort: Literal["num", "method", "url", "status", "size", "time"] | None = None
    order: Literal["asc", "desc"] | None = None


class RepeatRequestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: str = "GET"
    url: str
    headers: str = ""
    body: str = ""


class FullResponseOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body_b64: str
    content_type: str | None = None
    bytes: int


class ReplayOpenRequestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: str
    url: str
    headers: list[tuple[str, str]] = Field(default_factory=list)
    body: str = ""


def _event_to_json(event: SseEvent) -> str:
    payload = {"type": event.event_type, "data": dataclasses.asdict(event.data)}
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _prune_replay(now: float) -> None:
    expired: list[str] = []
    for key, (ts, _, _, _, _) in _replay_requests.items():
        if now - ts > _REPLAY_TTL_S:
            expired.append(key)

    for key in expired:
        _replay_requests.pop(key, None)


def _filter_upstream_headers(headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for key, value in headers:
        if key.lower() in _HOP_BY_HOP_HEADERS:
            continue
        out.append((key, value))
    return out


def _make_browser_url(url: str, token: str) -> str:
    parts = urlsplit(url)
    query = parse_qsl(parts.query, keep_blank_values=True)
    query.append((_REPLAY_PARAM, token))
    new_query = urlencode(query)
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, new_query, parts.fragment)
    )


def _filtered_raw_headers(response: httpx.Response) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for key_raw, value_raw in response.headers.raw:
        key = key_raw.decode("utf-8", "replace")
        value = value_raw.decode("utf-8", "replace")
        if key.lower() in _HOP_BY_HOP_HEADERS:
            continue
        out.append((key, value))
    return out


async def publish(event: SseEvent) -> None:
    payload = _event_to_json(event)
    async with _sub_lock:
        for q in list(_subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                continue


async def sse_stream() -> AsyncIterator[str]:
    q: asyncio.Queue[str] = asyncio.Queue(maxsize=500)

    async with _sub_lock:
        _subscribers.add(q)

    try:
        yield "retry: 1000\n\n"
        while True:
            try:
                payload = await asyncio.wait_for(q.get(), timeout=15)
                yield f"data: {payload}\n\n"
            except TimeoutError:
                yield ": keepalive\n\n"
    finally:
        async with _sub_lock:
            _subscribers.discard(q)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await store.open()
    yield
    await store.close()


app = FastAPI(title="noshitproxy", lifespan=lifespan)

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    if not INDEX_HTML.exists():
        return HTMLResponse("<h1>index.html not found</h1>", status_code=500)
    return HTMLResponse(INDEX_HTML.read_text(encoding="utf-8"))


@app.get("/api/events")
async def events() -> StreamingResponse:
    return StreamingResponse(sse_stream(), media_type="text/event-stream")


@app.post("/api/ingest")
async def ingest(payload: IngestRequest) -> dict[str, bool]:
    if payload.type != "flow":
        raise HTTPException(status_code=400, detail="unknown payload type")

    data = payload.data
    flow = FlowCompact(
        id=data.id,
        ts=data.ts,
        method=data.method,
        url=data.url,
        host=data.host,
        path=data.path,
        status=data.status,
        duration=data.duration,
        req_headers=data.req_headers,
        resp_headers=data.resp_headers,
        req_size=data.req_size,
        resp_size=data.resp_size,
        req_body_b64=data.req_body_b64,
        req_preview=data.req_preview,
        resp_preview=data.resp_preview,
    )

    resp_body_text: str | None = None
    if data.resp_body_b64:
        try:
            decoded = base64.b64decode(data.resp_body_b64)
        except (ValueError, binascii.Error):
            decoded = b""

        if decoded:
            resp_body_text = decoded.decode("utf-8", "replace")

    seq = await store.upsert_flow(
        flow,
        resp_body_b64=data.resp_body_b64,
        resp_body_text=resp_body_text,
    )

    summary = FlowSummary(
        seq=seq,
        id=flow.id,
        ts=flow.ts,
        method=flow.method,
        url=flow.url,
        host=flow.host,
        path=flow.path,
        status=flow.status,
        duration=flow.duration,
        req_size=flow.req_size,
        resp_size=flow.resp_size,
    )

    await publish(SseEvent(event_type="flow", data=summary))
    return {"ok": True}


@app.get("/api/flows")
async def list_flows(
    query: Annotated[FlowListQuery, Depends()],
) -> list[FlowSummary]:
    store_query = FlowQuery(
        limit=query.limit,
        offset=query.offset,
        q=query.q,
        host=query.host,
        method=query.method,
        status=query.status,
        url_contains=query.url_contains,
        body_contains=query.body_contains,
        duration_min=query.duration_min,
        duration_max=query.duration_max,
        resp_size_min=query.resp_size_min,
        resp_size_max=query.resp_size_max,
        sort=query.sort,
        order=query.order,
    )
    return await store.list_flows(store_query)


@app.get("/api/flows/{flow_id}")
async def get_flow(flow_id: str) -> FlowCompact:
    flow = await store.get_flow(flow_id)
    if flow is None:
        raise HTTPException(status_code=404, detail="not found")
    return flow


@app.get("/api/flows/{flow_id}/response/body")
async def get_flow_response_body(flow_id: str) -> FullResponseOut:
    item = await store.get_resp_body(flow_id)
    if item is None:
        raise HTTPException(status_code=404, detail="not stored")

    body_b64, content_type, size = item
    return FullResponseOut(body_b64=body_b64, content_type=content_type, bytes=size)


@app.post("/api/repeat")
async def repeat(payload: RepeatRequestIn) -> RepeatResponse:
    url = payload.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400, detail="url must start with http:// or https://"
        )

    return await repeat_request(
        method=payload.method.strip(),
        url=url,
        headers_text=payload.headers,
        body_text=payload.body,
    )


@app.post("/api/replay/open")
async def replay_open(payload: ReplayOpenRequestIn) -> dict[str, str]:
    url = payload.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400, detail="url must start with http:// or https://"
        )

    token = secrets.token_urlsafe(16)
    now = time.time()

    method = payload.method.strip().upper()
    headers = _filter_upstream_headers(payload.headers)
    body = payload.body.encode("utf-8", "replace")

    async with _replay_lock:
        _prune_replay(now)
        _replay_requests[token] = (now, method, url, headers, body)

    out = {"url": f"/replay/{token}"}
    if method == "GET" and body == b"":
        out["browser_url"] = _make_browser_url(url, token)

    return out


@app.get("/api/replay/{token}")
async def replay_get_spec(token: str) -> dict[str, object]:
    async with _replay_lock:
        now = time.time()
        _prune_replay(now)
        item = _replay_requests.get(token)

    if item is None:
        raise HTTPException(status_code=404, detail="not found")

    _, method, url, headers, body = item
    return {
        "method": method,
        "url": url,
        "headers": headers,
        "body": body.decode("utf-8", "replace"),
    }


@app.get("/replay/{token}")
async def replay_get(token: str) -> Response:
    async with _replay_lock:
        now = time.time()
        _prune_replay(now)
        item = _replay_requests.get(token)

    if item is None:
        raise HTTPException(status_code=404, detail="not found")

    _, method, url, headers, body = item

    async with httpx.AsyncClient(follow_redirects=False, timeout=20.0) as client:
        upstream = await client.request(
            method=method,
            url=url,
            headers=headers,
            content=body,
        )

    response = Response(
        content=upstream.content,
        status_code=upstream.status_code,
    )

    for key, value in _filtered_raw_headers(upstream):
        response.headers.append(key, value)

    return response
