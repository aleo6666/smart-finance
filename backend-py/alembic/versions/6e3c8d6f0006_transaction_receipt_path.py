"""Add transaction receipt_path for invoice/receipt OCR vouchers.

Revision ID: 6e3c8d6f0006
Revises: 5d2b9f7e0005
Create Date: 2026-08-18
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "6e3c8d6f0006"
down_revision: str | None = "5d2b9f7e0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("transactions") as batch_op:
        batch_op.add_column(
            sa.Column("receipt_path", sa.String(length=512), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("transactions") as batch_op:
        batch_op.drop_column("receipt_path")
