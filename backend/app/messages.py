"""Message queries and serialization shared by the HTTP and WebSocket routes."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.models import Message, Participant, RoomFile
from app.realtime import RoomHub
from app.schemas import MemberOut, MessageOut, ReplyOut

# Enough of a quoted message to draw a two-line quote; clients clamp it further.
_QUOTE_LENGTH = 200


def reply_out(message: Message) -> ReplyOut | None:
    """The quote for a reply. Needs reply_to_message and reply_to_file loaded (see visible_messages)."""
    quoted = message.reply_to_message
    if quoted is not None and quoted.deleted_at is None:
        return ReplyOut(
            kind="message",
            id=quoted.id,
            participant_id=quoted.participant_id,
            display_name=quoted.participant.display_name,
            text=quoted.content[:_QUOTE_LENGTH],
        )
    file = message.reply_to_file
    if file is not None and file.deleted_at is None:
        return ReplyOut(
            kind="file",
            id=file.id,
            participant_id=file.participant_id,
            display_name=file.participant.display_name,
            text=file.original_name,
            mime_type=file.mime_type,
        )
    return None


def message_out(message: Message) -> MessageOut:
    return MessageOut(
        id=message.id,
        participant_id=message.participant_id,
        display_name=message.participant.display_name,
        content=message.content,
        created_at=message.created_at,
        reply_to=reply_out(message),
    )


async def current_members(session: AsyncSession, hub: RoomHub, room_id: uuid.UUID) -> list[MemberOut]:
    participants = await session.scalars(
        select(Participant)
        .where(Participant.room_id == room_id, Participant.left_at.is_(None))
        .order_by(Participant.joined_at)
    )
    online = hub.online_participant_ids(room_id)
    return [
        MemberOut(
            id=p.id, display_name=p.display_name, joined_at=p.joined_at, is_host=p.is_host, online=p.id in online
        )
        for p in participants
    ]


def visible_messages(room_id: uuid.UUID):
    return (
        select(Message)
        .options(
            joinedload(Message.participant),
            joinedload(Message.reply_to_message).joinedload(Message.participant),
            joinedload(Message.reply_to_file).joinedload(RoomFile.participant),
        )
        .where(Message.room_id == room_id, Message.deleted_at.is_(None))
    )
