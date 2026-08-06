"""로컬 시계열 버퍼 — Phase 1.

SQLite store-and-forward. 네트워크 끊겨도 유실 0.
- readings: 원시 폴링 raw (시계열 전체).
- states: 도출된 상태/스코어 (시간순).
- egress_outbox: 정책상 밖으로 보낼 페이로드 큐 (airgap이면 비어 있음).

원시 raw는 절대 outbox로 옮기지 않는다 (egress.py에서 화이트리스트 필터링 후 enqueue).
"""
from __future__ import annotations
import json
import sqlite3
import time
from pathlib import Path
from typing import Any


_SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts        REAL NOT NULL,
  payload   TEXT NOT NULL              -- raw 폴링 결과 JSON (원시)
);
CREATE INDEX IF NOT EXISTS idx_readings_device_ts ON readings(device_id, ts);

CREATE TABLE IF NOT EXISTS states (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    TEXT NOT NULL,
  ts           REAL NOT NULL,
  status       TEXT NOT NULL,           -- ok | warn | critical | unreachable | nodata
  health_score INTEGER,
  alarmable    INTEGER NOT NULL DEFAULT 0,
  reasons      TEXT NOT NULL            -- JSON list[str]
);
CREATE INDEX IF NOT EXISTS idx_states_device_ts ON states(device_id, ts);

CREATE TABLE IF NOT EXISTS egress_outbox (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        REAL NOT NULL,
  policy    TEXT NOT NULL,              -- aggregate | federated
  kind      TEXT NOT NULL,              -- state | alarm | signature | benchmark
  payload   TEXT NOT NULL,              -- 화이트리스트 필터 통과 후 JSON
  attempts  INTEGER NOT NULL DEFAULT 0,
  acked_at  REAL
);
CREATE INDEX IF NOT EXISTS idx_outbox_unacked ON egress_outbox(acked_at) WHERE acked_at IS NULL;

CREATE TABLE IF NOT EXISTS retention_log (
  ts       REAL NOT NULL,
  purged   INTEGER NOT NULL
);
"""


class Buffer:
    """SQLite 기반 store-and-forward. 단일 프로세스 가정.

    경량 — busy_timeout 5s, WAL 모드로 동시성 부분 확보.
    """

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._cx = sqlite3.connect(str(self.path), timeout=5.0,
                                   detect_types=sqlite3.PARSE_DECLTYPES)
        self._cx.row_factory = sqlite3.Row
        self._cx.execute("PRAGMA journal_mode=WAL")
        self._cx.execute("PRAGMA synchronous=NORMAL")
        self._cx.executescript(_SCHEMA)
        self._cx.commit()

    # ── reading ─────────────────────────────────────────────────────
    def add_reading(self, device_id: str, payload: dict, ts: float | None = None) -> int:
        ts = float(ts if ts is not None else time.time())
        cur = self._cx.execute(
            "INSERT INTO readings(device_id, ts, payload) VALUES (?,?,?)",
            (device_id, ts, json.dumps(payload, ensure_ascii=False)),
        )
        self._cx.commit()
        return int(cur.lastrowid)

    def latest_reading(self, device_id: str) -> dict | None:
        r = self._cx.execute(
            "SELECT ts, payload FROM readings WHERE device_id=? ORDER BY ts DESC LIMIT 1",
            (device_id,),
        ).fetchone()
        if not r:
            return None
        p = json.loads(r["payload"])
        p["ts"] = r["ts"]
        return p

    # ── state ──────────────────────────────────────────────────────
    def add_state(self, device_id: str, status: str, *, health_score: int | None,
                  alarmable: bool, reasons: list[str], ts: float | None = None) -> int:
        ts = float(ts if ts is not None else time.time())
        cur = self._cx.execute(
            "INSERT INTO states(device_id, ts, status, health_score, alarmable, reasons) "
            "VALUES (?,?,?,?,?,?)",
            (device_id, ts, status, health_score, 1 if alarmable else 0,
             json.dumps(reasons, ensure_ascii=False)),
        )
        self._cx.commit()
        return int(cur.lastrowid)

    def latest_state(self, device_id: str) -> dict | None:
        r = self._cx.execute(
            "SELECT * FROM states WHERE device_id=? ORDER BY ts DESC LIMIT 1",
            (device_id,),
        ).fetchone()
        if not r:
            return None
        d = dict(r)
        d["reasons"] = json.loads(d["reasons"])
        d["alarmable"] = bool(d["alarmable"])
        return d

    # ── egress outbox (airgap이면 빈 채로 둠) ────────────────────────
    def enqueue_egress(self, *, policy: str, kind: str, payload: dict) -> int:
        cur = self._cx.execute(
            "INSERT INTO egress_outbox(ts, policy, kind, payload) VALUES (?,?,?,?)",
            (time.time(), policy, kind, json.dumps(payload, ensure_ascii=False)),
        )
        self._cx.commit()
        return int(cur.lastrowid)

    def dequeue_pending(self, limit: int = 100) -> list[dict]:
        rows = self._cx.execute(
            "SELECT * FROM egress_outbox WHERE acked_at IS NULL ORDER BY ts LIMIT ?",
            (limit,),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["payload"] = json.loads(d["payload"])
            out.append(d)
        return out

    def ack_egress(self, ids: list[int]) -> None:
        if not ids:
            return
        marks = ",".join("?" for _ in ids)
        self._cx.execute(
            f"UPDATE egress_outbox SET acked_at=? WHERE id IN ({marks})",
            (time.time(), *ids),
        )
        self._cx.commit()

    # ── retention ───────────────────────────────────────────────────
    def purge_old(self, days: int = 30) -> int:
        cutoff = time.time() - days * 86400
        cur = self._cx.execute("DELETE FROM readings WHERE ts < ?", (cutoff,))
        n1 = cur.rowcount
        cur = self._cx.execute("DELETE FROM states WHERE ts < ?", (cutoff,))
        n2 = cur.rowcount
        total = (n1 or 0) + (n2 or 0)
        self._cx.execute("INSERT INTO retention_log(ts, purged) VALUES (?,?)",
                         (time.time(), total))
        self._cx.commit()
        return total

    def close(self) -> None:
        self._cx.close()
