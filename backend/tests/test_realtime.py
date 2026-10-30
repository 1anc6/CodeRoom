import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import update
from starlette.testclient import TestClient, WebSocketTestSession
from starlette.websockets import WebSocketDisconnect

from app.models import Room, utcnow
from app.realtime import (
    CLOSE_AUTH_TIMEOUT,
    CLOSE_BAD_REQUEST,
    CLOSE_LEFT,
    CLOSE_ROOM_EXPIRED,
    CLOSE_TOO_MANY_CONNECTIONS,
    CLOSE_UNAUTHORIZED,
)
from tests.conftest import auth


def create(client: TestClient, name: str = "Alice") -> dict:
    response = client.post("/api/rooms", json={"display_name": name})
    assert response.status_code == 201, response.text
    return response.json()


def join(client: TestClient, code: str, name: str = "Bob") -> dict:
    response = client.post("/api/rooms/join", json={"code": code, "display_name": name})
    assert response.status_code == 200, response.text
    return response.json()


def ws_url(member: dict) -> str:
    return f"/api/rooms/{member['room']['id']}/ws"


@contextmanager
def connect(client: TestClient, member: dict) -> Iterator[tuple[WebSocketTestSession, dict]]:
    with client.websocket_connect(ws_url(member)) as ws:
        ws.send_json({"type": "auth", "token": member["token"]})
        ready = ws.receive_json()
        assert ready["type"] == "ready", ready
        yield ws, ready


def send(ws: WebSocketTestSession, content: str, client_id: str | None = None) -> None:
    ws.send_json({"type": "message.send", "content": content, "client_id": client_id})


def close_code(ws: WebSocketTestSession) -> int:
    with pytest.raises(WebSocketDisconnect) as closed:
        ws.receive_json()
    return closed.value.code


def set_expiry(client: TestClient, member: dict, expires_at: datetime) -> None:
    async def _update(app) -> None:
        async with app.state.sessionmaker() as session:
            await session.execute(
                update(Room).where(Room.id == uuid.UUID(member["room"]["id"])).values(expires_at=expires_at)
            )
            await session.commit()

    client.portal.call(_update, client.app)


def pair(client: TestClient) -> tuple[dict, dict]:
    alice = create(client)
    bob = join(client, alice["code"])
    return alice, bob


# --- Connecting and authenticating ----------------------------------------------------


def test_ready_lists_members_with_online_status(live_client):
    alice, bob = pair(live_client)
    with connect(live_client, alice) as (_ws, ready):
        assert ready["me"]["id"] == alice["participant"]["id"]
        members = {m["display_name"]: m["online"] for m in ready["participants"]}
        assert members == {"Alice": True, "Bob": False}

        details = live_client.get(f"/api/rooms/{alice['room']['id']}", headers=auth(bob["token"])).json()
        assert {m["display_name"]: m["online"] for m in details["participants"]} == {"Alice": True, "Bob": False}


def test_invalid_token_is_closed_as_unauthorized(live_client):
    alice = create(live_client)
    with live_client.websocket_connect(ws_url(alice)) as ws:
        ws.send_json({"type": "auth", "token": "not-a-real-token"})
        assert close_code(ws) == CLOSE_UNAUTHORIZED


def test_token_for_another_room_is_rejected(live_client):
    alice = create(live_client)
    carol = create(live_client, name="Carol")
    with live_client.websocket_connect(ws_url(carol)) as ws:
        ws.send_json({"type": "auth", "token": alice["token"]})
        assert close_code(ws) == CLOSE_UNAUTHORIZED


@pytest.mark.parametrize("first_frame", ['{"type": "message.send", "content": "hi"}', "not json", '["auth"]'])
def test_first_frame_must_be_auth(live_client, first_frame):
    alice = create(live_client)
    with live_client.websocket_connect(ws_url(alice)) as ws:
        ws.send_text(first_frame)
        assert close_code(ws) == CLOSE_BAD_REQUEST


def test_connection_that_never_authenticates_times_out(make_settings, live_client_factory):
    with live_client_factory(make_settings(ws_auth_timeout_seconds=0.2)) as client:
        alice = create(client)
        with client.websocket_connect(ws_url(alice)) as ws:
            assert close_code(ws) == CLOSE_AUTH_TIMEOUT


