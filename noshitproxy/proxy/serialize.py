from __future__ import annotations

import base64
import json
import re
import time
from typing import TYPE_CHECKING

from noshitproxy.models import FlowCompact

if TYPE_CHECKING:
    from mitmproxy import http

MAX_PREVIEW = 8192
MAX_REQ_BODY_STORE = 256 * 1024
MAX_RESP_BODY_STORE = 2 * 1024 * 1024
MAX_FORMAT_BYTES = 256 * 1024

_CHARSET_RE = re.compile(r"charset=([^;]+)", re.IGNORECASE)


def _charset_from_content_type(content_type: str | None) -> str:
    if content_type is None:
        return "utf-8"

    match = _CHARSET_RE.search(content_type)
    if match is None:
        return "utf-8"

    charset = match.group(1).strip().strip('"').strip("'")
    return charset or "utf-8"


def _safe_decode(data: bytes, limit: int, charset: str) -> str | None:
    if not data:
        return None
    return data[:limit].decode(charset, "replace")


def _headers_to_list(
    headers: http.Headers,
    *,
    collapse_cookie: bool,
) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []

    cookie_index: int | None = None
    cookie_parts: list[str] = []

    for key_raw, value_raw in headers.fields:
        key = key_raw.decode("utf-8", "replace")
        value = value_raw.decode("utf-8", "replace")

        if collapse_cookie and key.lower() == "cookie":
            if cookie_index is None:
                cookie_index = len(out)
            cookie_parts.append(value.strip())
            continue

        out.append((key, value))

    if cookie_index is not None:
        cookie_value = "; ".join(part for part in cookie_parts if part)
        if cookie_value:
            out.insert(cookie_index, ("cookie", cookie_value))

    return out


def _preview_text(data: bytes, *, content_type: str | None) -> str | None:
    if not data:
        return None

    charset = _charset_from_content_type(content_type)

    is_json = content_type is not None and "json" in content_type.lower()

    if is_json and len(data) <= MAX_FORMAT_BYTES:
        raw = data.decode(charset, "replace")
        try:
            loaded: object = json.loads(raw)
        except json.JSONDecodeError:
            return _safe_decode(data, MAX_PREVIEW, charset)

        formatted = json.dumps(loaded, ensure_ascii=False, indent=2)
        return formatted[:MAX_PREVIEW]

    return _safe_decode(data, MAX_PREVIEW, charset)


def flow_ingest(flow: http.HTTPFlow) -> tuple[FlowCompact, str | None]:
    request = flow.request
    response = flow.response

    request_raw = request.raw_content or b""
    request_content = request.get_content(strict=False) or b""

    request_content_type = request.headers.get("content-type")

    response_raw = b""
    response_content = b""
    response_content_type: str | None = None
    if response is not None:
        response_raw = response.raw_content or b""
        response_content = response.get_content(strict=False) or b""
        response_content_type = response.headers.get("content-type")

    ts_value = getattr(flow, "timestamp_start", None)
    ts = float(ts_value) if isinstance(ts_value, (int, float)) else time.time()

    duration: float | None = None
    if response is not None:
        ts_end = response.timestamp_end
        if ts_end is not None and ts_end >= ts:
            duration = round(ts_end - ts, 3)

    request_body_b64: str | None
    if request_raw and len(request_raw) <= MAX_REQ_BODY_STORE:
        request_body_b64 = base64.b64encode(request_raw).decode("ascii")
    else:
        request_body_b64 = None

    resp_body_b64: str | None = None
    if response_content and len(response_content) <= MAX_RESP_BODY_STORE:
        resp_body_b64 = base64.b64encode(response_content).decode("ascii")

    compact = FlowCompact(
        id=flow.id,
        ts=ts,
        method=request.method,
        url=request.pretty_url,
        host=request.host,
        path=request.path,
        status=int(response.status_code) if response is not None else None,
        duration=duration,
        req_headers=_headers_to_list(request.headers, collapse_cookie=True),
        resp_headers=_headers_to_list(response.headers, collapse_cookie=False)
        if response is not None
        else [],
        req_size=len(request_raw),
        resp_size=len(response_raw),
        req_body_b64=request_body_b64,
        req_preview=_preview_text(request_content, content_type=request_content_type),
        resp_preview=_preview_text(
            response_content, content_type=response_content_type
        ),
    )

    return compact, resp_body_b64
