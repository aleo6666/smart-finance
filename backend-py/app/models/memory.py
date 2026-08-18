from datetime import datetime

from sqlalchemy import DateTime, Enum, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ConversationMessage(Base):
    __tablename__ = "conversation_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(index=True)  # 强制隔离键
    role: Mapped[str] = mapped_column(
        Enum(
            "user",
            "assistant",
            name="conv_role",
            native_enum=False,
            create_constraint=True,
        )
    )
    content: Mapped[str] = mapped_column(Text)  # 纯文本，不存 tool_calls
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now(), index=True
    )


class ConversationSummary(Base):
    __tablename__ = "conversation_summaries"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        index=True, unique=True
    )  # 每用户一条滚动摘要
    summary: Mapped[str] = mapped_column(Text)
    covered_until_id: Mapped[int] = mapped_column(default=0)  # 已覆盖到的最大消息 id（增量锚点）
    covered_count: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now(), onupdate=func.now()
    )
