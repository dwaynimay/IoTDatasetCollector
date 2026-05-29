# File: server/apps/dashboard/routes/nodes.py

import time
from typing import Optional
from fastapi import APIRouter, HTTPException

from apps.dashboard.hub import storage

router = APIRouter(tags=["Node"])


def _now_ms() -> int:
    return int(time.time() * 1000)


def _ms_ago(ts_ms: int) -> Optional[float]:
    if not ts_ms:
        return None
    return round((_now_ms() - ts_ms) / 1000, 1)


def _node_or_404(node_id: int) -> None:
    if node_id not in storage.get_all_node_ids():
        raise HTTPException(status_code=404, detail=f"Node {node_id} tidak ditemukan")


@router.get(
    "/api/nodes/{node_id}",
    summary="Detail satu node",
)
async def get_node_detail(node_id: int):
    """
    Statistik ringkas node dan event terbaru.
    """
    _node_or_404(node_id)

    stats  = storage.get_node_stats(node_id)
    stats["last_seen_ago_s"] = _ms_ago(stats["last_seen_ms"])
    events = storage.get_last_events(node_id=node_id, n=10)

    return {
        "stats":         stats,
        "recent_events": events,
    }


@router.get(
    "/api/nodes/{node_id}/history",
    summary="Histori raw data untuk chart inisialisasi",
)
async def get_node_history(node_id: int):
    """
    Mengambil data sensor terakhir (misal 200 sampel) per sinyal,
    digunakan oleh dashboard untuk pre-fill grafik sesaat setelah load.
    """
    _node_or_404(node_id)
    # Default buffer size di frontend adalah 200, kita kirimkan sejumlah itu
    history = storage.get_last_samples(node_id, n=200)
    return history
