"""Rooms and participants.

Revision ID: 0001
Revises:
Create Date: 2026-10-30
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "rooms",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('active', 'expired', 'deleting', 'deleted')", name=op.f("ck_rooms_status")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_rooms")),
    )
    op.create_index(
        "uq_rooms_active_code_hash",
        "rooms",
        ["code_hash"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
        sqlite_where=sa.text("status = 'active'"),
    )
    op.create_index("ix_rooms_status_expires_at", "rooms", ["status", "expires_at"])

    op.create_table(
        "participants",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("room_id", sa.Uuid(), nullable=False),
        sa.Column("display_name", sa.String(length=32), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["room_id"], ["rooms.id"], name=op.f("fk_participants_room_id_rooms"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_participants")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_participants_token_hash")),
    )
    op.create_index(op.f("ix_participants_room_id"), "participants", ["room_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_participants_room_id"), table_name="participants")
    op.drop_table("participants")
    op.drop_index("ix_rooms_status_expires_at", table_name="rooms")
    op.drop_index("uq_rooms_active_code_hash", table_name="rooms")
    op.drop_table("rooms")
