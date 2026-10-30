"""Files.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-30
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("room_id", sa.Uuid(), nullable=False),
        sa.Column("participant_id", sa.Uuid(), nullable=False),
        sa.Column("object_key", sa.String(length=255), nullable=False),
        sa.Column("original_name", sa.String(length=255), nullable=False),
        sa.Column("mime_type", sa.String(length=127), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["participant_id"],
            ["participants.id"],
            name=op.f("fk_files_participant_id_participants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], name=op.f("fk_files_room_id_rooms"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_files")),
        sa.UniqueConstraint("object_key", name=op.f("uq_files_object_key")),
    )
    op.create_index(op.f("ix_files_room_id"), "files", ["room_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_files_room_id"), table_name="files")
    op.drop_table("files")
