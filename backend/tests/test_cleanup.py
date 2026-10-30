import asyncio
import os
import time
import uuid
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select, update
from starlette.websockets import WebSocketDisconnect

from app.cleanup import purge_room, reconcile_storage, run_cleanup, run_once
from app.models import Message, Participant, Room, RoomFile, RoomStatus, utcnow
from app.realtime import CLOSE_ROOM_EXPIRED
from app.storage import room_prefix
from tests.conftest import TEST_DATABASE_URL, auth

PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 20
HOUR = timedelta(hours=1)


class FlakyStorage:
    """Wraps real storage, failing delete_prefix for chosen rooms a given number of times."""

    def __init__(self, inner, fail_rooms: set[str], failures: int = 1) -> None:
        self.inner = inner
        self.fail_prefixes = {room_prefix(uuid.UUID(r)) for r in fail_rooms}
        self.failures = failures

    def __getattr__(self, name):
        return getattr(self.inner, name)

    async def delete_prefix(self, prefix: str) -> None:
        if prefix in self.fail_prefixes and self.failures > 0:
            self.failures -= 1
            raise OSError("storage temporarily unavailable")
        await self.inner.delete_prefix(prefix)


async def create_room(client: httpx.AsyncClient, name: str = "Alice") -> dict:
    response = await client.post("/api/rooms", json={"display_name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def join_room(client: httpx.AsyncClient, code: str, name: str = "Bob") -> dict:
    response = await client.post("/api/rooms/join", json={"code": code, "display_name": name})
    assert response.status_code == 200, response.text
    return response.json()


async def upload(client: httpx.AsyncClient, member: dict) -> dict:
    response = await client.post(
        f"/api/rooms/{member['room']['id']}/files",
        params={"name": "photo.png"},
        content=PNG,
        headers=auth(member["token"]),
    )
    assert response.status_code == 201, response.text
    return response.json()


async def add_message(app, member: dict) -> None:
    async with app.state.sessionmaker() as session:
        session.add(
            Message(
                room_id=uuid.UUID(member["room"]["id"]),
                participant_id=uuid.UUID(member["participant"]["id"]),
                content="hello",
            )
        )
        await session.commit()


async def set_room(app, member: dict, **values) -> None:
    async with app.state.sessionmaker() as session:
        await session.execute(update(Room).where(Room.id == uuid.UUID(member["room"]["id"])).values(**values))
        await session.commit()


async def expire(app, member: dict) -> None:
    await set_room(app, member, expires_at=utcnow() - timedelta(seconds=1))


async def room_status(app, member: dict) -> str:
    async with app.state.sessionmaker() as session:
        return (await session.get(Room, uuid.UUID(member["room"]["id"]))).status


async def row_counts(app, member: dict) -> dict[str, int]:
    room_id = uuid.UUID(member["room"]["id"])
    async with app.state.sessionmaker() as session:
        return {
            model.__tablename__: await session.scalar(
                select(func.count()).select_from(model).where(model.room_id == room_id)
            )
            for model in (Participant, Message, RoomFile)
        }


def stored_keys(app, member: dict | None = None) -> list[str]:
    root = Path(app.state.settings.storage_dir)
    base = root / (room_prefix(uuid.UUID(member["room"]["id"])) if member else "rooms")
    return sorted(p.relative_to(root).as_posix() for p in base.rglob("*") if p.is_file()) if base.exists() else []


async def cleanup(app, storage=None, batch_size: int = 50):
    return await run_cleanup(app.state.sessionmaker, storage or app.state.storage, batch_size)


# --- Revoke and purge -----------------------------------------------------------------


async def test_expired_room_is_fully_deleted_and_others_are_untouched(app, client):
    alice = await create_room(client)
    await join_room(client, alice["code"])
    await add_message(app, alice)
    await upload(client, alice)
    carol = await create_room(client, name="Carol")
    carol_file = await upload(client, carol)

    await expire(app, alice)
    result = await cleanup(app)

    assert (result.revoked, result.deleted, result.failed) == (1, 1, 0)
    assert await room_status(app, alice) == RoomStatus.DELETED
    assert await row_counts(app, alice) == {"participants": 0, "messages": 0, "files": 0}
    assert stored_keys(app, alice) == []

    assert await room_status(app, carol) == RoomStatus.ACTIVE
    assert len(stored_keys(app, carol)) == 1
    download = await client.get(
        f"/api/rooms/{carol['room']['id']}/files/{carol_file['id']}", headers=auth(carol["token"])
    )
    assert download.content == PNG


async def test_open_rooms_are_left_alone(app, client):
    alice = await create_room(client)
    result = await cleanup(app)
    assert (result.revoked, result.deleted, result.failed) == (0, 0, 0)
    assert await room_status(app, alice) == RoomStatus.ACTIVE


async def test_rooms_marked_expired_early_are_cleaned_too(app, client):
    # Rooms are marked `expired` when their code is reused before cleanup runs.
    alice = await create_room(client)
    await set_room(app, alice, status=RoomStatus.EXPIRED)
    result = await cleanup(app)
    assert result.deleted == 1
    assert await room_status(app, alice) == RoomStatus.DELETED


async def test_cleanup_is_idempotent(app, client):
    alice = await create_room(client)
    await upload(client, alice)
    await expire(app, alice)

    assert (await cleanup(app)).deleted == 1
    again = await cleanup(app)
    assert (again.revoked, again.deleted, again.failed) == (0, 0, 0)
    assert await purge_room(app.state.sessionmaker, app.state.storage, uuid.UUID(alice["room"]["id"])) is False


async def test_storage_failure_keeps_the_room_revoked_and_is_retried(app, client):
    alice = await create_room(client)
    await upload(client, alice)
    await expire(app, alice)
    flaky = FlakyStorage(app.state.storage, fail_rooms={alice["room"]["id"]}, failures=1)

    first = await cleanup(app, storage=flaky)
    assert (first.revoked, first.deleted, first.failed) == (1, 0, 1)
    assert await room_status(app, alice) == RoomStatus.DELETING
    # Nothing was half-deleted: records and objects are intact for the retry...
    assert await row_counts(app, alice) == {"participants": 1, "messages": 0, "files": 1}
    assert len(stored_keys(app, alice)) == 1
    # ...and access is already blocked.
    response = await client.get(f"/api/rooms/{alice['room']['id']}", headers=auth(alice["token"]))
    assert response.status_code == 410

    second = await cleanup(app, storage=flaky)
    assert (second.deleted, second.failed) == (1, 0)
    assert await room_status(app, alice) == RoomStatus.DELETED
    assert stored_keys(app, alice) == []


async def test_a_failing_room_does_not_block_the_others(app, client):
    alice = await create_room(client)
    bob_room = await create_room(client, name="Bob")
    await expire(app, alice)
    await expire(app, bob_room)
    flaky = FlakyStorage(app.state.storage, fail_rooms={alice["room"]["id"]}, failures=100)

    result = await cleanup(app, storage=flaky)
    assert (result.deleted, result.failed) == (1, 1)
    assert await room_status(app, alice) == RoomStatus.DELETING
    assert await room_status(app, bob_room) == RoomStatus.DELETED


async def test_batch_size_caps_rooms_per_run(app, client):
    members = [await create_room(client, name=f"Host {i}") for i in range(3)]
    for member in members:
        await expire(app, member)

    assert (await cleanup(app, batch_size=2)).deleted == 2
    assert (await cleanup(app, batch_size=2)).deleted == 1


async def test_members_of_a_deleted_room_are_told_it_expired(app, client):
    alice = await create_room(client)
    file = await upload(client, alice)
    await expire(app, alice)
    await cleanup(app)

    room_url = f"/api/rooms/{alice['room']['id']}"
    for url in (room_url, f"{room_url}/messages", f"{room_url}/files", f"{room_url}/files/{file['id']}"):
        assert (await client.get(url, headers=auth(alice["token"]))).status_code == 410, url

    join = await client.post("/api/rooms/join", json={"code": alice["code"], "display_name": "Late"})
    assert join.status_code == 404


async def test_bad_tokens_on_open_rooms_are_still_unauthorized(client):
    alice = await create_room(client)
    response = await client.get(f"/api/rooms/{alice['room']['id']}", headers=auth("wrong"))
    assert response.status_code == 401


async def test_command_line_run(app, client):
    alice = await create_room(client)
    await upload(client, alice)
    await expire(app, alice)

    result = await run_once(app.state.settings, reconcile=True)
    assert (result.revoked, result.deleted) == (1, 1)
    assert await room_status(app, alice) == RoomStatus.DELETED


@pytest.mark.skipif(
    not (TEST_DATABASE_URL or "").startswith("postgresql"),
    reason="needs PostgreSQL row locking (SKIP LOCKED)",
)
async def test_concurrent_workers_split_the_work(app, client):
    members = [await create_room(client, name=f"Host {i}") for i in range(6)]
    for member in members:
        await upload(client, member)
        await expire(app, member)

    results = await asyncio.gather(cleanup(app), cleanup(app))
    assert sum(r.deleted for r in results) == 6
    assert sum(r.failed for r in results) == 0
    assert stored_keys(app) == []


# --- Reconcile ------------------------------------------------------------------------


def write_object(app, key: str, age: timedelta = timedelta(0)) -> None:
    path = Path(app.state.settings.storage_dir, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"stray")
    stamp = time.time() - age.total_seconds()
    os.utime(path, (stamp, stamp))


async def reconcile(app, grace: timedelta = HOUR) -> int:
    return await reconcile_storage(app.state.sessionmaker, app.state.storage, grace)


async def test_reconcile_removes_old_strays_in_open_rooms_but_keeps_recent_ones(app, client):
    alice = await create_room(client)
    await upload(client, alice)
    recorded = stored_keys(app, alice)
    prefix = room_prefix(uuid.UUID(alice["room"]["id"]))
    write_object(app, prefix + "old-orphan", age=2 * HOUR)  # upload recorded nowhere
    write_object(app, prefix + "abandoned.part", age=2 * HOUR)  # interrupted write
    write_object(app, prefix + "maybe-in-progress.part", age=timedelta(minutes=5))

    assert await reconcile(app) == 2
    assert stored_keys(app, alice) == sorted([*recorded, prefix + "maybe-in-progress.part"])


async def test_reconcile_removes_objects_of_deleted_and_unknown_rooms(app, client):
    alice = await create_room(client)
    await set_room(app, alice, status=RoomStatus.DELETED)
    write_object(app, room_prefix(uuid.UUID(alice["room"]["id"])) + "leftover")
    write_object(app, room_prefix(uuid.uuid4()) + "no-such-room")

    assert await reconcile(app) == 2
    assert stored_keys(app) == []


async def test_reconcile_leaves_rooms_being_deleted_and_unrecognised_keys_alone(app, client):
    alice = await create_room(client)
    await set_room(app, alice, status=RoomStatus.DELETING)
    key = room_prefix(uuid.UUID(alice["room"]["id"])) + "pending"
    write_object(app, key, age=2 * HOUR)
    write_object(app, "rooms/not-a-room-id/file", age=2 * HOUR)

    assert await reconcile(app) == 0
    assert stored_keys(app) == sorted([key, "rooms/not-a-room-id/file"])


def test_open_socket_is_told_the_room_expired_after_cleanup(live_client):
    alice = live_client.post("/api/rooms", json={"display_name": "Alice"}).json()
    with live_client.websocket_connect(f"/api/rooms/{alice['room']['id']}/ws") as ws:
        ws.send_json({"type": "auth", "token": alice["token"]})
        assert ws.receive_json()["type"] == "ready"

        async def _expire_and_clean(app) -> None:
            await expire(app, alice)
            await cleanup(app)

        live_client.portal.call(_expire_and_clean, live_client.app)
        ws.send_json({"type": "message.send", "content": "anyone there?"})
        assert ws.receive_json() == {"type": "room.expired"}
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == CLOSE_ROOM_EXPIRED


# --- Background worker ----------------------------------------------------------------


def test_worker_in_the_app_cleans_up_on_its_own(make_settings, live_client_factory):
    settings = make_settings(cleanup_in_app=True, cleanup_interval_seconds=0.1)
    with live_client_factory(settings) as client:
        alice = client.post("/api/rooms", json={"display_name": "Alice"}).json()

        async def _expire_and_wait(app) -> str:
            await expire(app, alice)
            for _ in range(100):
                if await room_status(app, alice) == RoomStatus.DELETED:
                    break
                await asyncio.sleep(0.05)
            return await room_status(app, alice)

        assert client.portal.call(_expire_and_wait, client.app) == RoomStatus.DELETED

        with client.websocket_connect(f"/api/rooms/{alice['room']['id']}/ws") as ws:
            ws.send_json({"type": "auth", "token": alice["token"]})
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
        assert closed.value.code == CLOSE_ROOM_EXPIRED
