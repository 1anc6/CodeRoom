"""Live WebSocket connections, grouped by room.

The hub lives in process memory, which matches the blueprint's single-instance MVP. Running
several app instances would need a shared pub/sub layer so broadcasts reach every instance.
"""

import asyncio
import contextlib
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from fastapi import WebSocket

from app.models import utcnow

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
    def __init__(self) -> None:
        self._rooms: dict[uuid.UUID, set[Connection]] = {}
        self._expiry_tasks: dict[uuid.UUID, asyncio.Task[None]] = {}

    def online_participant_ids(self, room_id: uuid.UUID) -> set[uuid.UUID]:
        return {conn.participant_id for conn in self._rooms.get(room_id, ())}

    def connection_count(self, room_id: uuid.UUID, participant_id: uuid.UUID) -> int:
        return sum(1 for conn in self._rooms.get(room_id, ()) if conn.participant_id == participant_id)

    def connect(self, conn: Connection, expires_at: datetime) -> bool:
        """Register a connection. Returns True if its participant just came online."""
        came_online = conn.participant_id not in self.online_participant_ids(conn.room_id)
        self._rooms.setdefault(conn.room_id, set()).add(conn)
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
            task = self._expiry_tasks.pop(conn.room_id, None)
            if task is not None:
                task.cancel()
        return conn.participant_id not in self.online_participant_ids(conn.room_id)

    def reschedule(self, room_id: uuid.UUID, expires_at: datetime) -> None:
        """Move the room's closing time, e.g. after the host extends it."""
        task = self._expiry_tasks.pop(room_id, None)
        if task is not None:
            task.cancel()
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
        for task in self._expiry_tasks.values():
            task.cancel()
        self._expiry_tasks.clear()

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
