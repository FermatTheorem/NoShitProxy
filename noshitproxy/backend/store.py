from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime

import aiosqlite

from noshitproxy.models import FlowCompact, FlowQuery, FlowSummary


@dataclass(frozen=True, slots=True)
class StoreConfig:
    db_path: str = "noshitproxy.sqlite3"
    max_rows: int = 50_000


class StoreNotOpenError(RuntimeError):
    pass


class InvalidWhereError(ValueError):
    pass


class Store:
    def __init__(self, cfg: StoreConfig) -> None:
        self._cfg = cfg
        self._db: aiosqlite.Connection | None = None

    async def open(self) -> None:
        self._db = await aiosqlite.connect(self._cfg.db_path)
        await self._db.execute("PRAGMA journal_mode=WAL;")
        await self._db.execute("PRAGMA synchronous=NORMAL;")
        await self._db.execute("PRAGMA temp_store=MEMORY;")
        await self._db.execute("PRAGMA foreign_keys=ON;")
        await self._init_schema()

    async def close(self) -> None:
        if self._db is None:
            return
        await self._db.close()
        self._db = None

    def _conn(self) -> aiosqlite.Connection:
        if self._db is None:
            raise StoreNotOpenError
        return self._db

    async def _init_schema(self) -> None:
        db = self._conn()
        await db.executescript(
            """
            CREATE TABLE IF NOT EXISTS flows (
              id TEXT PRIMARY KEY,
              ts REAL NOT NULL,
              method TEXT NOT NULL,
              url TEXT NOT NULL,
              host TEXT,
              path TEXT,
              status INTEGER,
              duration REAL,
              start_at TEXT,
              req_headers_json TEXT,
              resp_headers_json TEXT,
              req_size INTEGER,
              resp_size INTEGER,
              req_body_b64 TEXT,
              req_preview TEXT,
              resp_preview TEXT,
              resp_body_b64 TEXT,
              resp_body_text TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_flows_ts ON flows(ts DESC);
            CREATE INDEX IF NOT EXISTS idx_flows_host ON flows(host);
            CREATE INDEX IF NOT EXISTS idx_flows_status ON flows(status);
            CREATE INDEX IF NOT EXISTS idx_flows_method ON flows(method);

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            """
        )
        await db.commit()
        await _ensure_column(db, table="flows", column="resp_body_b64", ddl="TEXT")
        await _ensure_column(db, table="flows", column="resp_body_text", ddl="TEXT")
        await _ensure_column(db, table="flows", column="start_at", ddl="TEXT")
        await _ensure_setting(
            db,
            key="scope",
            value=json.dumps({"include": ["*"], "exclude": [], "drop": False}),
        )

    async def upsert_flow(
        self,
        flow: FlowCompact,
        *,
        resp_body_b64: str | None,
        resp_body_text: str | None,
    ) -> int:
        db = self._conn()
        await db.execute(
            """
             INSERT INTO flows (
              id, ts, method, url, host, path, status, duration,
              start_at,
              req_headers_json, resp_headers_json,
              req_size, resp_size, req_body_b64,
              req_preview, resp_preview,
              resp_body_b64, resp_body_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              ts=excluded.ts,
              method=excluded.method,
              url=excluded.url,
              host=excluded.host,
              path=excluded.path,
              status=excluded.status,
              duration=excluded.duration,
              start_at=excluded.start_at,
              req_headers_json=excluded.req_headers_json,
              resp_headers_json=excluded.resp_headers_json,
              req_size=excluded.req_size,
              resp_size=excluded.resp_size,
              req_body_b64=excluded.req_body_b64,
              req_preview=excluded.req_preview,
              resp_preview=excluded.resp_preview,
              resp_body_b64=excluded.resp_body_b64,
              resp_body_text=excluded.resp_body_text
            """,
            (
                flow.id,
                float(flow.ts),
                flow.method or "GET",
                flow.url,
                flow.host,
                flow.path,
                flow.status,
                flow.duration,
                _format_start_at(flow.ts),
                json.dumps(flow.req_headers, ensure_ascii=False),
                json.dumps(flow.resp_headers, ensure_ascii=False),
                int(flow.req_size),
                int(flow.resp_size),
                flow.req_body_b64,
                flow.req_preview,
                flow.resp_preview,
                resp_body_b64,
                resp_body_text,
            ),
        )
        await db.commit()

        cur = await db.execute("SELECT rowid FROM flows WHERE id = ?", (flow.id,))
        row = await cur.fetchone()
        await cur.close()
        seq = int(row[0]) if row is not None else 0

        await self._prune_if_needed()
        return seq

    async def _prune_if_needed(self) -> None:
        db = self._conn()

        cur = await db.execute("SELECT COUNT(*) FROM flows")
        row = await cur.fetchone()
        await cur.close()

        total = int(row[0]) if row is not None else 0
        if total <= self._cfg.max_rows:
            return

        to_delete = total - self._cfg.max_rows
        await db.execute(
            """
            DELETE FROM flows
            WHERE id IN (
              SELECT id FROM flows
              ORDER BY ts ASC
              LIMIT ?
            )
            """,
            (to_delete,),
        )
        await db.commit()

    async def count_flows(self, *, where: str | None) -> int:
        db = self._conn()
        if where:
            await _validate_where(db, where)

        sql = "SELECT COUNT(*) FROM flows"
        if where:
            sql += f" WHERE ({where})"

        cur = await db.execute(sql)
        row = await cur.fetchone()
        await cur.close()
        return int(row[0]) if row is not None else 0

    async def list_flows(self, query: FlowQuery) -> list[FlowSummary]:
        db = self._conn()

        where: list[str] = []
        params: list[object] = []

        if query.where:
            where.append(f"({query.where})")
            await _validate_where(db, query.where)

        sql_parts = [
            "SELECT rowid, id, ts, method, url, host, path, status, duration,",
            "       req_size, resp_size",
            "FROM flows",
        ]
        if where:
            sql_parts.append("WHERE " + " AND ".join(where))

        sql_parts.append(_order_by_sql(query.sort, query.order))
        sql_parts.append("LIMIT ? OFFSET ?")

        params.extend([int(query.limit), int(query.offset)])
        sql = "\n".join(sql_parts)

        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
        await cur.close()

        return [
            FlowSummary(
                seq=int(row[0]),
                id=row[1],
                ts=row[2],
                method=row[3],
                url=row[4],
                host=row[5],
                path=row[6],
                status=row[7],
                duration=row[8],
                req_size=row[9],
                resp_size=row[10],
                start_at=_format_start_at(row[2]),
            )
            for row in rows
        ]

    async def get_scope(self) -> tuple[list[str], list[str], bool]:
        db = self._conn()
        cur = await db.execute("SELECT value FROM settings WHERE key = ?", ("scope",))
        row = await cur.fetchone()
        await cur.close()

        if row is None or not isinstance(row[0], str) or row[0] == "":
            return ["*"], [], False

        loaded: object = json.loads(row[0])
        if not isinstance(loaded, dict):
            return ["*"], [], False

        # Backward compat: {"patterns": [...], "drop": bool}
        include_obj = loaded.get("include")
        exclude_obj = loaded.get("exclude")
        if include_obj is None and "patterns" in loaded:
            include_obj = loaded.get("patterns")

        drop_obj = loaded.get("drop")

        include: list[str] = []
        if isinstance(include_obj, list):
            include.extend(
                p.strip() for p in include_obj if isinstance(p, str) and p.strip()
            )

        exclude: list[str] = []
        if isinstance(exclude_obj, list):
            exclude.extend(
                p.strip() for p in exclude_obj if isinstance(p, str) and p.strip()
            )

        drop = bool(drop_obj) if isinstance(drop_obj, bool) else False
        return (include or ["*"]), exclude, drop

    async def set_scope(
        self, *, include: list[str], exclude: list[str], drop: bool
    ) -> None:
        db = self._conn()
        payload = json.dumps(
            {"include": include, "exclude": exclude, "drop": drop},
            ensure_ascii=False,
        )
        await db.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            ("scope", payload),
        )
        await db.commit()

    async def clear_flows(self) -> None:
        db = self._conn()
        await db.execute("DELETE FROM flows")
        await db.commit()

    async def match_flow_ids(self, *, where: str, ids: list[str]) -> list[str]:
        if not ids:
            return []

        db = self._conn()
        await _validate_where(db, where)

        placeholders = ",".join("?" for _ in ids)
        sql = f"SELECT id FROM flows WHERE id IN ({placeholders}) AND ({where})"  # noqa: S608

        cur = await db.execute(sql, ids)
        rows = await cur.fetchall()
        await cur.close()

        return [str(row[0]) for row in rows]

    async def get_resp_body(self, flow_id: str) -> tuple[str, str | None, int] | None:
        db = self._conn()
        cur = await db.execute(
            """
            SELECT resp_body_b64, resp_headers_json, resp_size
            FROM flows
            WHERE id = ?
            """,
            (flow_id,),
        )
        row = await cur.fetchone()
        await cur.close()
        if row is None:
            return None

        resp_body_b64 = row[0]
        if not isinstance(resp_body_b64, str) or resp_body_b64 == "":
            return None

        headers = _decode_headers_json(row[1])
        content_type = _header_value(headers, "content-type")
        size = int(row[2] or 0)

        return resp_body_b64, content_type, size

    async def get_flow(self, flow_id: str) -> FlowCompact | None:
        db = self._conn()
        cur = await db.execute(
            """
            SELECT id, ts, method, url, host, path, status, duration,
                   req_headers_json, resp_headers_json,
                   req_size, resp_size, req_body_b64,
                   req_preview, resp_preview
            FROM flows
            WHERE id = ?
            """,
            (flow_id,),
        )
        row = await cur.fetchone()
        await cur.close()
        if row is None:
            return None

        return FlowCompact(
            id=row[0],
            ts=row[1],
            method=row[2],
            url=row[3],
            host=row[4],
            path=row[5],
            status=row[6],
            duration=row[7],
            req_headers=_decode_headers_json(row[8]),
            resp_headers=_decode_headers_json(row[9]),
            req_size=row[10],
            resp_size=row[11],
            req_body_b64=row[12],
            req_preview=row[13],
            resp_preview=row[14],
        )


