"""Expired-room cleanup (blueprint section 8).

Each run:
1. Revoke: active rooms past their expiry (and rooms already marked expired) become `deleting`.
   Access checks only admit `active` rooms, so this blocks everything at once.
2. Purge each `deleting` room: delete its stored objects, then its files, messages and
   participants, then mark it `deleted`. If storage deletion fails the room stays `deleting`
   and the next run retries; every step is safe to repeat.

Reconcile (less often) removes stored objects the database doesn't account for: leftovers of
deleted rooms, uploads that were interrupted before being recorded, and abandoned partial writes.

Run it inside the API (the default), or on a schedule:  python -m app.cleanup [--reconcile] [--loop]
"""

import argparse
import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import and_, delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings, get_settings
from app.db import create_engine, create_sessionmaker
from app.models import Message, Participant, Room, RoomFile, RoomStatus, utcnow
from app.storage import FileStorage, StoredObject, create_storage, room_prefix

logger = logging.getLogger("coderoom.cleanup")


@dataclass
class CleanupResult:
    revoked: int = 0  # rooms newly closed this run
    deleted: int = 0  # rooms fully purged this run
    failed: int = 0  # rooms left `deleting`, to be retried next run


async def revoke_expired_rooms(session: AsyncSession, now: datetime) -> int:
    result = await session.execute(
        update(Room)
        .where(
            or_(
                and_(Room.status == RoomStatus.ACTIVE, Room.expires_at <= now),
                Room.status == RoomStatus.EXPIRED,
            )
        )
        .values(status=RoomStatus.DELETING)
        .execution_options(synchronize_session=False)
    )
    await session.commit()
    return result.rowcount


async def purge_room(sessionmaker: async_sessionmaker[AsyncSession], storage: FileStorage, room_id: uuid.UUID) -> bool:
    """Delete one `deleting` room's objects and records. Returns False if there was nothing to do
    (already purged, or another worker holds it). Raises if storage deletion fails."""
    async with sessionmaker() as session:
        # SKIP LOCKED lets several workers run at once without purging the same room twice.
        room = await session.scalar(
            select(Room)
            .where(Room.id == room_id, Room.status == RoomStatus.DELETING)
            .with_for_update(skip_locked=True)
        )
        if room is None:
            return False

        # Objects first: if this fails, the records that point at them are still there to retry with.
        await storage.delete_prefix(room_prefix(room.id))
        for model in (RoomFile, Message, Participant):
            await session.execute(delete(model).where(model.room_id == room.id))
        # The room row stays as a tombstone: id, code hash, timestamps and status, nothing personal.
        room.status = RoomStatus.DELETED
        await session.commit()
        return True


async def run_cleanup(
    sessionmaker: async_sessionmaker[AsyncSession], storage: FileStorage, batch_size: int
) -> CleanupResult:
    result = CleanupResult()
    async with sessionmaker() as session:
        result.revoked = await revoke_expired_rooms(session, utcnow())

    skipped: set[uuid.UUID] = set()
    while result.deleted + result.failed < batch_size:
        async with sessionmaker() as session:
            room_id = await session.scalar(
                select(Room.id)
                .where(Room.status == RoomStatus.DELETING, Room.id.not_in(skipped))
                .order_by(Room.expires_at)
                .limit(1)
            )
        if room_id is None:
            break
        try:
            if await purge_room(sessionmaker, storage, room_id):
                result.deleted += 1
            else:
                skipped.add(room_id)
        except Exception:
            logger.exception("Could not delete room %s; it stays revoked and will be retried", room_id)
            result.failed += 1
            skipped.add(room_id)

    if result.revoked or result.deleted or result.failed:
        logger.info(
            "Cleanup: %d rooms revoked, %d deleted, %d to retry", result.revoked, result.deleted, result.failed
        )
    return result


def _room_id_of(key: str) -> uuid.UUID | None:
    parts = key.split("/")
    try:
        return uuid.UUID(parts[1]) if len(parts) >= 3 and parts[0] == "rooms" else None
    except ValueError:
        return None


