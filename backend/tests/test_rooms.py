import uuid
from datetime import datetime, timedelta

import httpx
import pytest
from sqlalchemy import update

from app.models import Room, RoomStatus, utcnow
from app.routers import rooms as rooms_router
from tests.conftest import auth


async def create_room(client: httpx.AsyncClient, name: str = "Alice", **extra) -> dict:
    response = await client.post("/api/rooms", json={"display_name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()


async def join_room(client: httpx.AsyncClient, code: str, name: str = "Bob") -> httpx.Response:
    return await client.post("/api/rooms/join", json={"code": code, "display_name": name})


async def expire_room(app, room_id: str) -> None:
    async with app.state.sessionmaker() as session:
        await session.execute(
            update(Room).where(Room.id == uuid.UUID(room_id)).values(expires_at=utcnow() - timedelta(seconds=1))
        )
        await session.commit()


# --- Creating rooms -------------------------------------------------------------------


async def test_create_room_returns_code_token_and_default_lifetime(client):
    data = await create_room(client)

    assert len(data["code"]) == 5 and data["code"].isdigit()
    assert data["token"]
    assert data["participant"]["display_name"] == "Alice"
    assert data["room"]["status"] == "active"

    room = data["room"]
    lifetime = datetime.fromisoformat(room["expires_at"]) - datetime.fromisoformat(room["created_at"])
    assert lifetime == timedelta(hours=2)


async def test_room_code_is_stored_only_as_a_keyed_hash(app, client):
    data = await create_room(client)

    async with app.state.sessionmaker() as session:
        room = await session.get(Room, uuid.UUID(data["room"]["id"]))
    assert room.code_hash != data["code"]
    assert len(room.code_hash) == 64


async def test_custom_lifetime_is_capped_at_the_maximum(client):
    ok = await client.post("/api/rooms", json={"display_name": "Alice", "lifetime_minutes": 480})
    assert ok.status_code == 201

    too_long = await client.post("/api/rooms", json={"display_name": "Alice", "lifetime_minutes": 481})
    assert too_long.status_code == 422


@pytest.mark.parametrize("name", ["", "   ", "a" * 33, "bad\x00name", "zero​width"])
async def test_invalid_display_names_are_rejected(client, name):
    response = await client.post("/api/rooms", json={"display_name": name})
    assert response.status_code == 422


async def test_display_name_is_trimmed(client):
    data = await create_room(client, name="  Alice  ")
    assert data["participant"]["display_name"] == "Alice"


async def test_room_creation_is_rate_limited_per_ip(make_settings, client_factory):
    async with client_factory(make_settings(room_create_limit=2)) as client:
        await create_room(client)
        await create_room(client)
        response = await client.post("/api/rooms", json={"display_name": "Alice"})
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "600"


async def test_code_held_by_an_open_room_is_not_reused(client, monkeypatch):
    codes = iter(["12345", "12345", "54321"])
    monkeypatch.setattr(rooms_router, "generate_room_code", lambda: next(codes))

    first = await create_room(client)
    second = await create_room(client)

    assert first["code"] == "12345"
    assert second["code"] == "54321"


async def test_code_of_an_expired_room_can_be_reused(app, client, monkeypatch):
    monkeypatch.setattr(rooms_router, "generate_room_code", lambda: "12345")
    first = await create_room(client)
    await expire_room(app, first["room"]["id"])

    second = await create_room(client)
    assert second["code"] == "12345"

    async with app.state.sessionmaker() as session:
        old = await session.get(Room, uuid.UUID(first["room"]["id"]))
    assert old.status == RoomStatus.EXPIRED

    joined = await join_room(client, "12345")
    assert joined.json()["room"]["id"] == second["room"]["id"]


async def test_chosen_code_is_used_as_the_room_code(client):
    data = await create_room(client, code="kitchenparty")

    assert data["code"] == "KITCHENPARTY"
    joined = await join_room(client, "KitchenParty")
    assert joined.status_code == 200
    assert joined.json()["room"]["id"] == data["room"]["id"]


async def test_chosen_code_is_stored_only_as_a_keyed_hash(app, client):
    data = await create_room(client, code="LETMEIN42")

    async with app.state.sessionmaker() as session:
        room = await session.get(Room, uuid.UUID(data["room"]["id"]))
    assert room.code_hash != "LETMEIN42"
    assert len(room.code_hash) == 64


@pytest.mark.parametrize("code", ["abc", "ABCDEFGHIJKLM", "ab cd", "ab-cd", "héllo", ""])
async def test_invalid_chosen_codes_are_rejected(client, code):
    response = await client.post("/api/rooms", json={"display_name": "Alice", "code": code})
    assert response.status_code == 422


async def test_chosen_code_already_in_use_is_refused(client):
    await create_room(client, code="TAKEN1")

    response = await client.post("/api/rooms", json={"display_name": "Bob", "code": "taken1"})
    assert response.status_code == 409


async def test_chosen_code_can_be_reused_once_its_room_has_expired(app, client):
    first = await create_room(client, code="SPRINT")
    await expire_room(app, first["room"]["id"])

    second = await create_room(client, code="sprint")
    assert second["code"] == "SPRINT"


async def test_chosen_code_can_be_a_five_digit_number(client):
    data = await create_room(client, code="48213")
    assert data["code"] == "48213"


# --- Joining rooms --------------------------------------------------------------------


async def test_second_browser_joins_and_both_see_each_other(client):
    alice = await create_room(client)
    response = await join_room(client, alice["code"])
    assert response.status_code == 200
    bob = response.json()
    assert bob["room"]["id"] == alice["room"]["id"]
    assert bob["token"] != alice["token"]

    for me in (alice, bob):
        details = await client.get(f"/api/rooms/{me['room']['id']}", headers=auth(me["token"]))
        assert details.status_code == 200
        body = details.json()
        assert body["me"]["id"] == me["participant"]["id"]
        assert [p["display_name"] for p in body["participants"]] == ["Alice", "Bob"]
        assert "code" not in body["room"]


async def test_wrong_code_is_rejected(client):
    alice = await create_room(client)
    wrong = "00000" if alice["code"] != "00000" else "00001"
    response = await join_room(client, wrong)
    assert response.status_code == 404


@pytest.mark.parametrize("code", ["123", "1234567890123", "12-45", "12 45", "ab_cd", "١٢٣٤٥"])
async def test_malformed_codes_are_rejected(client, code):
    response = await join_room(client, code)
    assert response.status_code == 422


async def test_failed_joins_are_rate_limited_per_ip(client):
    alice = await create_room(client)
    wrong = "00000" if alice["code"] != "00000" else "00001"

    for _ in range(5):
        assert (await join_room(client, wrong)).status_code == 404

    # Once limited, even the right code is refused until the window passes.
    blocked = await join_room(client, alice["code"])
    assert blocked.status_code == 429
    assert blocked.headers["Retry-After"] == "60"


async def test_successful_joins_do_not_count_towards_the_limit(client):
    alice = await create_room(client)
    for i in range(6):
        assert (await join_room(client, alice["code"], name=f"Guest {i}")).status_code == 200


async def test_expired_room_cannot_be_joined(app, client):
    alice = await create_room(client)
    await expire_room(app, alice["room"]["id"])

    response = await join_room(client, alice["code"])
    assert response.status_code == 404


async def test_full_room_rejects_new_participants(make_settings, client_factory):
    async with client_factory(make_settings(max_participants=2)) as client:
        alice = await create_room(client)
        assert (await join_room(client, alice["code"])).status_code == 200
        response = await join_room(client, alice["code"], name="Carol")
    assert response.status_code == 409


# --- Room access ----------------------------------------------------------------------


async def test_room_details_require_a_token(client):
    alice = await create_room(client)
    response = await client.get(f"/api/rooms/{alice['room']['id']}")
    assert response.status_code == 401


async def test_token_is_rejected_for_a_different_room(client):
    alice = await create_room(client, name="Alice")
    carol = await create_room(client, name="Carol")

    response = await client.get(f"/api/rooms/{carol['room']['id']}", headers=auth(alice["token"]))
    assert response.status_code == 401


async def test_unknown_token_is_rejected(client):
    alice = await create_room(client)
    response = await client.get(f"/api/rooms/{alice['room']['id']}", headers=auth("not-a-real-token"))
    assert response.status_code == 401


async def test_expired_room_is_gone_even_before_cleanup(app, client):
    alice = await create_room(client)
    await expire_room(app, alice["room"]["id"])

    response = await client.get(f"/api/rooms/{alice['room']['id']}", headers=auth(alice["token"]))
    assert response.status_code == 410


async def test_leaving_revokes_the_session_and_frees_a_seat(make_settings, client_factory):
    async with client_factory(make_settings(max_participants=2)) as client:
        alice = await create_room(client)
        bob = (await join_room(client, alice["code"])).json()
        room_url = f"/api/rooms/{alice['room']['id']}"

        left = await client.delete(f"{room_url}/leave", headers=auth(bob["token"]))
        assert left.status_code == 204

        assert (await client.get(room_url, headers=auth(bob["token"]))).status_code == 401
        details = (await client.get(room_url, headers=auth(alice["token"]))).json()
        assert [p["display_name"] for p in details["participants"]] == ["Alice"]

        # Bob's seat is free again.
        assert (await join_room(client, alice["code"], name="Carol")).status_code == 200


async def test_health(client):
    response = await client.get("/api/health")
    assert response.json() == {"status": "ok"}

# --- Host controls --------------------------------------------------------------------


async def test_whoever_opens_the_room_is_its_host(client):
    alice = await create_room(client)
    bob = (await join_room(client, alice["code"])).json()
    assert alice["participant"]["is_host"] is True
    assert bob["participant"]["is_host"] is False
    assert alice["room"]["locked"] is False

    details = await client.get(f"/api/rooms/{alice['room']['id']}", headers=auth(bob["token"]))
    assert {p["display_name"]: p["is_host"] for p in details.json()["participants"]} == {"Alice": True, "Bob": False}


async def test_host_can_extend_the_room(client):
    alice = await create_room(client, lifetime_minutes=30)
    before = datetime.fromisoformat(alice["room"]["expires_at"])
    response = await client.post(
        f"/api/rooms/{alice['room']['id']}/extend", json={"minutes": 30}, headers=auth(alice["token"])
    )
    assert response.status_code == 200, response.text
    assert datetime.fromisoformat(response.json()["expires_at"]) - before == timedelta(minutes=30)


async def test_extending_stops_at_the_longest_a_room_may_have_left(client):
    alice = await create_room(client, lifetime_minutes=470)
    url = f"/api/rooms/{alice['room']['id']}/extend"
    response = await client.post(url, json={"minutes": 60}, headers=auth(alice["token"]))
    assert response.status_code == 200
    left = datetime.fromisoformat(response.json()["expires_at"]) - utcnow()
    assert timedelta(minutes=479) < left <= timedelta(minutes=480)

    again = await client.post(url, json={"minutes": 60}, headers=auth(alice["token"]))
    assert again.status_code == 409


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("POST", "extend", {"minutes": 30}),
        ("POST", "lock", {"locked": True}),
    ],
)
async def test_only_the_host_can_change_the_room(client, method, path, body):
    alice = await create_room(client)
    bob = (await join_room(client, alice["code"])).json()
    response = await client.request(
        method, f"/api/rooms/{alice['room']['id']}/{path}", json=body, headers=auth(bob["token"])
    )
    assert response.status_code == 403