def _format_start_at(ts: object) -> str:
    if not isinstance(ts, int | float):
        return "—"

    dt = datetime.fromtimestamp(float(ts), tz=UTC).astimezone()
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _order_by_sql(sort_key: str | None, order: str | None) -> str:
    direction = "ASC" if order == "asc" else "DESC"

    column_map: dict[str, str] = {
        "url": "url",
        "method": "method",
        "size": "resp_size",
    }

    if sort_key == "num":
        return f"ORDER BY rowid {direction}"

    if sort_key in column_map:
        col = column_map[sort_key]
        return f"ORDER BY {col} {direction}, ts DESC"

    if sort_key == "status":
        return f"ORDER BY status IS NULL ASC, status {direction}, ts DESC"

    if sort_key == "time":
        return f"ORDER BY duration IS NULL ASC, duration {direction}, ts DESC"

    if sort_key == "start":
        return f"ORDER BY ts {direction}"

    return "ORDER BY ts DESC"


WHERE_SEMICOLON_ERROR = "Semicolons are not allowed in WHERE"


async def _validate_where(db: aiosqlite.Connection, where: str) -> None:
    # Prevent multi-statements and ensure expression compiles.
    if ";" in where:
        raise InvalidWhereError(WHERE_SEMICOLON_ERROR)

    try:
        cur = await db.execute(
            f"SELECT 1 FROM flows WHERE ({where}) LIMIT 1"  # noqa: S608
        )
        await cur.close()
    except Exception as e:
        raise InvalidWhereError(str(e)) from e


