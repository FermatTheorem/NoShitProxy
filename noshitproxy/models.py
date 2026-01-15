from __future__ import annotations

import dataclasses
from typing import Literal


@dataclasses.dataclass(frozen=True, slots=True)
class FlowCompact:
    id: str
    ts: float
    method: str
    url: str
    host: str | None
    path: str | None
    status: int | None
    duration: float | None
    req_headers: list[tuple[str, str]]
    resp_headers: list[tuple[str, str]]
    req_size: int
    resp_size: int
    req_body_b64: str | None
    req_preview: str | None
    resp_preview: str | None


@dataclasses.dataclass(frozen=True, slots=True)
class FlowSummary:
    seq: int
    id: str
    ts: float
    method: str
    url: str
    host: str | None
    path: str | None
    status: int | None
    duration: float | None
    req_size: int
    resp_size: int


@dataclasses.dataclass(frozen=True, slots=True)
class FlowQuery:
    limit: int = 200
    offset: int = 0
    where: str | None = None
    sort: str | None = None
    order: Literal["asc", "desc"] | None = None


@dataclasses.dataclass(frozen=True, slots=True)
class RepeatRequest:
    method: str
    url: str
    headers: str
    body: str


@dataclasses.dataclass(frozen=True, slots=True)
class RepeatResponse:
    status: int
    headers: str
    preview: str
    body_first64k_b64: str
    bytes: int


@dataclasses.dataclass(frozen=True, slots=True)
class SseEvent:
    event_type: Literal["flow"]
    data: FlowSummary
