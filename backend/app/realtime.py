"""Live WebSocket connections, grouped by room.

The hub lives in process memory, which matches the blueprint's single-instance MVP. Running
several app instances would need a shared pub/sub layer so broadcasts reach every instance.
"""

import asyncio
import contextlib
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from fastapi import WebSocket

from app.models import utcnow

logger = logging.getLogger("coderoom.realtime")

# Close codes sent to clients. 4000-4999 are reserved for applications.
CLOSE_LEFT = 1000
CLOSE_SEND_FAILED = 1011
CLOSE_BAD_REQUEST = 4400
CLOSE_UNAUTHORIZED = 4401
CLOSE_REMOVED = 4403
CLOSE_AUTH_TIMEOUT = 4408
CLOSE_ROOM_EXPIRED = 4410
CLOSE_TOO_MANY_CONNECTIONS = 4429

# A client that can't take an event within this time is dropped rather than stalling the room.
_SEND_TIMEOUT_SECONDS = 5


def event(event_type: str, **data: Any) -> dict[str, Any]:
    return {"type": event_type, **data}


@dataclass(eq=False)
class Connection:
    websocket: WebSocket
    room_id: uuid.UUID
    participant_id: uuid.UUID


class RoomHub:
    def __init__(
        self,
        empty_grace_seconds: float = 120,
        on_empty: Callable[[uuid.UUID], Awaitable[Any]] | None = None,
    ) -> None:
        self._rooms: dict[uuid.UUID, set[Connection]] = {}
        self._expiry_tasks: dict[uuid.UUID, asyncio.Task[None]] = {}
        # A room nobody is connected to is handed to on_empty once it has stayed empty this long.
        # The wait covers a refresh, a dropped signal or a phone switching apps.
        self._empty_grace_seconds = empty_grace_seconds
        self._on_empty = on_empty
        self._empty_tasks: dict[uuid.UUID, asyncio.Task[None]] = {}

    def online_participant_ids(self, room_id: uuid.UUID) -> set[uuid.UUID]:
        return {conn.participant_id for conn in self._rooms.get(room_id, ())}

    def connection_count(self, room_id: uuid.UUID, participant_id: uuid.UUID) -> int:
        return sum(1 for conn in self._rooms.get(room_id, ()) if conn.participant_id == participant_id)

    def connect(self, conn: Connection, expires_at: datetime) -> bool:
        """Register a connection. Returns True if its participant just came online."""
        came_online = conn.participant_id not in self.online_participant_ids(conn.room_id)
        self._rooms.setdefault(conn.room_id, set()).add(conn)
        self._cancel(self._empty_tasks, conn.room_id)
        if conn.room_id not in self._expiry_tasks:
            self._expiry_tasks[conn.room_id] = asyncio.create_task(self._close_when_expired(conn.room_id, expires_at))
        return came_online

    def disconnect(self, conn: Connection) -> bool:
        """Unregister a connection. Returns True if its participant just went offline."""
        conns = self._rooms.get(conn.room_id)
        if conns is None or conn not in conns:
            return False
        conns.discard(conn)
        if not conns:
            del self._rooms[conn.room_id]
            self._cancel(self._expiry_tasks, conn.room_id)
            self.watch_empty(conn.room_id)
        return conn.participant_id not in self.online_participant_ids(conn.room_id)

    def watch_empty(self, room_id: uuid.UUID) -> None:
        """Close the room if nobody connects to it within the grace period. Called when a room is
        opened, when its last connection drops, and on someone joining, which restarts the wait so
        they have the full time to connect."""
        self._cancel(self._empty_tasks, room_id)
        if self._on_empty is not None and not self._rooms.get(room_id):
            self._empty_tasks[room_id] = asyncio.create_task(self._close_when_empty(room_id))

    def forget(self, room_id: uuid.UUID) -> None:
        """Stop the room's timers, once it has been closed some other way."""
        self._cancel(self._expiry_tasks, room_id)
        self._cancel(self._empty_tasks, room_id)

    def reschedule(self, room_id: uuid.UUID, expires_at: datetime) -> None:
        """Move the room's closing time, e.g. after the host extends it."""
        self._cancel(self._expiry_tasks, room_id)
        if self._rooms.get(room_id):
            self._expiry_tasks[room_id] = asyncio.create_task(self._close_when_expired(room_id, expires_at))

    async def broadcast(self, room_id: uuid.UUID, message: dict[str, Any], exclude: Connection | None = None) -> None:
        targets = [conn for conn in self._rooms.get(room_id, ()) if conn is not exclude]
        await asyncio.gather(*(self._send(conn, message) for conn in targets))

    async def close_participant(self, room_id: uuid.UUID, participant_id: uuid.UUID, code: int, reason: str) -> None:
        targets = [conn for conn in self._rooms.get(room_id, ()) if conn.participant_id == participant_id]
        await asyncio.gather(*(self.close(conn, code, reason) for conn in targets))

    async def close(self, conn: Connection, code: int, reason: str) -> None:
        """Close from the server side. The connection is unregistered at once rather than when
        the client finishes the close handshake, which a slow or broken client may never do."""
        self.disconnect(conn)
        with contextlib.suppress(Exception):
            await conn.websocket.close(code=code, reason=reason)

    async def shutdown(self) -> None:
        for tasks in (self._expiry_tasks, self._empty_tasks):
            for task in tasks.values():
                task.cancel()
            tasks.clear()

    @staticmethod
    def _cancel(tasks: dict[uuid.UUID, asyncio.Task[None]], room_id: uuid.UUID) -> None:
        task = tasks.pop(room_id, None)
        if task is not None:
            task.cancel()

    async def _close_when_empty(self, room_id: uuid.UUID) -> None:
        await asyncio.sleep(self._empty_grace_seconds)
        # Drop our own entry first so nothing cancels this task while the room is being closed.
        self._empty_tasks.pop(room_id, None)
        self._cancel(self._expiry_tasks, room_id)
        try:
            await self._on_empty(room_id)
        except Exception:
            logger.exception("Could not close empty room %s", room_id)
            return
        # Anyone who connected while it was closing is told it has gone.
        targets = list(self._rooms.get(room_id, ()))
        await asyncio.gather(*(self._send(conn, event("room.expired")) for conn in targets))
        await asyncio.gather(*(self.close(conn, CLOSE_ROOM_EXPIRED, "Room expired") for conn in targets))
        self.forget(room_id)

    async def _close_when_expired(self, room_id: uuid.UUID, expires_at: datetime) -> None:
        await asyncio.sleep(max((expires_at - utcnow()).total_seconds(), 0))
        # Drop our own entry first so disconnects triggered below don't cancel this task mid-close.
        self._expiry_tasks.pop(room_id, None)
        targets = list(self._rooms.get(room_id, ()))
        await asyncio.gather(*(self._send(conn, event("room.expired")) for conn in targets))
        await asyncio.gather(*(self.close(conn, CLOSE_ROOM_EXPIRED, "Room expired") for conn in targets))

    async def _send(self, conn: Connection, message: dict[str, Any]) -> None:
        try:
            await asyncio.wait_for(conn.websocket.send_json(message), _SEND_TIMEOUT_SECONDS)
        except Exception:
            went_offline = conn.participant_id not in self._other_participant_ids(conn)
            in_room = conn in self._rooms.get(conn.room_id, ())
            await self.close(conn, CLOSE_SEND_FAILED, "Send failed")
            if in_room and went_offline:
                # Safe to recurse: this connection is already unregistered, so it won't be retried.
                await self.broadcast(conn.room_id, presence(conn.participant_id, online=False))

    def _other_participant_ids(self, conn: Connection) -> set[uuid.UUID]:
        return {other.participant_id for other in self._rooms.get(conn.room_id, ()) if other is not conn}


def presence(participant_id: uuid.UUID, online: bool) -> dict[str, Any]:
    return event("presence", participant_id=str(participant_id), online=online)
