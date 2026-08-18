"""Add conversation memory tables (L1 history + L3 rolling summary).

Revision ID: 7f5d1a8e0007
Revises: 6e3c8d6f0006
Create Date: 2026-08-19
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "7f5d1a8e0007"
down_revision: str | None = "6e3c8d6f0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "conversation_messages",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "role",
            sa.Enum(
                "user",
                "assistant",
                name="conv_role",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_conversation_messages_created_at",
        "conversation_messages",
        ["created_at"],
    )
    op.create_index(
        "ix_conversation_messages_user_id",
        "conversation_messages",
        ["user_id"],
    )

    op.create_table(
        "conversation_summaries",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("covered_until_id", sa.Integer(), nullable=False),
        sa.Column("covered_count", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_conversation_summaries_user_id",
        "conversation_summaries",
        ["user_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_conversation_summaries_user_id", table_name="conversation_summaries"
    )
    op.drop_table("conversation_summaries")
    op.drop_index(
        "ix_conversation_messages_created_at", table_name="conversation_messages"
    )
    op.drop_index(
        "ix_conversation_messages_user_id", table_name="conversation_messages"
    )
    op.drop_table("conversation_messages")
