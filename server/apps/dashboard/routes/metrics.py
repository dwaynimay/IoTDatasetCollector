# File: server/apps/dashboard/routes/metrics.py

import time
from fastapi import APIRouter

from apps.dashboard.hub import hub, storage, server_stats

router = APIRouter(tags=["Overview"])


def _now_ms() -> int:
    return int(time.time() * 1000)


@router.get(
    "/api/metrics",
    summary="Metrik server keseluruhan",
)
async def get_metrics():
    """
    Statistik throughput sejak server start.
    Diupdate real-time dari mqtt worker.
    """
    uptime_s = (_now_ms() - server_stats.get("start_time_ms", _now_ms())) / 1000

    return {
        "uptime_s":            round(uptime_s, 1),
        "total_samples":       server_stats.get("total_samples", 0),
        "ws_stream_clients":   hub.stream_count,
        "ws_event_clients":    hub.event_count,
    }


@router.get(
    "/api/db",
    summary="Info database SQLite",
)
async def get_db_info():
    """Ukuran file DB, jumlah baris per tabel, dan konfigurasi retention."""
    size_bytes   = storage.db_size_bytes()
    
    # Handle missing table errors gracefully if not initialized
    try:
        row_samples  = storage._conn.execute("SELECT COUNT(*) FROM samples").fetchone()[0]
    except Exception:
        row_samples = 0
        
    try:
        row_events   = storage._conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    except Exception:
        row_events = 0

    return {
        "path":            str(storage._path.resolve()),
        "size_bytes":      size_bytes,
        "size_kb":         round(size_bytes / 1024, 1),
        "rows_samples":    row_samples,
        "rows_events":     row_events,
        "retention_hours": storage._retention_hours,
    }
