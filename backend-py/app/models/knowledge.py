from datetime import datetime

from sqlalchemy import DateTime, Enum, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class KnowledgeDocument(Base):
    __tablename__ = "knowledge_documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(index=True)
    space_id: Mapped[int] = mapped_column(index=True)
    title: Mapped[str] = mapped_column(String(255))
    source_type: Mapped[str] = mapped_column(
        Enum(
            "pdf",
            "txt",
            "audio_transcript",
            "chat_memory",
            "report",
            "seed",
            name="knowledge_source_type",
            native_enum=False,
            create_constraint=True,
        )
    )
    file_path: Mapped[str | None] = mapped_column(String(1024))
    chunk_count: Mapped[int] = mapped_column(default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )
