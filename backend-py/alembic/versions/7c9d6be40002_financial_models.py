"""Add financial models and transaction income source.

Revision ID: 7c9d6be40002
Revises: 28f4157e0001
Create Date: 2026-08-18
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "7c9d6be40002"
down_revision: str | None = "28f4157e0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "assets",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "type",
            sa.Enum(
                "cash",
                "bank_deposit",
                "investment",
                "property",
                "vehicle",
                "other",
                name="asset_type",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("amount", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column(
            "currency", sa.String(length=16), server_default="CNY", nullable=False
        ),
        sa.Column("acquired_date", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_assets_user_id", "assets", ["user_id"])

    op.create_table(
        "liabilities",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "type",
            sa.Enum(
                "credit_card",
                "loan",
                "mortgage",
                "other",
                name="liability_type",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("amount", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("interest_rate", sa.Numeric(precision=5, scale=4), nullable=True),
        sa.Column(
            "monthly_payment", sa.Numeric(precision=12, scale=2), nullable=True
        ),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_liabilities_user_id", "liabilities", ["user_id"])

    op.create_table(
        "user_profiles",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("age", sa.Integer(), nullable=True),
        sa.Column("occupation", sa.String(length=128), nullable=True),
        sa.Column("income_range", sa.String(length=64), nullable=True),
        sa.Column("marital_status", sa.String(length=32), nullable=True),
        sa.Column("children", sa.Integer(), server_default="0", nullable=False),
        sa.Column("dependents", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "risk_preference",
            sa.Enum(
                "保守",
                "稳健",
                "进取",
                "激进",
                name="risk_preference",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=True,
        ),
        sa.Column("financial_goals", sa.JSON(), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_user_profiles_user_id", "user_profiles", ["user_id"], unique=True
    )

    with op.batch_alter_table("transactions") as batch_op:
        batch_op.add_column(
            sa.Column(
                "income_source",
                sa.Enum(
                    "salary",
                    "bonus",
                    "part_time",
                    "investment",
                    "other",
                    name="income_source",
                    native_enum=False,
                    create_constraint=False,
                ),
                nullable=True,
            )
        )
        batch_op.create_check_constraint(
            "ck_transactions_income_source_values",
            "income_source IS NULL OR income_source IN "
            "('salary', 'bonus', 'part_time', 'investment', 'other')",
        )
        batch_op.create_check_constraint(
            "ck_transactions_income_source_income_only",
            "type = 'income' OR income_source IS NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("transactions") as batch_op:
        batch_op.drop_constraint(
            "ck_transactions_income_source_income_only", type_="check"
        )
        batch_op.drop_constraint(
            "ck_transactions_income_source_values", type_="check"
        )
        batch_op.drop_column("income_source")
    op.drop_index("ix_user_profiles_user_id", table_name="user_profiles")
    op.drop_table("user_profiles")
    op.drop_index("ix_liabilities_user_id", table_name="liabilities")
    op.drop_table("liabilities")
    op.drop_index("ix_assets_user_id", table_name="assets")
    op.drop_table("assets")
