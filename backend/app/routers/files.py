"""File upload, listing and download.

Uploads are the raw file bytes as the request body (not multipart), with the name in the
`name` query parameter. That lets the server stream straight to storage, check the type from
the first bytes, and stop reading the moment a size limit is crossed.
"""

import uuid
from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload
from starlette.requests import ClientDisconnect

from app.config import Settings
from app.deps import CurrentParticipant, SessionDep
from app.file_types import (
    SNIFF_BYTES,
    FileType,
    clean_filename,
    content_disposition,
    detect,
    with_matching_extension,
)
from app.models import Participant, Room, RoomFile, utcnow
from app.realtime import RoomHub, event
from app.schemas import FileListOut, FileOut
from app.storage import FileStorage

router = APIRouter(prefix="/api/rooms", tags=["files"])

_LIST_LIMIT = 200


class _Rejected(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail


@dataclass
class _Inspection:
    """Filled in while the upload streams through _inspect."""

    filename: str
    max_bytes: int
    too_large_detail: str
    file_type: FileType | None = None
    size: int = 0


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _storage(request: Request) -> FileStorage:
    return request.app.state.storage


def _hub(request: Request) -> RoomHub:
    return request.app.state.hub


def file_out(record: RoomFile) -> FileOut:
    return FileOut(
        id=record.id,
        participant_id=record.participant_id,
        display_name=record.participant.display_name,
        name=record.original_name,
        mime_type=record.mime_type,
        size_bytes=record.size_bytes,
        created_at=record.created_at,
    )


async def _room_usage(session: AsyncSession, room_id: uuid.UUID) -> int:
    used = await session.scalar(
        select(func.coalesce(func.sum(RoomFile.size_bytes), 0)).where(
            RoomFile.room_id == room_id, RoomFile.deleted_at.is_(None)
        )
    )
    return int(used)


def _identify(head: bytes, inspection: _Inspection) -> FileType:
    file_type = detect(head, inspection.filename)
    if file_type is None:
        raise _Rejected(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Only images, PDFs, documents (Word, Excel, PowerPoint, OpenDocument, text) and videos can be shared",
        )
    return file_type


async def _inspect(request: Request, inspection: _Inspection):
    """Pass the body through, enforcing the size limit and checking the type before any
    bytes beyond the first SNIFF_BYTES are written."""
    head = b""
    async for chunk in request.stream():
        if not chunk:
            continue
        inspection.size += len(chunk)
        if inspection.size > inspection.max_bytes:
            raise _Rejected(status.HTTP_413_CONTENT_TOO_LARGE, inspection.too_large_detail)
        if inspection.file_type is None:
            head += chunk
            if len(head) < SNIFF_BYTES:
                continue
            inspection.file_type = _identify(head, inspection)
            chunk, head = head, b""
        yield chunk

    if inspection.file_type is None:
        if not head:
            raise _Rejected(status.HTTP_422_UNPROCESSABLE_CONTENT, "File is empty")
        inspection.file_type = _identify(head, inspection)
        yield head


@router.post("/{room_id}/files", status_code=status.HTTP_201_CREATED, response_model=FileOut)
async def upload_file(
    me: CurrentParticipant,
    request: Request,
    session: SessionDep,
    name: Annotated[str, Query(min_length=1, max_length=255, description="The file's original name.")],
) -> FileOut:
    settings = _settings(request)
    limiter = request.app.state.uploads
    if limiter.is_limited(str(me.id)):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many uploads. Wait a moment and try again.",
            headers={"Retry-After": str(settings.upload_rate_window_seconds)},
        )
    limiter.hit(str(me.id))

    max_file_mb = settings.max_file_size_bytes // (1024 * 1024)
    too_large = f"Files can be at most {max_file_mb} MB"
    room_full = "This room has run out of space for files"
    remaining = settings.max_room_storage_bytes - await _room_usage(session, me.room_id)
    if remaining <= 0:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, detail=room_full)

    # Reject early from the declared size when we can; the streamed size is enforced regardless.
    declared = request.headers.get("content-length", "")
    if declared.isdigit():
        if int(declared) > settings.max_file_size_bytes:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, detail=too_large)
        if int(declared) > remaining:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, detail=room_full)

    inspection = _Inspection(
        filename=clean_filename(name),
        max_bytes=min(settings.max_file_size_bytes, remaining),
        too_large_detail=too_large if settings.max_file_size_bytes <= remaining else room_full,
    )
    storage = _storage(request)
    # A random key: the client's file name never reaches the storage path.
    key = f"rooms/{me.room_id}/{uuid.uuid4().hex}"
    try:
        await storage.save(key, _inspect(request, inspection))
    except _Rejected as rejected:
        raise HTTPException(rejected.status_code, detail=rejected.detail) from None
    except ClientDisconnect:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Upload was interrupted") from None

    try:
        record = await _record_upload(session, settings, me, key, inspection)
    except BaseException:
        await storage.delete(key)
        raise

    result = file_out(record)
    await _hub(request).broadcast(me.room_id, event("file.ready", file=result.model_dump(mode="json")))
    return result


async def _record_upload(
    session: AsyncSession, settings: Settings, me: Participant, key: str, inspection: _Inspection
) -> RoomFile:
    """Save the file's metadata, re-checking access and the room quota now that the upload is done.
    The room row is locked so concurrent uploads can't overshoot the quota together."""
    room = await session.scalar(
        select(Room).where(Room.id == me.room_id).with_for_update().execution_options(populate_existing=True)
    )
    await session.refresh(me)
    now = utcnow()
    if me.left_at is not None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Missing or invalid room session")
    if room is None or not room.is_open(now):
        raise HTTPException(status.HTTP_410_GONE, detail="This room has expired")
    if await _room_usage(session, room.id) + inspection.size > settings.max_room_storage_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, detail="This room has run out of space for files")

    assert inspection.file_type is not None
    record = RoomFile(
        room_id=room.id,
        participant=me,
        object_key=key,
        original_name=with_matching_extension(inspection.filename, inspection.file_type),
        mime_type=inspection.file_type.mime,
        size_bytes=inspection.size,
        created_at=now,
    )
    room.last_activity_at = now
    session.add(record)
    await session.commit()
    return record


@router.get("/{room_id}/files", response_model=FileListOut)
async def list_files(me: CurrentParticipant, session: SessionDep) -> FileListOut:
    """The room's newest files, oldest first."""
    rows = list(
        await session.scalars(
            select(RoomFile)
            .options(joinedload(RoomFile.participant))
            .where(RoomFile.room_id == me.room_id, RoomFile.deleted_at.is_(None))
            .order_by(RoomFile.created_at.desc(), RoomFile.id.desc())
            .limit(_LIST_LIMIT + 1)
        )
    )
    has_more = len(rows) > _LIST_LIMIT
    rows = rows[:_LIST_LIMIT]
    rows.reverse()
    return FileListOut(files=[file_out(r) for r in rows], has_more=has_more)


@router.get("/{room_id}/files/{file_id}")
async def download_file(
    file_id: uuid.UUID, me: CurrentParticipant, request: Request, session: SessionDep
) -> StreamingResponse:
    # Scoped to the caller's room: a file id alone never grants access.
    record = await session.scalar(
        select(RoomFile).where(
            RoomFile.id == file_id, RoomFile.room_id == me.room_id, RoomFile.deleted_at.is_(None)
        )
    )
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="File not found")
    try:
        chunks = await _storage(request).open(record.object_key)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="File not found") from None

    media_type = record.mime_type + ("; charset=utf-8" if record.mime_type.startswith("text/") else "")
    return StreamingResponse(
        chunks,
        media_type=media_type,
        headers={
            "Content-Length": str(record.size_bytes),
            "Content-Disposition": content_disposition(record.original_name),
            "X-Content-Type-Options": "nosniff",
            # If someone opens the URL directly, nothing in the file can run as a page.
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cache-Control": "private, no-store",
        },
    )
