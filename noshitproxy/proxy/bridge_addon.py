from __future__ import annotations

import dataclasses
import json
import queue
import threading
import time
from contextlib import suppress
from typing import TYPE_CHECKING
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from noshitproxy.proxy.serialize import flow_ingest

if TYPE_CHECKING:
    from mitmproxy import http

    from noshitproxy.models import FlowCompact

BACKEND_INGEST = "http://127.0.0.1:8000/api/ingest"
BACKEND_REPLAY = "http://127.0.0.1:8000/api/replay"
REPLAY_PARAM = "__nsp"

HTTP_OK = 200
HEADER_PAIR_LEN = 2


class ReplaySpec:
    __slots__ = ("body", "headers", "method", "url")

    def __init__(
        self,
        *,
        method: str,
        url: str,
        headers: list[tuple[str, str]],
        body: str,
    ) -> None:
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body


def _strip_replay_param(url: str) -> tuple[str | None, str | None]:
    parts = urlsplit(url)
    query = parse_qsl(parts.query, keep_blank_values=True)

    token: str | None = None
    new_query: list[tuple[str, str]] = []
    for key, value in query:
        if key == REPLAY_PARAM:
            token = value
            continue
        new_query.append((key, value))

    if token is None:
        return None, None

    rebuilt = urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(new_query), parts.fragment)
    )
    return token, rebuilt


class BridgeAddon:
    def __init__(self, ingest_url: str = BACKEND_INGEST) -> None:
        self._ingest_url = ingest_url
        self._queue: queue.Queue[str] = queue.Queue(maxsize=10_000)
        self._replay_client = httpx.Client(timeout=1.0)
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def _run(self) -> None:
        with httpx.Client(timeout=2.0) as client:
            while True:
                payload = self._queue.get()
                try:
                    client.post(
                        self._ingest_url,
                        content=payload,
                        headers={"content-type": "application/json"},
                    )
                except (httpx.HTTPError, OSError):
                    time.sleep(0.05)

    def request(self, flow: http.HTTPFlow) -> None:
        token, new_url = _strip_replay_param(flow.request.pretty_url)
        if token is None or new_url is None:
            return

        spec = self._fetch_replay_spec(token)
        if spec is None:
            return

        if spec.method != flow.request.method.upper():
            return

        if spec.method != "GET" or spec.body:
            return

        flow.request.url = new_url
        flow.request.headers.clear()
        for key, value in spec.headers:
            flow.request.headers.add(key, value)

    def response(self, flow: http.HTTPFlow) -> None:
        compact, resp_body_b64 = flow_ingest(flow)
        payload = self._encode_payload(compact, resp_body_b64=resp_body_b64)
        with suppress(queue.Full):
            self._queue.put_nowait(payload)

    def _fetch_replay_spec(self, token: str) -> ReplaySpec | None:
        try:
            response = self._replay_client.get(f"{BACKEND_REPLAY}/{token}")
        except (httpx.HTTPError, OSError):
            return None

        spec: ReplaySpec | None = None
        if response.status_code == HTTP_OK:
            try:
                data: object = response.json()
            except ValueError:
                data = None

            if isinstance(data, dict):
                method = data.get("method")
                url = data.get("url")
                headers = data.get("headers")
                body = data.get("body")

                if (
                    isinstance(method, str)
                    and isinstance(url, str)
                    and isinstance(headers, list)
                    and isinstance(body, str)
                ):
                    header_pairs = [
                        (item[0], item[1])
                        for item in headers
                        if (
                            isinstance(item, (list, tuple))
                            and len(item) == HEADER_PAIR_LEN
                            and isinstance(item[0], str)
                            and isinstance(item[1], str)
                        )
                    ]

                    spec = ReplaySpec(
                        method=method.upper(),
                        url=url,
                        headers=header_pairs,
                        body=body,
                    )

        return spec

    @staticmethod
    def _encode_payload(flow: FlowCompact, *, resp_body_b64: str | None) -> str:
        data = dataclasses.asdict(flow)
        data["resp_body_b64"] = resp_body_b64
        envelope = {"type": "flow", "data": data}
        return json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))


addons = [BridgeAddon()]
