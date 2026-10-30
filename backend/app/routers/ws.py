"""Real-time room connection. The protocol is described in the README.

Clients authenticate with their session token in the first frame rather than the URL, so the
token never shows up in server or proxy logs.
"""

import asyncio
import json
import uuid
from typing import Any

import anyio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import joinedload

from app.config import Settings
from app.deps import find_participant, room_is_closed
from app.messages import current_members, message_out
from app.models import Message, Participant, utcnow
from app.realtime import (
    CLOSE_AUTH_TIMEOUT,
    CLOSE_BAD_REQUEST,
    CLOSE_ROOM_EXPIRED,
    CLOSE_TOO_MANY_CONNECTIONS,
    CLOSE_UNAUTHORIZED,
    Connection,
    RoomHub,
    event,
    presence,
)
from app.schemas import ParticipantOut

router = APIRouter()

_MAX_CLIENT_ID_LENGTH = 64
_CLEANUP_TIMEOUT_SECONDS = 5


class _Closed(Exception):
    """The connection has been closed by the server and its loop should stop."""


def _settings(websocket: WebSocket) -> Settings:
    return websocket.app.state.settings


def _hub(websocket: WebSocket) -> RoomHub:
    return websocket.app.state.hub


async def _send_error(websocket: WebSocket, code: str, detail: str, client_id: str | None = None) -> None:
    await websocket.send_json(event("error", code=code, detail=detail, client_id=client_id))


async def _authenticate(websocket: WebSocket, room_id: uuid.UUID) -> Participant | None:
    """Wait for {"type": "auth", "token": ...}. Closes the socket and returns None on failure."""
    try:
        frame = await asyncio.wait_for(websocket.receive_json(), _settings(websocket).ws_auth_timeout_seconds)
    except TimeoutError:
        await websocket.close(CLOSE_AUTH_TIMEOUT, "Authentication timed out")
        return None
    except WebSocketDisconnect:
        return None
    except (ValueError, KeyError):  # not JSON, or not a text frame
        await websocket.close(CLOSE_BAD_REQUEST, "Expected an auth frame")
        return None

    token = frame.get("token") if isinstance(frame, dict) and frame.get("type") == "auth" else None
    if not isinstance(token, str):
        await websocket.close(CLOSE_BAD_REQUEST, "Expected an auth frame")
        return None

    async with websocket.app.state.sessionmaker() as session:
        participant = await find_participant(session, room_id, token)
        if participant is None:
            if await room_is_closed(session, room_id):
                await websocket.close(CLOSE_ROOM_EXPIRED, "Room expired")
            else:
                await websocket.close(CLOSE_UNAUTHORIZED, "Invalid room session")
            return None
        now = utcnow()
        if not participant.room.is_open(now):
            await websocket.close(CLOSE_ROOM_EXPIRED, "Room expired")
            return None
        participant.last_seen_at = now
        await session.commit()
    return participant


async def _touch_last_seen(websocket: WebSocket, participant_id: uuid.UUID) -> None:
    async with websocket.app.state.sessionmaker() as session:
        participant = await session.get(Participant, participant_id)
        if participant is not None:
            participant.last_seen_at = utcnow()
            await session.commit()


