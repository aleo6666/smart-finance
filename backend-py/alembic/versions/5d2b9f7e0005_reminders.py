"""Add reminders for scheduled anomaly alerts.

Revision ID: 5d2b9f7e0005
Revises: 3b8e7c5d0004
Create Date: 2026-08-18
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "5d2b9f7e0005"
down_revision: str | None = "3b8e7c5d0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reminders",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "type", sa.String(length=64), server_default="anomaly", nullable=False
        ),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column(
            "status", sa.String(length=32), server_default="pending", nullable=False
        ),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("read_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_reminders_user_id", "reminders", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_reminders_user_id", table_name="reminders")
    op.drop_table("reminders")
