"""Message replies.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-30
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("reply_to_message_id", sa.Uuid(), nullable=True))
    op.add_column("messages", sa.Column("reply_to_file_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_messages_reply_to_message_id_messages"),
        "messages",
        "messages",
        ["reply_to_message_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        op.f("fk_messages_reply_to_file_id_files"),
        "messages",
        "files",
        ["reply_to_file_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("fk_messages_reply_to_file_id_files"), "messages", type_="foreignkey")
    op.drop_constraint(op.f("fk_messages_reply_to_message_id_messages"), "messages", type_="foreignkey")
    op.drop_column("messages", "reply_to_file_id")
    op.drop_column("messages", "reply_to_message_id")
