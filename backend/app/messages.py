"""Message queries and serialization shared by the HTTP and WebSocket routes."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.models import Message, Participant
from app.realtime import RoomHub
from app.schemas import MemberOut, MessageOut


def message_out(message: Message) -> MessageOut:
    return MessageOut(
        id=message.id,
        participant_id=message.participant_id,
        display_name=message.participant.display_name,
        content=message.content,
        created_at=message.created_at,
    )


async def current_members(session: AsyncSession, hub: RoomHub, room_id: uuid.UUID) -> list[MemberOut]:
    participants = await session.scalars(
        select(Participant)
        .where(Participant.room_id == room_id, Participant.left_at.is_(None))
        .order_by(Participant.joined_at)
    )
    online = hub.online_participant_ids(room_id)
    return [
        MemberOut(id=p.id, display_name=p.display_name, joined_at=p.joined_at, online=p.id in online)
        for p in participants
    ]


def visible_messages(room_id: uuid.UUID):
    return (
        select(Message)
        .options(joinedload(Message.participant))
        .where(Message.room_id == room_id, Message.deleted_at.is_(None))
    )
