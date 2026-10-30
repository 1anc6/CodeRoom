import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import literal, select, tuple_

from app.deps import CurrentParticipant, SessionDep
from app.messages import message_out, visible_messages
from app.models import Message
from app.schemas import MessagePageOut

router = APIRouter(prefix="/api/rooms", tags=["messages"])


@router.get("/{room_id}/messages", response_model=MessagePageOut)
async def list_messages(
    me: CurrentParticipant,
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    before: Annotated[uuid.UUID | None, Query(description="Return messages older than this message.")] = None,
    after: Annotated[uuid.UUID | None, Query(description="Return messages newer than this message.")] = None,
) -> MessagePageOut:
    """Message history, oldest first.

    With no cursor this returns the latest messages. `before` pages back through older
    history; `after` catches up on messages missed while disconnected.
    """
    if before is not None and after is not None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Use either before or after, not both")

    # Order by (created_at, id) so messages with identical timestamps still page consistently.
    columns = (Message.created_at, Message.id)
    query = visible_messages(me.room_id)

    cursor_id = before or after
    if cursor_id is not None:
        cursor = await session.scalar(
            select(Message).where(Message.id == cursor_id, Message.room_id == me.room_id)
        )
        if cursor is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Cursor message not found in this room")
        position = tuple_(*columns)
        cursor_position = tuple_(*(literal(getattr(cursor, col.key), col.type) for col in columns))
        query = query.where(position > cursor_position if after else position < cursor_position)

    newest_first = after is None
    query = query.order_by(*(col.desc() for col in columns) if newest_first else columns)
    rows = list(await session.scalars(query.limit(limit + 1)))

    has_more = len(rows) > limit
    rows = rows[:limit]
    if newest_first:
        rows.reverse()
    return MessagePageOut(messages=[message_out(m) for m in rows], has_more=has_more)
