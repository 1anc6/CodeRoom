import asyncio
import uuid
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select, update

from app.models import Room, RoomFile, utcnow
from tests.conftest import TEST_DATABASE_URL, auth

PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 20  # longer than the sniffing window
PDF = b"%PDF-1.7\n" + b"0" * 1000


async def create_room(client: httpx.AsyncClient, name: str = "Alice") -> dict:
    response = await client.post("/api/rooms", json={"display_name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def join_room(client: httpx.AsyncClient, code: str, name: str = "Bob") -> dict:
    response = await client.post("/api/rooms/join", json={"code": code, "display_name": name})
    assert response.status_code == 200, response.text
    return response.json()


def files_url(member: dict) -> str:
    return f"/api/rooms/{member['room']['id']}/files"


async def upload(client: httpx.AsyncClient, member: dict, content, name: str = "photo.png") -> httpx.Response:
    return await client.post(files_url(member), params={"name": name}, content=content, headers=auth(member["token"]))


async def chunked(data: bytes, size: int = 1000):
    """A body without Content-Length, so only the streamed byte count can enforce limits."""
    for start in range(0, len(data), size):
        yield data[start : start + size]


def stored_files(settings) -> list[Path]:
    root = Path(settings.storage_dir)
    return [p for p in root.rglob("*") if p.is_file()] if root.exists() else []


async def file_rows(app) -> int:
    async with app.state.sessionmaker() as session:
        return await session.scalar(select(func.count()).select_from(RoomFile))


@pytest.fixture
def storage_settings(app):
    return app.state.settings


# --- Uploading ------------------------------------------------------------------------


async def test_upload_stores_file_and_returns_metadata(app, client, storage_settings):
    alice = await create_room(client)
    response = await upload(client, alice, PNG, name="whiteboard.png")

    assert response.status_code == 201, response.text
    data = response.json()
    assert data["name"] == "whiteboard.png"
    assert data["mime_type"] == "image/png"
    assert data["size_bytes"] == len(PNG)
    assert data["display_name"] == "Alice"
    assert data["participant_id"] == alice["participant"]["id"]

    [stored] = stored_files(storage_settings)
    assert stored.read_bytes() == PNG
    assert "whiteboard" not in str(stored)  # storage keys are random, never the client's name


async def test_type_comes_from_content_not_the_client(client):
    alice = await create_room(client)
    response = await client.post(
        files_url(alice),
        params={"name": "notes.pdf"},
        content=PNG,
        headers={**auth(alice["token"]), "Content-Type": "application/pdf"},
    )
    assert response.status_code == 201
    assert response.json()["mime_type"] == "image/png"
    assert response.json()["name"] == "notes.pdf.png"


async def test_small_files_under_the_sniffing_window_work(client):
    alice = await create_room(client)
    response = await upload(client, alice, b"short note\n", name="note.txt")
    assert response.status_code == 201
    assert response.json()["mime_type"] == "text/plain"


async def test_chunked_upload_without_content_length(client, storage_settings):
    alice = await create_room(client)
    response = await upload(client, alice, chunked(PNG), name="photo.png")
    assert response.status_code == 201
    [stored] = stored_files(storage_settings)
    assert stored.read_bytes() == PNG


async def test_filename_is_cleaned(client):
    alice = await create_room(client)
    response = await upload(client, alice, PDF, name="../../secret/re\x00port.pdf")
    assert response.json()["name"] == "report.pdf"


@pytest.mark.parametrize(
    ("content", "name"),
    [
        (b"MZ\x90\x00" + b"\x00" * 5000, "setup.exe"),
        (b"<!doctype html><script>alert(1)</script>", "page.html"),
        (b"<svg xmlns='http://www.w3.org/2000/svg'></svg>", "logo.svg"),
        (b"PK\x03\x04" + b"\x00" * 100, "archive.zip"),
    ],
)
async def test_disallowed_types_are_rejected_and_nothing_is_kept(app, client, storage_settings, content, name):
    alice = await create_room(client)
    response = await upload(client, alice, content, name=name)
    assert response.status_code == 415
    assert stored_files(storage_settings) == []
    assert await file_rows(app) == 0


async def test_empty_file_is_rejected(client):
    alice = await create_room(client)
    response = await upload(client, alice, b"", name="empty.txt")
    assert response.status_code == 422


async def test_name_is_required(client):
    alice = await create_room(client)
    response = await client.post(files_url(alice), content=PNG, headers=auth(alice["token"]))
    assert response.status_code == 422


@pytest.mark.parametrize("use_content_length", [True, False])
async def test_oversized_file_is_rejected_and_nothing_is_kept(
    make_settings, client_factory, use_content_length
):
    settings = make_settings(max_file_size_bytes=len(PNG) - 1)
    async with client_factory(settings) as client:
        alice = await create_room(client)
        body = PNG if use_content_length else chunked(PNG)
        response = await upload(client, alice, body)
    assert response.status_code == 413
    assert "at most" in response.json()["detail"]
    assert stored_files(settings) == []


async def test_room_storage_quota(make_settings, client_factory):
    settings = make_settings(max_room_storage_bytes=int(len(PNG) * 1.5))
    async with client_factory(settings) as client:
        alice = await create_room(client)
        bob = await join_room(client, alice["code"])
        assert (await upload(client, alice, PNG)).status_code == 201

        # The quota is per room, shared by everyone in it, and holds for chunked uploads too.
        for body in (PNG, chunked(PNG)):
            response = await upload(client, bob, body)
            assert response.status_code == 413
            assert "run out of space" in response.json()["detail"]

        # Smaller files that still fit are fine.
        assert (await upload(client, bob, PDF, name="a.pdf")).status_code == 201
    assert len(stored_files(settings)) == 2


@pytest.mark.skipif(
    not (TEST_DATABASE_URL or "").startswith("postgresql"),
    reason="needs PostgreSQL row locking; SQLite serializes writes differently",
)
async def test_concurrent_uploads_cannot_overshoot_the_quota(make_settings, client_factory):
    settings = make_settings(max_room_storage_bytes=int(len(PNG) * 1.5))
    async with client_factory(settings) as client:
        alice = await create_room(client)
        bob = await join_room(client, alice["code"])
        # Both pass the early check (the room is empty), so only the locked re-check can stop one.
        responses = await asyncio.gather(upload(client, alice, chunked(PNG)), upload(client, bob, chunked(PNG)))
    assert sorted(r.status_code for r in responses) == [201, 413]
    assert len(stored_files(settings)) == 1


async def test_uploads_are_rate_limited_per_participant(make_settings, client_factory):
    async with client_factory(make_settings(upload_rate_limit=2)) as client:
        alice = await create_room(client)
        bob = await join_room(client, alice["code"])
        for _ in range(2):
            assert (await upload(client, alice, PDF, name="a.pdf")).status_code == 201
        limited = await upload(client, alice, PDF, name="a.pdf")
        assert limited.status_code == 429
        assert limited.headers["Retry-After"] == "60"
        # Other people in the room aren't affected.
        assert (await upload(client, bob, PDF, name="b.pdf")).status_code == 201


async def test_upload_needs_a_valid_session(client):
    alice = await create_room(client)
    response = await client.post(files_url(alice), params={"name": "a.png"}, content=PNG)
    assert response.status_code == 401


async def test_upload_into_expired_room_is_refused(app, client, storage_settings):
    alice = await create_room(client)
    async with app.state.sessionmaker() as session:
        await session.execute(
            update(Room)
            .where(Room.id == uuid.UUID(alice["room"]["id"]))
            .values(expires_at=utcnow() - timedelta(seconds=1))
        )
        await session.commit()

    response = await upload(client, alice, PNG)
    assert response.status_code == 410
    assert stored_files(storage_settings) == []


# --- Listing and downloading ----------------------------------------------------------


async def test_files_are_listed_oldest_first_for_everyone_in_the_room(client):
    alice = await create_room(client)
    bob = await join_room(client, alice["code"])
    await upload(client, alice, PNG, name="first.png")
    await upload(client, bob, PDF, name="second.pdf")

    listing = (await client.get(files_url(alice), headers=auth(bob["token"]))).json()
    assert [(f["name"], f["display_name"]) for f in listing["files"]] == [
        ("first.png", "Alice"),
        ("second.pdf", "Bob"),
    ]
    assert listing["has_more"] is False


async def test_download_returns_the_bytes_with_safe_headers(client):
    alice = await create_room(client)
    bob = await join_room(client, alice["code"])
    file_id = (await upload(client, alice, PNG, name="白板.png")).json()["id"]

    response = await client.get(f"{files_url(bob)}/{file_id}", headers=auth(bob["token"]))
    assert response.status_code == 200
    assert response.content == PNG
    assert response.headers["content-type"] == "image/png"
    assert response.headers["content-length"] == str(len(PNG))
    assert response.headers["content-disposition"].startswith("attachment;")
    assert "filename*=UTF-8''%E7%99%BD%E6%9D%BF.png" in response.headers["content-disposition"]
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]
    assert response.headers["cache-control"] == "private, no-store"


async def test_text_files_are_served_as_utf8(client):
    alice = await create_room(client)
    file_id = (await upload(client, alice, "naïve café\n".encode(), name="notes.txt")).json()["id"]
    response = await client.get(f"{files_url(alice)}/{file_id}", headers=auth(alice["token"]))
    assert response.headers["content-type"] == "text/plain; charset=utf-8"
    assert response.text == "naïve café\n"


async def test_file_id_alone_does_not_grant_access(client):
    alice = await create_room(client)
    carol = await create_room(client, name="Carol")
    file_id = (await upload(client, alice, PNG)).json()["id"]

    # Carol's token for her own room, asking for Alice's file through her room's URL...
    assert (await client.get(f"{files_url(carol)}/{file_id}", headers=auth(carol["token"]))).status_code == 404
    # ...or through Alice's room's URL.
    assert (await client.get(f"{files_url(alice)}/{file_id}", headers=auth(carol["token"]))).status_code == 401
    # No token at all.
    assert (await client.get(f"{files_url(alice)}/{file_id}")).status_code == 401


async def test_unknown_file_is_not_found(client):
    alice = await create_room(client)
    response = await client.get(f"{files_url(alice)}/{uuid.uuid4()}", headers=auth(alice["token"]))
    assert response.status_code == 404


async def test_participant_who_left_cannot_download(client):
    alice = await create_room(client)
    bob = await join_room(client, alice["code"])
    file_id = (await upload(client, alice, PNG)).json()["id"]

    await client.delete(f"/api/rooms/{bob['room']['id']}/leave", headers=auth(bob["token"]))
    response = await client.get(f"{files_url(alice)}/{file_id}", headers=auth(bob["token"]))
    assert response.status_code == 401


async def test_missing_stored_object_is_not_found_rather_than_a_crash(client, storage_settings):
    alice = await create_room(client)
    file_id = (await upload(client, alice, PNG)).json()["id"]
    for path in stored_files(storage_settings):
        path.unlink()

    response = await client.get(f"{files_url(alice)}/{file_id}", headers=auth(alice["token"]))
    assert response.status_code == 404


# --- Downloading everything as a zip -------------------------------------------------


async def test_all_files_download_as_one_zip_with_unique_names(client):
    import io
    import zipfile

    alice = await create_room(client)
    for content, name in ((PNG, "photo.png"), (PDF, "notes.pdf"), (PNG, "photo.png")):
        assert (await upload(client, alice, content, name)).status_code == 201

    response = await client.get(files_url(alice) + ".zip", headers=auth(alice["token"]))
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.namelist() == ["photo.png", "notes.pdf", "photo (2).png"]
        assert archive.read("notes.pdf") == PDF
        assert archive.read("photo (2).png") == PNG


async def test_zip_needs_a_member_and_at_least_one_file(client):
    alice = await create_room(client)
    assert (await client.get(files_url(alice) + ".zip")).status_code == 401
    assert (await client.get(files_url(alice) + ".zip", headers=auth(alice["token"]))).status_code == 404
