from __future__ import annotations

"""
main_app.py — Dataset Collector Server: FastAPI + MQTT raw data pipeline.

Arsitektur:
    python -m server
        └── uvicorn (main thread / asyncio)
                ├── lifespan startup
                │       ├── storage.open()
                │       ├── hub.set_loop(asyncio event loop)
                │       └── Thread(target=_run_mqtt_thread).start()
                │
                ├── FastAPI routes (REST API + WebSocket)
                │       sama persis dengan apps/dashboard/app.py
                │
                └── [background] mqtt-worker thread
                        ├── subscribe topic health_monitor/+/+/raw
                        └── per pesan masuk:
                                parse JSON → validasi minimal →
                                simpan DB → hub.publish_sample_threadsafe()

Thread safety:
    StorageManager  → threading.Lock internal di storage.py
    _nodes dict     → threading.Lock di sini
    WebSocket push  → asyncio.run_coroutine_threadsafe via hub
"""

import json
import logging
import threading
from contextlib import asynccontextmanager

import asyncio
import uvicorn
from fastapi import FastAPI

try:
    import paho.mqtt.client as mqtt
    from paho.mqtt.enums import CallbackAPIVersion
    _PAHO_V2 = True
except ImportError:
    import paho.mqtt.client as mqtt  # type: ignore
    _PAHO_V2 = False

from core import (
    MQTT_BROKER, MQTT_PORT, MQTT_KEEPALIVE,
    TOPIC_BASE, DB_PATH, RETENTION_HOURS,
    SIGNALS,
)
from core.logger import setup_logging

from apps.dashboard.app import app as _dashboard_app
from apps.dashboard.hub import hub, storage, server_stats

logger = logging.getLogger(__name__)

# ── Shared state ──────────────────────────────────────────────────────────────

_nodes_lock: threading.Lock = threading.Lock()
_node_last_ts: dict[int, int] = {}


# ── MQTT worker thread ────────────────────────────────────────────────────────

def _on_connect(client, userdata, flags, rc, properties=None) -> None:
    rc_val = rc if isinstance(rc, int) else rc.value
    if rc_val == 0:
        topic = f"{TOPIC_BASE}/+/raw"
        client.subscribe(topic)
        logger.info("MQTT terhubung | subscribe: %s", topic)
    else:
        logger.error("MQTT gagal konek rc=%d", rc_val)


def _on_message(client, userdata, message) -> None:
    """
    Terima JSON raw dari firmware, simpan ke DB, push ke WebSocket.

    Payload JSON dari firmware (main.cpp):
      {"node":1,"ts":123456,"ax":0.12,"ay":-0.05,"az":9.81,
       "gx":0.01,"gy":-0.02,"gz":0.00,"ir":45231,"red":30100}
    """
    try:
        payload: dict = json.loads(message.payload.decode())
    except Exception as exc:
        logger.error("JSON parse error pada topic %s: %s", message.topic, exc)
        return

    # ── Parse node_id dari topic: health_monitor/node_<ID>/raw ───────────────
    parts = message.topic.split("/")
    try:
        node_id = int(parts[1].split("_")[1])
    except (IndexError, ValueError):
        logger.warning("Format topic tidak dikenal: %s", message.topic)
        return

    # ── Validasi field wajib ──────────────────────────────────────────────────
    required = {"ts", "ax", "ay", "az", "gx", "gy", "gz", "ir"}
    if not required.issubset(payload.keys()):
        missing = required - payload.keys()
        logger.warning("Node %d: field hilang %s", node_id, missing)
        return

    ts = int(payload.get("ts", 0))

    # ── Cek timestamp monotonicity ────────────────────────────────────────────
    with _nodes_lock:
        last_ts = _node_last_ts.get(node_id, 0)
        if 0 < ts < last_ts - 5000:
            # Timestamp mundur jauh → kemungkinan reboot ESP32
            logger.info(
                "Node %d: timestamp reset (reboot?), %d → %d",
                node_id, last_ts, ts,
            )
        _node_last_ts[node_id] = ts

    # ── Simpan ke SQLite (1 transaksi untuk semua sinyal) ─────────────────────
    try:
        signals_to_insert = {
            sig: float(payload[sig]) for sig in SIGNALS if sig in payload
        }
        storage.insert_samples_batch(
            node_id   = node_id,
            timestamp = ts,
            signals   = signals_to_insert,
        )
    except Exception as exc:
        logger.error("DB insert error node %d: %s", node_id, exc)
        return

    server_stats["total_samples"] += 1

    # ── Push ke WebSocket dashboard ───────────────────────────────────────────
    ws_data = {
        "node_id": node_id,
        "ts":      ts,
        "signals": {sig: payload[sig] for sig in SIGNALS if sig in payload},
    }
    hub.publish_sample_threadsafe(ws_data)


def _run_mqtt_thread() -> None:
    """Blocking MQTT loop — dijalankan di background thread."""
    logger.info("MQTT worker thread started | broker=%s:%d", MQTT_BROKER, MQTT_PORT)
    try:
        if _PAHO_V2:
            client = mqtt.Client(callback_api_version=CallbackAPIVersion.VERSION2)
        else:
            client = mqtt.Client()

        # Naikkan buffer internal paho agar tidak drop message besar
        client.max_queued_messages_set(100)

        client.on_connect = _on_connect
        client.on_message = _on_message

        client.connect(MQTT_BROKER, MQTT_PORT, keepalive=MQTT_KEEPALIVE)
        client.loop_forever(retry_first_connection=True)
    except Exception as exc:
        logger.critical("MQTT worker crashed: %s", exc, exc_info=True)


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def _combined_lifespan(app: FastAPI):
    """Startup: buka storage, set loop, start MQTT thread."""
    storage.open()
    hub.set_loop(asyncio.get_running_loop())

    mqtt_thread = threading.Thread(
        target = _run_mqtt_thread,
        name   = "mqtt-worker",
        daemon = True,
    )
    mqtt_thread.start()

    print("=" * 60)
    print("  IoT Dataset Collector — Server")
    print(f"  MQTT   : {MQTT_BROKER}:{MQTT_PORT}")
    print(f"  Topic  : {TOPIC_BASE}/+/raw")
    print(f"  DB     : {DB_PATH} (retention={RETENTION_HOURS}h)")
    print(f"  API    : http://0.0.0.0:8000/docs")
    print(f"  WS     : ws://0.0.0.0:8000/ws/stream")
    print("=" * 60)

    yield

    storage.close()
    logger.info("Storage ditutup.")


# ── Buat app dengan lifespan override ────────────────────────────────────────

app = FastAPI(
    title       = "IoT Dataset Collector",
    description = "Raw sensor data acquisition via MQTT — IMU & PPG",
    version     = "1.0.0",
    lifespan    = _combined_lifespan,
)

for middleware in _dashboard_app.user_middleware:
    app.add_middleware(middleware.cls, **middleware.kwargs)

for route in _dashboard_app.routes:
    app.routes.append(route)


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    setup_logging()
    uvicorn.run(
        app,
        host       = "0.0.0.0",
        port       = 8000,
        reload     = False,
        workers    = 1,
        log_config = None,
    )


if __name__ == "__main__":
    main()
