"""Add transaction idempotency_key for write deduplication.

Revision ID: 9e8d7c6b0008
Revises: 7f5d1a8e0007
Create Date: 2026-08-20
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "9e8d7c6b0008"
down_revision: str | None = "7f5d1a8e0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("transactions") as batch_op:
        batch_op.add_column(
            sa.Column("idempotency_key", sa.String(length=64), nullable=True)
        )
    op.create_index(
        "ix_transactions_idempotency_key",
        "transactions",
        ["idempotency_key"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_transactions_idempotency_key", table_name="transactions"
    )
    with op.batch_alter_table("transactions") as batch_op:
        batch_op.drop_column("idempotency_key")
