from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    report_type: Mapped[str] = mapped_column(String(32))
    period: Mapped[str] = mapped_column(String(16))
    content: Mapped[dict] = mapped_column(JSON())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )
