import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.db import get_session
from app.models import Participant, utcnow
from app.security import hash_session_token

SessionDep = Annotated[AsyncSession, Depends(get_session)]

# Tokens travel in the Authorization header (or the first WebSocket frame), never in URLs.
_bearer = HTTPBearer(auto_error=False)


async def find_participant(session: AsyncSession, room_id: uuid.UUID, token: str) -> Participant | None:
    """The participant this token belongs to, if it is a current member of this room.
    The room is loaded too; callers still need to check that it is open."""
    return await session.scalar(
        select(Participant)
        .options(joinedload(Participant.room))
        .where(
            Participant.token_hash == hash_session_token(token),
            Participant.room_id == room_id,
            Participant.left_at.is_(None),
        )
    )


async def get_current_participant(
    room_id: uuid.UUID,
    session: SessionDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> Participant:
    """Authorize a request against one room: valid token, member of this room, room still open."""
    unauthorized = HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        detail="Missing or invalid room session",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if credentials is None:
        raise unauthorized

    participant = await find_participant(session, room_id, credentials.credentials)
    if participant is None:
        raise unauthorized

    now = utcnow()
    if not participant.room.is_open(now):
        raise HTTPException(status.HTTP_410_GONE, detail="This room has expired")

    participant.last_seen_at = now
    await session.commit()
    return participant


CurrentParticipant = Annotated[Participant, Depends(get_current_participant)]
