from __future__ import annotations

import base64
from collections.abc import Iterable

import httpx

from noshitproxy.models import RepeatResponse

DROP_REQUEST_HEADERS = {
    "connection",
    "proxy-connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
}


def parse_headers_text(headers_text: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for raw_line in headers_text.splitlines():
        line = raw_line.strip()
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if key.lower() in DROP_REQUEST_HEADERS:
            continue
        out.append((key, value.strip()))
    return out


def headers_list_to_text(headers: Iterable[tuple[str, str]]) -> str:
    return "\n".join(f"{key}: {value}" for key, value in headers)


def _preview_text(data: bytes, limit: int) -> str:
    return data[:limit].decode("utf-8", "replace")


def _b64_prefix(data: bytes, limit: int) -> str:
    return base64.b64encode(data[:limit]).decode("ascii")


async def repeat_request(
    method: str,
    url: str,
    headers_text: str,
    body_text: str,
    timeout_s: float = 20.0,
) -> RepeatResponse:
    headers = parse_headers_text(headers_text)
    content = body_text.encode("utf-8", "replace")

    async with httpx.AsyncClient(follow_redirects=False, timeout=timeout_s) as client:
        response = await client.request(
            method=method.upper(),
            url=url,
            headers=headers,
            content=content,
        )

    raw = response.content or b""

    return RepeatResponse(
        status=response.status_code,
        headers=headers_list_to_text(response.headers.items()),
        preview=_preview_text(raw, 8192),
        body_first64k_b64=_b64_prefix(raw, 65536),
        bytes=len(raw),
    )
