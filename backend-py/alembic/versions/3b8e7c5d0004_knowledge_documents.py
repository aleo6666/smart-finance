"""Add knowledge documents.

Revision ID: 3b8e7c5d0004
Revises: 9d1f6a2b0003
Create Date: 2026-08-18
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "3b8e7c5d0004"
down_revision: str | None = "9d1f6a2b0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "knowledge_documents",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("space_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column(
            "source_type",
            sa.Enum(
                "pdf",
                "txt",
                "audio_transcript",
                "chat_memory",
                "report",
                "seed",
                name="knowledge_source_type",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("file_path", sa.String(length=1024), nullable=True),
        sa.Column("chunk_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_knowledge_documents_space_id",
        "knowledge_documents",
        ["space_id"],
    )
    op.create_index(
        "ix_knowledge_documents_user_id",
        "knowledge_documents",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_knowledge_documents_user_id", table_name="knowledge_documents"
    )
    op.drop_index(
        "ix_knowledge_documents_space_id", table_name="knowledge_documents"
    )
    op.drop_table("knowledge_documents")
