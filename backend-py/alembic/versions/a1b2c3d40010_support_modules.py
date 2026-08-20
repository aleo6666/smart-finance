"""Add legacy-parity tables: exchange_rates, feedback, import_batches,
import_records (汇率看板 / 用户反馈 / 账单批量导入，对齐旧 Node 后端三模块).

Revision ID: a1b2c3d40010
Revises: d4e5f6a70009
Create Date: 2026-08-20
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "a1b2c3d40010"
down_revision: str | None = "d4e5f6a70009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "exchange_rates",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("base", sa.String(length=8), server_default="CNY", nullable=False),
        sa.Column("currency", sa.String(length=16), nullable=False),
        sa.Column("rate", sa.Numeric(precision=14, scale=8), nullable=False),
        sa.Column("fetched_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_exchange_rates_currency", "exchange_rates", ["currency"])
    op.create_index("ix_exchange_rates_fetched_at", "exchange_rates", ["fetched_at"])

    op.create_table(
        "feedback",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "type", sa.String(length=32), server_default="suggestion", nullable=False
        ),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("image_path", sa.String(length=512), nullable=True),
        sa.Column("priority", sa.String(length=8), server_default="P2", nullable=False),
        sa.Column(
            "status", sa.String(length=32), server_default="pending", nullable=False
        ),
        sa.Column("admin_reply", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_feedback_user_id", "feedback", ["user_id"])

    op.create_table(
        "import_batches",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("ledger_id", sa.Integer(), nullable=True),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column(
            "file_name", sa.String(length=255), server_default="", nullable=False
        ),
        sa.Column("total_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("valid_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("duplicate_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("imported_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "preview",
                "imported",
                "rolled_back",
                name="import_batch_status",
                native_enum=False,
                create_constraint=True,
            ),
            server_default="preview",
            nullable=False,
        ),
        sa.Column("preview_data", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("imported_at", sa.DateTime(), nullable=True),
        sa.Column("rolled_back_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["ledger_id"], ["ledgers.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_import_batches_user_id", "import_batches", ["user_id"])

    op.create_table(
        "import_records",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("batch_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("original_row", sa.Text(), nullable=True),
        sa.Column("mapped_type", sa.String(length=16), nullable=False),
        sa.Column("mapped_amount", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("mapped_category", sa.String(length=64), nullable=False),
        sa.Column("mapped_date", sa.String(length=16), nullable=False),
        sa.Column("mapped_description", sa.Text(), nullable=True),
        sa.Column("mapped_merchant", sa.String(length=255), nullable=True),
        sa.Column(
            "status", sa.String(length=16), server_default="pending", nullable=False
        ),
        sa.Column("is_duplicate", sa.Boolean(), server_default="0", nullable=False),
        sa.Column(
            "duplicate_similarity",
            sa.Numeric(precision=6, scale=4),
            server_default="0",
            nullable=False,
        ),
        sa.Column("duplicate_of_record_id", sa.Integer(), nullable=True),
        sa.Column("selected", sa.Boolean(), server_default="1", nullable=False),
        sa.Column("record_id", sa.Integer(), nullable=True),
        sa.Column("imported_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["batch_id"], ["import_batches.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_import_records_batch_id", "import_records", ["batch_id"])
    op.create_index("ix_import_records_user_id", "import_records", ["user_id"])


def downgrade() -> None:
    op.drop_table("import_records")
    op.drop_table("import_batches")
    op.drop_table("feedback")
    op.drop_table("exchange_rates")
