# File: server/core/storage.py

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_DB_PATH      = Path("data/health_monitor.db")
DEFAULT_RETENTION_H  = 24


class StorageManager:
    def __init__(
        self,
        db_path: str                  = str(DEFAULT_DB_PATH),
        retention_hours: int          = DEFAULT_RETENTION_H,
    ) -> None:
        self._path           = Path(db_path)
        self._retention_hours = retention_hours
        self._conn: Optional[sqlite3.Connection] = None
        self._lock           = threading.Lock()

    def open(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            str(self._path),
            check_same_thread = False,
        )
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._create_tables()
        logger.info("DB: %s | retention=%dh",
                    self._path.resolve(), self._retention_hours)

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    def _ensure_open(self) -> None:
        if not self._conn:
            raise RuntimeError("Database tidak terbuka. Panggil open() dulu.")

    def insert_sample(
        self,
        node_id:   int,
        signal:    str,
        timestamp: int,
        value:     float,
    ) -> None:
        self._ensure_open()

        with self._lock:
            self._conn.execute(
                """
                INSERT INTO samples (node_id, ts_sensor_ms, ts_server_ms, signal, value)
                VALUES (?, ?, ?, ?, ?)
                """,
                (node_id, timestamp, int(time.time() * 1000), signal, value),
            )
            self._conn.commit()

    def insert_samples_batch(
        self,
        node_id:   int,
        timestamp: int,
        signals:   dict[str, float],
    ) -> None:
        """Insert semua sinyal dalam 1 transaksi — 1 lock, 1 commit."""
        self._ensure_open()
        ts_server = int(time.time() * 1000)
        rows = [
            (node_id, timestamp, ts_server, sig, val)
            for sig, val in signals.items()
        ]
        with self._lock:
            self._conn.executemany(
                "INSERT INTO samples (node_id, ts_sensor_ms, ts_server_ms, signal, value)"
                " VALUES (?, ?, ?, ?, ?)",
                rows,
            )
            self._conn.commit()

    def log_event(
        self,
        node_id:    int,
        event_type: str,
        detail:     str = "",
    ) -> None:
        self._ensure_open()

        with self._lock:
            self._conn.execute(
                """
                INSERT INTO events (node_id, ts_server_ms, event_type, detail)
                VALUES (?, ?, ?, ?)
                """,
                (node_id, int(time.time() * 1000), event_type, detail),
            )
            self._conn.commit()

    def get_last_events(
        self,
        node_id:    Optional[int] = None,
        event_type: Optional[str] = None,
        n:          int = 20,
    ) -> list[dict]:
        self._ensure_open()

        query  = "SELECT node_id, ts_server_ms, event_type, detail FROM events"
        params = []
        conds  = []

        if node_id is not None:
            conds.append("node_id = ?")
            params.append(node_id)
        if event_type is not None:
            conds.append("event_type = ?")
            params.append(event_type)

        if conds:
            query += " WHERE " + " AND ".join(conds)

        query += " ORDER BY id DESC LIMIT ?"
        params.append(n)

        rows = self._conn.execute(query, tuple(params)).fetchall()
        return [
            {
                "node_id":      r[0],
                "ts_server_ms": r[1],
                "event_type":   r[2],
                "detail":       r[3],
            }
            for r in reversed(rows)
        ]

    def get_node_stats(self, node_id: int) -> dict:
        self._ensure_open()

        row = self._conn.execute(
            """
            SELECT
                COUNT(*)          AS total_samples,
                MAX(ts_server_ms) AS last_seen
            FROM samples
            WHERE node_id = ?
            """,
            (node_id,),
        ).fetchone()

        return {
            "node_id":          node_id,
            "total_samples":    row[0] or 0,
            "last_seen_ms":     row[1] or 0,
        }

    def get_last_samples(self, node_id: int, n: int = 200) -> dict:
        self._ensure_open()

        signals = self._conn.execute(
            "SELECT DISTINCT signal FROM samples WHERE node_id = ?",
            (node_id,)
        ).fetchall()
        
        result = {}
        for (sig,) in signals:
            rows = self._conn.execute(
                """
                SELECT value FROM samples
                WHERE node_id = ? AND signal = ?
                ORDER BY ts_sensor_ms DESC
                LIMIT ?
                """,
                (node_id, sig, n)
            ).fetchall()
            
            result[sig] = [r[0] for r in reversed(rows)]
            
        return result

    def get_all_node_ids(self) -> list[int]:
        self._ensure_open()
        rows = self._conn.execute(
            "SELECT DISTINCT node_id FROM samples ORDER BY node_id"
        ).fetchall()
        return [r[0] for r in rows]

    def purge_old(self, max_age_hours: Optional[int] = None) -> int:
        self._ensure_open()

        age_h     = max_age_hours if max_age_hours is not None else self._retention_hours
        cutoff_ms = int(time.time() * 1000) - (age_h * 3600 * 1000)

        with self._lock:
            cur_s = self._conn.execute(
                "DELETE FROM samples WHERE ts_server_ms < ?", (cutoff_ms,)
            )
            cur_e = self._conn.execute(
                "DELETE FROM events  WHERE ts_server_ms < ?", (cutoff_ms,)
            )
            self._conn.commit()

        deleted = cur_s.rowcount + cur_e.rowcount
        if deleted > 0:
            logger.info("Purge: %d baris dihapus (>%dh)", deleted, age_h)
        return deleted

    def db_size_bytes(self) -> int:
        return self._path.stat().st_size if self._path.exists() else 0

    def _create_tables(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id       INTEGER NOT NULL,
                ts_server_ms  INTEGER NOT NULL,
                event_type    TEXT    NOT NULL,
                detail        TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_events_node
                ON events (node_id, ts_server_ms DESC);
                
            CREATE TABLE IF NOT EXISTS samples (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id       INTEGER NOT NULL,
                ts_sensor_ms  INTEGER NOT NULL,
                ts_server_ms  INTEGER NOT NULL,
                signal        TEXT    NOT NULL,
                value         REAL    NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_samples_node_signal
                ON samples (node_id, signal, ts_sensor_ms DESC);

            CREATE INDEX IF NOT EXISTS idx_samples_server_ts
                ON samples (ts_server_ms);
            """
        )
        self._conn.commit()