async def test_locked_room_turns_away_new_arrivals_until_unlocked(client):
    alice = await create_room(client)
    url = f"/api/rooms/{alice['room']['id']}/lock"
    locked = await client.post(url, json={"locked": True}, headers=auth(alice["token"]))
    assert locked.json()["locked"] is True

    refused = await join_room(client, alice["code"])
    assert refused.status_code == 423

    await client.post(url, json={"locked": False}, headers=auth(alice["token"]))
    assert (await join_room(client, alice["code"])).status_code == 200


async def test_host_can_remove_someone_and_their_session_stops_working(client):
    alice = await create_room(client)
    bob = (await join_room(client, alice["code"])).json()
    room_id = alice["room"]["id"]

    response = await client.delete(
        f"/api/rooms/{room_id}/participants/{bob['participant']['id']}", headers=auth(alice["token"])
    )
    assert response.status_code == 204
    assert (await client.get(f"/api/rooms/{room_id}", headers=auth(bob["token"]))).status_code == 401
    details = await client.get(f"/api/rooms/{room_id}", headers=auth(alice["token"]))
    assert [p["display_name"] for p in details.json()["participants"]] == ["Alice"]


async def test_guests_cannot_remove_anyone_and_the_host_cannot_remove_themselves(client):
    alice = await create_room(client)
    bob = (await join_room(client, alice["code"])).json()
    room_id = alice["room"]["id"]
    alice_id = alice["participant"]["id"]

    by_guest = await client.delete(f"/api/rooms/{room_id}/participants/{alice_id}", headers=auth(bob["token"]))
    assert by_guest.status_code == 403
    themselves = await client.delete(f"/api/rooms/{room_id}/participants/{alice_id}", headers=auth(alice["token"]))
    assert themselves.status_code == 422


async def test_cannot_remove_someone_from_another_room(client):
    alice = await create_room(client)
    carol = await create_room(client, name="Carol")
    response = await client.delete(
        f"/api/rooms/{alice['room']['id']}/participants/{carol['participant']['id']}", headers=auth(alice["token"])
    )
    assert response.status_code == 404
