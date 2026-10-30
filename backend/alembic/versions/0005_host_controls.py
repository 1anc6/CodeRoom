"""Host controls: who opened a room, and whether it's locked.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-31
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("rooms", sa.Column("locked", sa.Boolean(), server_default=sa.text("false"), nullable=False))
    op.add_column("participants", sa.Column("is_host", sa.Boolean(), server_default=sa.text("false"), nullable=False))


def downgrade() -> None:
    op.drop_column("participants", "is_host")
    op.drop_column("rooms", "locked")
