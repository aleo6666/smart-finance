"""Add feature-module tables: investments, subscriptions, tax_records,
insurance_policies, privacy_consents, teams, ledger_members.

Revision ID: d4e5f6a70009
Revises: 9e8d7c6b0008
Create Date: 2026-08-20
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "d4e5f6a70009"
down_revision: str | None = "9e8d7c6b0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "investments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("symbol", sa.String(length=32), nullable=True),
        sa.Column(
            "type",
            sa.Enum(
                "fund",
                "stock",
                "bond",
                "gold",
                "crypto",
                "other",
                name="investment_type",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("quantity", sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column("cost_price", sa.Numeric(precision=12, scale=4), nullable=False),
        sa.Column("current_price", sa.Numeric(precision=12, scale=4), nullable=True),
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
    op.create_index("ix_investments_user_id", "investments", ["user_id"])

    op.create_table(
        "subscriptions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=True),
        sa.Column("amount", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column(
            "billing_cycle",
            sa.Enum(
                "monthly",
                "quarterly",
                "yearly",
                name="billing_cycle",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("next_billing_date", sa.Date(), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "active",
                "paused",
                "cancelled",
                name="subscription_status",
                native_enum=False,
                create_constraint=True,
            ),
            server_default="active",
            nullable=False,
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_subscriptions_user_id", "subscriptions", ["user_id"])

    op.create_table(
        "tax_records",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("month", sa.Integer(), nullable=False),
        sa.Column("income", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column(
            "bonus",
            sa.Numeric(precision=12, scale=2),
            server_default="0.00",
            nullable=False,
        ),
        sa.Column(
            "social_insurance",
            sa.Numeric(precision=12, scale=2),
            server_default="0.00",
            nullable=False,
        ),
        sa.Column(
            "special_deduction",
            sa.Numeric(precision=12, scale=2),
            server_default="0.00",
            nullable=False,
        ),
        sa.Column("taxable_income", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("tax_amount", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("net_income", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tax_records_user_id", "tax_records", ["user_id"])

    op.create_table(
        "insurance_policies",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column(
            "type",
            sa.Enum(
                "人寿",
                "医疗",
                "重疾",
                "意外",
                "财产",
                "其他",
                name="insurance_type",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("company", sa.String(length=128), nullable=True),
        sa.Column("policy_number", sa.String(length=64), nullable=True),
        sa.Column("holder", sa.String(length=64), nullable=True),
        sa.Column("insured_amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("annual_premium", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column(
            "payment_frequency",
            sa.Enum(
                "yearly",
                "quarterly",
                "monthly",
                "one_time",
                name="premium_frequency",
                native_enum=False,
                create_constraint=True,
            ),
            server_default="yearly",
            nullable=False,
        ),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "active",
                "expired",
                "cancelled",
                name="policy_status",
                native_enum=False,
                create_constraint=True,
            ),
            server_default="active",
            nullable=False,
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_insurance_policies_user_id", "insurance_policies", ["user_id"])

    op.create_table(
        "privacy_consents",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("consent_type", sa.String(length=64), nullable=False),
        sa.Column("version", sa.String(length=32), nullable=False),
        sa.Column("granted", sa.Boolean(), server_default="1", nullable=False),
        sa.Column(
            "granted_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_privacy_consents_user_id", "privacy_consents", ["user_id"])

    op.create_table(
        "teams",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column("invite_code", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("invite_code"),
    )
    op.create_index("ix_teams_owner_id", "teams", ["owner_id"])

    op.create_table(
        "ledger_members",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("team_id", sa.Integer(), nullable=False),
        sa.Column("ledger_id", sa.Integer(), nullable=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "role",
            sa.Enum(
                "owner",
                "member",
                name="ledger_member_role",
                native_enum=False,
                create_constraint=True,
            ),
            server_default="member",
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["ledger_id"], ["ledgers.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["team_id"], ["teams.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ledger_members_team_id", "ledger_members", ["team_id"])
    op.create_index("ix_ledger_members_ledger_id", "ledger_members", ["ledger_id"])
    op.create_index("ix_ledger_members_user_id", "ledger_members", ["user_id"])


def downgrade() -> None:
    op.drop_table("ledger_members")
    op.drop_table("teams")
    op.drop_table("privacy_consents")
    op.drop_table("insurance_policies")
    op.drop_table("tax_records")
    op.drop_table("subscriptions")
    op.drop_table("investments")