async def _ensure_setting(db: aiosqlite.Connection, *, key: str, value: str) -> None:
    cur = await db.execute("SELECT 1 FROM settings WHERE key = ?", (key,))
    row = await cur.fetchone()
    await cur.close()
    if row is not None:
        return

    await db.execute("INSERT INTO settings(key, value) VALUES (?, ?)", (key, value))
    await db.commit()


async def _ensure_column(
    db: aiosqlite.Connection, *, table: str, column: str, ddl: str
) -> None:
    cur = await db.execute(f"PRAGMA table_info({table})")
    rows = await cur.fetchall()
    await cur.close()

    existing = {row[1] for row in rows}
    if column in existing:
        return

    await db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
    await db.commit()


def _header_value(headers: list[tuple[str, str]], name: str) -> str | None:
    needle = name.lower()
    for key, value in headers:
        if key.lower() == needle:
            return value
    return None


HEADER_PAIR_LEN = 2


def _decode_headers_json(raw: str | None) -> list[tuple[str, str]]:
    if raw is None or raw == "":
        return []

    loaded: object = json.loads(raw)
    if not isinstance(loaded, list):
        return []

    out: list[tuple[str, str]] = []
    for item in loaded:
        if not isinstance(item, (list, tuple)) or len(item) != HEADER_PAIR_LEN:
            continue
        key, value = item[0], item[1]
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        out.append((key, value))
    return out