def test_expired_room_refuses_connections(live_client):
    alice = create(live_client)
    set_expiry(live_client, alice, utcnow() - timedelta(seconds=1))
    with live_client.websocket_connect(ws_url(alice)) as ws:
        ws.send_json({"type": "auth", "token": alice["token"]})
        assert close_code(ws) == CLOSE_ROOM_EXPIRED


def test_connections_per_participant_are_capped(make_settings, live_client_factory):
    with live_client_factory(make_settings(max_connections_per_participant=1)) as client:
        alice = create(client)
        with connect(client, alice), client.websocket_connect(ws_url(alice)) as second:
            second.send_json({"type": "auth", "token": alice["token"]})
            assert close_code(second) == CLOSE_TOO_MANY_CONNECTIONS


# --- Messaging ------------------------------------------------------------------------


def test_message_is_stored_then_broadcast_to_everyone(live_client):
    alice, bob = pair(live_client)
    with connect(live_client, alice) as (alice_ws, _), connect(live_client, bob) as (bob_ws, _):
        assert alice_ws.receive_json() == {"type": "presence", "participant_id": bob["participant"]["id"], "online": True}

        send(alice_ws, "Hello, Bob!", client_id="tmp-1")
        for ws in (alice_ws, bob_ws):
            received = ws.receive_json()
            assert received["type"] == "message.new"
            assert received["client_id"] == "tmp-1"
            assert received["message"]["content"] == "Hello, Bob!"
            assert received["message"]["display_name"] == "Alice"
            assert received["message"]["participant_id"] == alice["participant"]["id"]

    history = live_client.get(f"/api/rooms/{alice['room']['id']}/messages", headers=auth(bob["token"])).json()
    assert [m["content"] for m in history["messages"]] == ["Hello, Bob!"]


def test_history_survives_reconnect(live_client):
    alice = create(live_client)
    with connect(live_client, alice) as (ws, _):
        for text in ("one", "two", "three"):
            send(ws, text)
            assert ws.receive_json()["type"] == "message.new"

    # A "refresh": new connection, then load history.
    with connect(live_client, alice):
        history = live_client.get(f"/api/rooms/{alice['room']['id']}/messages", headers=auth(alice["token"])).json()
    assert [m["content"] for m in history["messages"]] == ["one", "two", "three"]
    assert history["has_more"] is False


def test_multiline_and_unicode_content_is_kept_verbatim(live_client):
    alice = create(live_client)
    text = "  line one\nline two 👋 <b>not html</b>  "
    with connect(live_client, alice) as (ws, _):
        send(ws, text)
        assert ws.receive_json()["message"]["content"] == text


@pytest.mark.parametrize(
    ("frame", "error_code"),
    [
        ({"type": "message.send", "content": "   "}, "invalid_message"),
        ({"type": "message.send", "content": 42}, "invalid_message"),
        ({"type": "message.send", "content": "bad\x00byte"}, "invalid_message"),
        ({"type": "message.send", "content": "x" * 4001}, "message_too_long"),
        ({"type": "dance"}, "unknown_type"),
    ],
)
def test_invalid_frames_get_an_error_and_keep_the_connection(live_client, frame: dict[str, Any], error_code):
    alice = create(live_client)
    with connect(live_client, alice) as (ws, _):
        ws.send_json({**frame, "client_id": "tmp-9"})
        error = ws.receive_json()
        assert error["type"] == "error"
        assert error["code"] == error_code
        assert error["client_id"] == ("tmp-9" if frame["type"] == "message.send" else None)

        # Still usable afterwards.
        send(ws, "still here")
        assert ws.receive_json()["message"]["content"] == "still here"


def test_non_json_and_binary_frames_are_rejected(live_client):
    alice = create(live_client)
    with connect(live_client, alice) as (ws, _):
        ws.send_text("{oops")
        assert ws.receive_json()["code"] == "invalid_json"
        ws.send_bytes(b"\x00\x01")
        assert ws.receive_json()["code"] == "unsupported_frame"


