from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import CurrentParticipant, SessionDep
from app.models import Participant, Room, RoomStatus, utcnow
from app.rate_limit import client_ip
from app.schemas import (
    CreateRoomRequest,
    JoinRoomRequest,
    ParticipantOut,
    RoomDetailsOut,
    RoomOut,
    RoomSessionOut,
)
from app.security import generate_room_code, generate_session_token, hash_room_code, hash_session_token

router = APIRouter(prefix="/api/rooms", tags=["rooms"])

# How many random codes to try before giving up on creating a room.
_MAX_CODE_ATTEMPTS = 20


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _code_key(settings: Settings) -> str:
    return settings.code_hash_key.get_secret_value()


def _too_many_requests(detail: str, retry_after: int) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS, detail=detail, headers={"Retry-After": str(retry_after)}
    )


def _new_participant(room: Room, display_name: str, now: datetime) -> tuple[Participant, str]:
    token = generate_session_token()
    participant = Participant(
        room=room,
        display_name=display_name,
        token_hash=hash_session_token(token),
        joined_at=now,
        last_seen_at=now,
    )
    return participant, token


def _session_out(room: Room, participant: Participant, code: str, token: str) -> RoomSessionOut:
    return RoomSessionOut(
        room=RoomOut.model_validate(room),
        participant=ParticipantOut.model_validate(participant),
        code=code,
        token=token,
    )


async def _code_is_free(session: AsyncSession, code_hash: str, now: datetime) -> bool:
    """A code is free unless an open room holds it. An active room that has passed its
    expiry is marked expired here, so its code can be reused before cleanup runs."""
    holder = await session.scalar(
        select(Room).where(Room.code_hash == code_hash, Room.status == RoomStatus.ACTIVE)
    )
    if holder is None:
        return True
    if holder.is_open(now):
        return False
    holder.status = RoomStatus.EXPIRED
    await session.flush()
    return True


@router.post("", status_code=status.HTTP_201_CREATED, response_model=RoomSessionOut)
async def create_room(body: CreateRoomRequest, request: Request, session: SessionDep) -> RoomSessionOut:
    settings = _settings(request)
    limiter = request.app.state.room_creations
    ip = client_ip(request)
    if limiter.is_limited(ip):
        raise _too_many_requests("Too many rooms created. Try again later.", settings.room_create_window_seconds)

    lifetime = body.lifetime_minutes or settings.default_room_lifetime_minutes
    if lifetime > settings.max_room_lifetime_minutes:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"lifetime_minutes must be at most {settings.max_room_lifetime_minutes}",
        )
    limiter.hit(ip)

    for _ in range(_MAX_CODE_ATTEMPTS):
        now = utcnow()
        code = generate_room_code()
        code_hash = hash_room_code(code, _code_key(settings))
        if not await _code_is_free(session, code_hash, now):
            continue

        room = Room(
            code_hash=code_hash,
            status=RoomStatus.ACTIVE,
            created_at=now,
            expires_at=now + timedelta(minutes=lifetime),
            last_activity_at=now,
        )
        participant, token = _new_participant(room, body.display_name, now)
        session.add_all([room, participant])
        try:
            await session.commit()
        except IntegrityError:
            # Another request claimed the same code between our check and insert.
            await session.rollback()
            continue
        return _session_out(room, participant, code, token)

    raise HTTPException(
        status.HTTP_503_SERVICE_UNAVAILABLE, detail="No room codes are available right now. Try again shortly."
    )


@router.post("/join", response_model=RoomSessionOut)
async def join_room(body: JoinRoomRequest, request: Request, session: SessionDep) -> RoomSessionOut:
    settings = _settings(request)
    failures = request.app.state.join_failures
    ip = client_ip(request)
    if failures.is_limited(ip):
        raise _too_many_requests(
            "Too many failed attempts. Wait a minute and try again.", settings.failed_join_window_seconds
        )

    now = utcnow()
    # Lock the room row so concurrent joins can't push it past the participant cap.
    room = await session.scalar(
        select(Room)
        .where(Room.code_hash == hash_room_code(body.code, _code_key(settings)), Room.status == RoomStatus.ACTIVE)
        .with_for_update()
    )
    if room is None or not room.is_open(now):
        failures.hit(ip)
        # Same response for unknown and expired codes, so guesses learn nothing extra.
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Invalid or expired room code")

    present = await session.scalar(
        select(func.count())
        .select_from(Participant)
        .where(Participant.room_id == room.id, Participant.left_at.is_(None))
    )
    if present >= settings.max_participants:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="This room is full")

    participant, token = _new_participant(room, body.display_name, now)
    room.last_activity_at = now
    session.add(participant)
    await session.commit()
    return _session_out(room, participant, body.code, token)


@router.get("/{room_id}", response_model=RoomDetailsOut)
async def get_room(me: CurrentParticipant, session: SessionDep) -> RoomDetailsOut:
    participants = await session.scalars(
        select(Participant)
        .where(Participant.room_id == me.room_id, Participant.left_at.is_(None))
        .order_by(Participant.joined_at)
    )
    return RoomDetailsOut(
        room=RoomOut.model_validate(me.room),
        me=ParticipantOut.model_validate(me),
        participants=[ParticipantOut.model_validate(p) for p in participants],
    )


@router.delete("/{room_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_room(me: CurrentParticipant, session: SessionDep) -> Response:
    me.left_at = utcnow()
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
