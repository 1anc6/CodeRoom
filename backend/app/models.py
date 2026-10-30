import uuid
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Index, MetaData, String, Text, text
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator


def utcnow() -> datetime:
    return datetime.now(UTC)


class UTCDateTime(TypeDecorator[datetime]):
    """Timezone-aware UTC datetimes on every backend.

    PostgreSQL stores timestamptz natively. SQLite (used by the test suite) has no
    timezone support, so values are stored as naive UTC and made aware again on load.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("UTCDateTime requires a timezone-aware datetime")
        value = value.astimezone(UTC)
        return value.replace(tzinfo=None) if dialect.name == "sqlite" else value

    def process_result_value(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value


class RoomStatus(StrEnum):
    ACTIVE = "active"
    EXPIRED = "expired"
    DELETING = "deleting"
    DELETED = "deleted"


class Base(DeclarativeBase):
    metadata = MetaData(
        naming_convention={
            "ix": "ix_%(table_name)s_%(column_0_N_name)s",
            "uq": "uq_%(table_name)s_%(column_0_N_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    code_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default=RoomStatus.ACTIVE)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    last_activity_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    participants: Mapped[list["Participant"]] = relationship(
        back_populates="room", cascade="all, delete-orphan", passive_deletes=True
    )

    __table_args__ = (
        CheckConstraint("status IN ('active', 'expired', 'deleting', 'deleted')", name="status"),
        # A code may be reused once its previous room is no longer active.
        Index(
            "uq_rooms_active_code_hash",
            "code_hash",
            unique=True,
            postgresql_where=text("status = 'active'"),
            sqlite_where=text("status = 'active'"),
        ),
        Index("ix_rooms_status_expires_at", "status", "expires_at"),
    )

    def is_open(self, now: datetime) -> bool:
        """Expiry is enforced on every access, even before the cleanup worker has run."""
        return self.status == RoomStatus.ACTIVE and now < self.expires_at


class Participant(Base):
    __tablename__ = "participants"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    room_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), index=True)
    display_name: Mapped[str] = mapped_column(String(32))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    joined_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    # Set when the participant leaves; their session token stops working from then on.
    left_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    room: Mapped[Room] = relationship(back_populates="participants")


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    room_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"))
    participant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("participants.id", ondelete="CASCADE"))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    # A reply quotes one earlier message or shared file in the same room (at most one of these).
    reply_to_message_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("messages.id", ondelete="SET NULL"))
    reply_to_file_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))

    participant: Mapped[Participant] = relationship()
    reply_to_message: Mapped["Message | None"] = relationship(remote_side="Message.id")
    reply_to_file: Mapped["RoomFile | None"] = relationship()

    __table_args__ = (Index("ix_messages_room_id_created_at", "room_id", "created_at"),)


class RoomFile(Base):
    """Metadata for an uploaded file. The bytes live in file storage under object_key,
    which the server generates and never exposes to clients."""

    __tablename__ = "files"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    room_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), index=True)
    participant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("participants.id", ondelete="CASCADE"))
    object_key: Mapped[str] = mapped_column(String(255), unique=True)
    original_name: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(127))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    participant: Mapped[Participant] = relationship()
