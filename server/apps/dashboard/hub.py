# File: server/apps/dashboard/hub.py

import asyncio
import time
from typing import Optional
from fastapi import WebSocket
from core.storage import StorageManager
from core.config import DB_PATH, RETENTION_HOURS


class BroadcastHub:
    def __init__(self) -> None:
        self._stream_clients: list[WebSocket] = []
        self._event_clients: list[WebSocket]  = []
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect_stream(self, ws: WebSocket) -> None:
        await ws.accept()
        self._stream_clients.append(ws)

    def disconnect_stream(self, ws: WebSocket) -> None:
        if ws in self._stream_clients:
            self._stream_clients = [c for c in self._stream_clients if c is not ws]

    async def connect_event(self, ws: WebSocket) -> None:
        await ws.accept()
        self._event_clients.append(ws)

    def disconnect_event(self, ws: WebSocket) -> None:
        if ws in self._event_clients:
            self._event_clients  = [c for c in self._event_clients  if c is not ws]

    async def _broadcast(self, clients: list[WebSocket], data: dict) -> None:
        dead: list[WebSocket] = []
        for ws in list(clients):
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
                
        if dead:
            for ws in dead:
                self._stream_clients = [c for c in self._stream_clients if c not in dead]
                self._event_clients  = [c for c in self._event_clients  if c not in dead]

    async def publish_sample(self, data: dict) -> None:
        await self._broadcast(self._stream_clients, data)

    async def publish_event(self, data: dict) -> None:
        await self._broadcast(self._event_clients, data)

    def publish_sample_threadsafe(self, data: dict) -> None:
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self.publish_sample(data), self._loop)

    def publish_event_threadsafe(self, data: dict) -> None:
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self.publish_event(data), self._loop)

    @property
    def stream_count(self) -> int:
        return len(self._stream_clients)

    @property
    def event_count(self) -> int:
        return len(self._event_clients)


# Module-level singletons
hub = BroadcastHub()
storage = StorageManager(db_path=DB_PATH, retention_hours=RETENTION_HOURS)

server_stats: dict = {
    "start_time_ms":    int(time.time() * 1000),
    "total_samples":    0,
}