def test_message_rate_is_limited_per_participant(make_settings, live_client_factory):
    with live_client_factory(make_settings(message_rate_limit=2)) as client:
        alice = create(client)
        with connect(client, alice) as (ws, _):
            for text in ("a", "b"):
                send(ws, text)
                assert ws.receive_json()["type"] == "message.new"
            send(ws, "c", client_id="tmp-3")
            error = ws.receive_json()
        assert (error["code"], error["client_id"]) == ("rate_limited", "tmp-3")


def test_ping_gets_pong(live_client):
    alice = create(live_client)
    with connect(live_client, alice) as (ws, _):
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


# --- Room events ----------------------------------------------------------------------


def test_join_is_announced_to_connected_members(live_client):
    alice = create(live_client)
    with connect(live_client, alice) as (ws, _):
        bob = join(live_client, alice["code"])
        announced = ws.receive_json()
    assert announced["type"] == "participant.joined"
    assert announced["participant"]["id"] == bob["participant"]["id"]
    assert announced["participant"]["display_name"] == "Bob"
    assert "token" not in announced["participant"]


def test_uploaded_file_is_announced_to_the_room(live_client):
    alice, bob = pair(live_client)
    with connect(live_client, alice) as (ws, _):
        response = live_client.post(
            f"/api/rooms/{bob['room']['id']}/files",
            params={"name": "notes.pdf"},
            content=b"%PDF-1.7\n" + b"0" * 100,
            headers=auth(bob["token"]),
        )
        assert response.status_code == 201
        announced = ws.receive_json()
    assert announced == {"type": "file.ready", "file": response.json()}
    assert announced["file"]["display_name"] == "Bob"


def test_disconnect_marks_participant_offline(live_client):
    alice, bob = pair(live_client)
    with connect(live_client, alice) as (alice_ws, _):
        with connect(live_client, bob):
            assert alice_ws.receive_json()["online"] is True
        assert alice_ws.receive_json() == {
            "type": "presence",
            "participant_id": bob["participant"]["id"],
            "online": False,
        }


def test_second_tab_does_not_repeat_presence(live_client):
    alice, bob = pair(live_client)
    with connect(live_client, alice) as (alice_ws, _), connect(live_client, bob):
        assert alice_ws.receive_json()["online"] is True
        with connect(live_client, bob):
            pass  # opening and closing a second tab: Bob stays online throughout
        send(alice_ws, "next event should be this message")
        assert alice_ws.receive_json()["type"] == "message.new"


def test_leaving_closes_sockets_and_notifies_the_room(live_client):
    alice, bob = pair(live_client)
    with connect(live_client, alice) as (alice_ws, _), connect(live_client, bob) as (bob_ws, _):
        assert alice_ws.receive_json()["online"] is True

        response = live_client.delete(f"/api/rooms/{bob['room']['id']}/leave", headers=auth(bob["token"]))
        assert response.status_code == 204
        assert close_code(bob_ws) == CLOSE_LEFT

        # participant.left implies offline, so no separate presence event is sent.
        assert alice_ws.receive_json() == {"type": "participant.left", "participant_id": bob["participant"]["id"]}
        send(alice_ws, "bye Bob")
        assert alice_ws.receive_json()["type"] == "message.new"

        details = live_client.get(f"/api/rooms/{alice['room']['id']}", headers=auth(alice["token"])).json()
    assert [m["display_name"] for m in details["participants"]] == ["Alice"]


def test_connected_members_are_told_when_the_room_expires(live_client):
    alice = create(live_client)
    set_expiry(live_client, alice, utcnow() + timedelta(seconds=0.5))
    with connect(live_client, alice) as (ws, _):
        assert ws.receive_json() == {"type": "room.expired"}
        assert close_code(ws) == CLOSE_ROOM_EXPIRED


def test_sending_into_an_expired_room_closes_the_socket(live_client):
    alice = create(live_client)
    with connect(live_client, alice) as (ws, _):
        # Expire the room behind the hub's back, so only the per-message check can catch it.
        set_expiry(live_client, alice, utcnow() - timedelta(seconds=1))
        send(ws, "too late")
        assert ws.receive_json() == {"type": "room.expired"}
        assert close_code(ws) == CLOSE_ROOM_EXPIRED

    history = live_client.get(f"/api/rooms/{alice['room']['id']}/messages", headers=auth(alice["token"]))
    assert history.status_code == 410
