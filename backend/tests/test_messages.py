import uuid
from datetime import datetime, timedelta

import httpx
import pytest

from app.models import Message, utcnow
from tests.conftest import auth


async def create_room(client: httpx.AsyncClient) -> dict:
    response = await client.post("/api/rooms", json={"display_name": "Alice"})
    assert response.status_code == 201, response.text
    return response.json()


async def add_messages(app, member: dict, timestamps: list[datetime]) -> list[str]:
    """Insert messages directly, numbered in insertion order, and return their ids."""
    messages = [
        Message(
            room_id=uuid.UUID(member["room"]["id"]),
            participant_id=uuid.UUID(member["participant"]["id"]),
            content=f"m{i}",
            created_at=ts,
        )
        for i, ts in enumerate(timestamps)
    ]
    async with app.state.sessionmaker() as session:
        session.add_all(messages)
        await session.commit()
    return [str(m.id) for m in messages]


def contents(page: dict) -> list[str]:
    return [m["content"] for m in page["messages"]]


@pytest.fixture
async def alice(client) -> dict:
    return await create_room(client)


@pytest.fixture
def history(client, alice):
    async def _get(**params) -> httpx.Response:
        return await client.get(
            f"/api/rooms/{alice['room']['id']}/messages", params=params, headers=auth(alice["token"])
        )

    return _get


def spaced(count: int) -> list[datetime]:
    start = utcnow() - timedelta(minutes=10)
    return [start + timedelta(seconds=i) for i in range(count)]


async def test_empty_room_has_no_history(history):
    page = (await history()).json()
    assert page == {"messages": [], "has_more": False}


async def test_latest_page_is_oldest_first(app, alice, history):
    await add_messages(app, alice, spaced(5))

    page = (await history(limit=3)).json()
    assert contents(page) == ["m2", "m3", "m4"]
    assert page["has_more"] is True


async def test_before_pages_back_through_older_messages(app, alice, history):
    ids = await add_messages(app, alice, spaced(5))

    page = (await history(limit=3, before=ids[2])).json()
    assert contents(page) == ["m0", "m1"]
    assert page["has_more"] is False


async def test_after_catches_up_on_missed_messages(app, alice, history):
    ids = await add_messages(app, alice, spaced(5))

    page = (await history(limit=2, after=ids[1])).json()
    assert contents(page) == ["m2", "m3"]
    assert page["has_more"] is True

    page = (await history(limit=2, after=ids[3])).json()
    assert contents(page) == ["m4"]
    assert page["has_more"] is False


async def test_messages_with_identical_timestamps_page_without_gaps_or_repeats(app, alice, history):
    same_moment = utcnow() - timedelta(minutes=1)
    await add_messages(app, alice, [same_moment] * 4)

    seen: list[str] = []
    page = (await history(limit=1)).json()
    seen += contents(page)
    while page["has_more"]:
        page = (await history(limit=1, before=page["messages"][0]["id"])).json()
        seen += contents(page)

    assert sorted(seen) == ["m0", "m1", "m2", "m3"]


async def test_deleted_messages_are_hidden(app, alice, history):
    ids = await add_messages(app, alice, spaced(2))
    async with app.state.sessionmaker() as session:
        message = await session.get(Message, uuid.UUID(ids[0]))
        message.deleted_at = utcnow()
        await session.commit()

    assert contents((await history()).json()) == ["m1"]


async def test_cursor_from_another_room_is_rejected(app, client, alice, history):
    other = await create_room(client)
    other_ids = await add_messages(app, other, spaced(1))

    response = await history(before=other_ids[0])
    assert response.status_code == 404


async def test_before_and_after_together_are_rejected(app, alice, history):
    ids = await add_messages(app, alice, spaced(2))
    response = await history(before=ids[1], after=ids[0])
    assert response.status_code == 422


@pytest.mark.parametrize("limit", [0, 101])
async def test_limit_is_bounded(history, limit):
    assert (await history(limit=limit)).status_code == 422


async def test_history_requires_room_membership(client, alice):
    other = await create_room(client)
    response = await client.get(f"/api/rooms/{alice['room']['id']}/messages", headers=auth(other["token"]))
    assert response.status_code == 401