async def reconcile_storage(
    sessionmaker: async_sessionmaker[AsyncSession], storage: FileStorage, grace: timedelta
) -> int:
    """Delete stored objects that no live file record accounts for. Returns how many were removed."""
    objects = await storage.list_objects("rooms/")
    by_room: dict[uuid.UUID, list[StoredObject]] = {}
    for obj in objects:
        room_id = _room_id_of(obj.key)
        if room_id is not None:
            by_room.setdefault(room_id, []).append(obj)
    if not by_room:
        return 0

    async with sessionmaker() as session:
        room_ids = list(by_room)
        statuses = dict((await session.execute(select(Room.id, Room.status).where(Room.id.in_(room_ids)))).all())
        known_keys = set(await session.scalars(select(RoomFile.object_key).where(RoomFile.room_id.in_(room_ids))))

    cutoff = utcnow() - grace
    removed = 0
    for room_id, room_objects in by_room.items():
        status = statuses.get(room_id)
        if status == RoomStatus.DELETING:
            continue  # the purge step owns it
        if status is None or status == RoomStatus.DELETED:
            await storage.delete_prefix(room_prefix(room_id))
            removed += len(room_objects)
            continue
        for obj in room_objects:
            # Recent unknown objects may be uploads that haven't been recorded yet.
            if obj.key not in known_keys and obj.modified_at < cutoff:
                await storage.delete(obj.key)
                removed += 1

    if removed:
        logger.info("Reconcile: removed %d stray stored objects", removed)
    return removed


class CleanupWorker:
    """Runs cleanup on an interval, and reconcile on a longer one, until cancelled."""

    def __init__(
        self, sessionmaker: async_sessionmaker[AsyncSession], storage: FileStorage, settings: Settings
    ) -> None:
        self.sessionmaker = sessionmaker
        self.storage = storage
        self.settings = settings

    async def run_forever(self) -> None:
        last_reconcile: float | None = None
        while True:
            # A failed run must never stop the worker; the next run retries.
            try:
                await run_cleanup(self.sessionmaker, self.storage, self.settings.cleanup_batch_size)
            except Exception:
                logger.exception("Cleanup run failed")
            if last_reconcile is None or time.monotonic() - last_reconcile >= self.settings.reconcile_interval_seconds:
                last_reconcile = time.monotonic()
                try:
                    await reconcile_storage(
                        self.sessionmaker, self.storage, timedelta(seconds=self.settings.orphan_grace_seconds)
                    )
                except Exception:
                    logger.exception("Reconcile run failed")
            await asyncio.sleep(self.settings.cleanup_interval_seconds)


async def run_once(settings: Settings, reconcile: bool = False) -> CleanupResult:
    engine = create_engine(settings.database_url)
    try:
        sessionmaker = create_sessionmaker(engine)
        storage = create_storage(settings)
        result = await run_cleanup(sessionmaker, storage, settings.cleanup_batch_size)
        if reconcile:
            await reconcile_storage(sessionmaker, storage, timedelta(seconds=settings.orphan_grace_seconds))
        return result
    finally:
        await engine.dispose()


async def _run_loop(settings: Settings) -> None:
    engine = create_engine(settings.database_url)
    try:
        await CleanupWorker(create_sessionmaker(engine), create_storage(settings), settings).run_forever()
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cleanup", description="Delete expired CodeRoom rooms.")
    parser.add_argument("--reconcile", action="store_true", help="also remove stray stored objects")
    parser.add_argument("--loop", action="store_true", help="keep running on the configured intervals")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    if args.loop:
        with contextlib.suppress(KeyboardInterrupt):
            asyncio.run(_run_loop(settings))
    else:
        result = asyncio.run(run_once(settings, reconcile=args.reconcile))
        print(f"{result.revoked} rooms revoked, {result.deleted} deleted, {result.failed} to retry")


if __name__ == "__main__":
    main()
