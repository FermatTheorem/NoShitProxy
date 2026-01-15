from __future__ import annotations

import dataclasses
import fnmatch
import json
import queue
import re
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
BACKEND_SCOPE = "http://127.0.0.1:8000/api/scope"
REPLAY_PARAM = "__nsp"

HTTP_OK = 200
HEADER_PAIR_LEN = 2

WILDCARD_CHARS = set("*?[")


def _compile_scope_pattern(pattern: str) -> tuple[re.Pattern[str], bool]:
    # If pattern has no wildcard syntax, treat it as substring match.
    if not any(ch in pattern for ch in WILDCARD_CHARS):
        return re.compile(re.escape(pattern)), True

    return re.compile(fnmatch.translate(pattern)), False


def _matches(regex: re.Pattern[str], *, substring: bool, url: str) -> bool:
    return (regex.search(url) if substring else regex.match(url)) is not None


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

        self._scope_lock = threading.Lock()
        self._scope_drop = False
        self._scope_include: list[str] = ["*"]
        self._scope_exclude: list[str] = []
        self._scope_include_regex: list[tuple[re.Pattern[str], bool]] = [
            _compile_scope_pattern("*")
        ]
        self._scope_exclude_regex: list[tuple[re.Pattern[str], bool]] = []

        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

        self._scope_worker = threading.Thread(target=self._poll_scope, daemon=True)
        self._scope_worker.start()

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

    def _poll_scope(self) -> None:
        with httpx.Client(timeout=2.0) as client:
            while True:
                try:
                    response = client.get(BACKEND_SCOPE)
                    if response.status_code == HTTP_OK:
                        data = response.json()
                        if not isinstance(data, dict):
                            continue

                        include_obj = data.get("include")
                        exclude_obj = data.get("exclude")
                        if include_obj is None and "patterns" in data:
                            include_obj = data.get("patterns")

                        drop_obj = data.get("drop")

                        include: list[str] = []
                        if isinstance(include_obj, list):
                            include.extend(
                                p.strip()
                                for p in include_obj
                                if isinstance(p, str) and p.strip()
                            )

                        exclude: list[str] = []
                        if isinstance(exclude_obj, list):
                            exclude.extend(
                                p.strip()
                                for p in exclude_obj
                                if isinstance(p, str) and p.strip()
                            )

                        drop = bool(drop_obj) if isinstance(drop_obj, bool) else False

                        self._set_scope(
                            include=include or ["*"],
                            exclude=exclude,
                            drop=drop,
                        )
                except (httpx.HTTPError, OSError, ValueError):
                    time.sleep(2.0)

                time.sleep(1.0)

    def _set_scope(
        self,
        *,
        include: list[str],
        exclude: list[str],
        drop: bool,
    ) -> None:
        include_compiled = [_compile_scope_pattern(p) for p in include]
        exclude_compiled = [_compile_scope_pattern(p) for p in exclude]

        with self._scope_lock:
            self._scope_include = include
            self._scope_exclude = exclude
            self._scope_drop = drop
            self._scope_include_regex = include_compiled
            self._scope_exclude_regex = exclude_compiled

    def _should_drop_out_of_scope(self) -> bool:
        with self._scope_lock:
            return self._scope_drop

    def _in_scope(self, url: str) -> bool:
        with self._scope_lock:
            include = self._scope_include_regex
            exclude = self._scope_exclude_regex

        if not include:
            return True

        if not any(
            _matches(regex, substring=is_sub, url=url) for regex, is_sub in include
        ):
            return False

        return not any(
            _matches(regex, substring=is_sub, url=url) for regex, is_sub in exclude
        )

    def request(self, flow: http.HTTPFlow) -> None:
        token, new_url = _strip_replay_param(flow.request.pretty_url)
        if token is not None and new_url is not None:
            spec = self._fetch_replay_spec(token)
            if (
                spec is not None
                and spec.method == flow.request.method.upper()
                and spec.method == "GET"
                and not spec.body
            ):
                flow.request.url = new_url
                flow.request.headers.clear()
                for key, value in spec.headers:
                    flow.request.headers.add(key, value)

        url = flow.request.pretty_url
        in_scope = self._in_scope(url)
        flow.metadata["nsp_in_scope"] = in_scope

        if not in_scope and self._should_drop_out_of_scope():
            flow.kill()  # type: ignore[no-untyped-call]

    def response(self, flow: http.HTTPFlow) -> None:
        in_scope = flow.metadata.get("nsp_in_scope")
        if in_scope is False:
            return

        # If no request hook ran (shouldn't happen), fall back to check.
        if in_scope is None and not self._in_scope(flow.request.pretty_url):
            return

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