async def _handle_message_send(websocket: WebSocket, conn: Connection, frame: dict[str, Any]) -> None:
    settings = _settings(websocket)
    client_id = frame.get("client_id")
    if not (isinstance(client_id, str) and len(client_id) <= _MAX_CLIENT_ID_LENGTH):
        client_id = None

    content = frame.get("content")
    if not isinstance(content, str) or not content.strip():
        await _send_error(websocket, "invalid_message", "Message must be non-empty text", client_id)
        return
    if len(content) > settings.max_message_length:
        await _send_error(
            websocket, "message_too_long", f"Messages are limited to {settings.max_message_length} characters", client_id
        )
        return
    if "\x00" in content:
        await _send_error(websocket, "invalid_message", "Message contains a null character", client_id)
        return

    limiter = websocket.app.state.message_rate
    rate_key = str(conn.participant_id)
    if limiter.is_limited(rate_key):
        await _send_error(websocket, "rate_limited", "You're sending messages too quickly", client_id)
        return
    limiter.hit(rate_key)

    async with websocket.app.state.sessionmaker() as session:
        participant = await session.get(Participant, conn.participant_id, options=[joinedload(Participant.room)])
        now = utcnow()
        # Re-check access on every message: the participant may have left or the room expired.
        # A missing participant means the room was already cleaned up, which deletes them.
        if participant is not None and participant.left_at is not None:
            await websocket.close(CLOSE_UNAUTHORIZED, "Invalid room session")
            raise _Closed
        if participant is None or not participant.room.is_open(now):
            await websocket.send_json(event("room.expired"))
            await websocket.close(CLOSE_ROOM_EXPIRED, "Room expired")
            raise _Closed

        message = Message(room_id=conn.room_id, participant=participant, content=content, created_at=now)
        participant.room.last_activity_at = now
        session.add(message)
        await session.commit()
        payload = message_out(message).model_dump(mode="json")

    # Broadcast only after the message is safely stored.
    await _hub(websocket).broadcast(conn.room_id, event("message.new", message=payload, client_id=client_id))


async def _handle_frame(websocket: WebSocket, conn: Connection, raw: str) -> None:
    # Allow for JSON escaping of a maximum-length message, plus the envelope.
    if len(raw) > _settings(websocket).max_message_length * 6 + 1024:
        await _send_error(websocket, "frame_too_large", "Frame is too large")
        return
    try:
        frame = json.loads(raw)
    except ValueError:
        await _send_error(websocket, "invalid_json", "Frames must be JSON objects")
        return
    if not isinstance(frame, dict):
        await _send_error(websocket, "invalid_json", "Frames must be JSON objects")
        return

    match frame.get("type"):
        case "message.send":
            await _handle_message_send(websocket, conn, frame)
        case "ping":
            await websocket.send_json(event("pong"))
        case _:
            await _send_error(websocket, "unknown_type", "Unknown frame type")


@router.websocket("/api/rooms/{room_id}/ws")
async def room_socket(websocket: WebSocket, room_id: uuid.UUID) -> None:
    await websocket.accept()
    participant = await _authenticate(websocket, room_id)
    if participant is None:
        return

    hub = _hub(websocket)
    if hub.connection_count(room_id, participant.id) >= _settings(websocket).max_connections_per_participant:
        await websocket.close(CLOSE_TOO_MANY_CONNECTIONS, "Too many open connections")
        return

    conn = Connection(websocket=websocket, room_id=room_id, participant_id=participant.id)
    came_online = hub.connect(conn, participant.room.expires_at)
    try:
        async with websocket.app.state.sessionmaker() as session:
            members = await current_members(session, hub, room_id)
        await websocket.send_json(
            event(
                "ready",
                me=ParticipantOut.model_validate(participant).model_dump(mode="json"),
                participants=[m.model_dump(mode="json") for m in members],
            )
        )
        if came_online:
            await hub.broadcast(room_id, presence(participant.id, online=True), exclude=conn)

        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("text") is None:
                await _send_error(websocket, "unsupported_frame", "Only text frames are supported")
                continue
            await _handle_frame(websocket, conn, message["text"])
    except (_Closed, WebSocketDisconnect, OSError):
        # OSError covers the client vanishing mid-send.
        pass
    except RuntimeError:
        # Raised by Starlette when using the socket after the server already closed it
        # (for example the room expired or the participant left from another tab).
        pass
    finally:
        # Shielded so the room still hears about the disconnect when this task is being
        # cancelled (e.g. server shutdown), and time-boxed so cleanup can't stall shutdown.
        with anyio.move_on_after(_CLEANUP_TIMEOUT_SECONDS, shield=True):
            # Returns False if the server already closed and unregistered this connection
            # (leave or expiry), in which case the room has been told some other way.
            if hub.disconnect(conn):
                await hub.broadcast(room_id, presence(participant.id, online=False))
            await _touch_last_seen(websocket, participant.id)
