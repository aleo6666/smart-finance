from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import JSON, Date, DateTime, Enum, ForeignKey, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[str] = mapped_column(
        Enum(
            "cash",
            "bank_deposit",
            "investment",
            "property",
            "vehicle",
            "other",
            name="asset_type",
            native_enum=False,
            create_constraint=True,
        )
    )
    name: Mapped[str] = mapped_column(String(128))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(
        String(16), default="CNY", server_default="CNY"
    )
    acquired_date: Mapped[date | None] = mapped_column(Date())
    notes: Mapped[str | None] = mapped_column(Text())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )


class Liability(Base):
    __tablename__ = "liabilities"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[str] = mapped_column(
        Enum(
            "credit_card",
            "loan",
            "mortgage",
            "other",
            name="liability_type",
            native_enum=False,
            create_constraint=True,
        )
    )
    name: Mapped[str] = mapped_column(String(128))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    interest_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 4))
    monthly_payment: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    due_date: Mapped[date | None] = mapped_column(Date())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )


class UserProfile(Base):
    __tablename__ = "user_profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    age: Mapped[int | None]
    occupation: Mapped[str | None] = mapped_column(String(128))
    income_range: Mapped[str | None] = mapped_column(String(64))
    marital_status: Mapped[str | None] = mapped_column(String(32))
    children: Mapped[int] = mapped_column(default=0, server_default="0")
    dependents: Mapped[int] = mapped_column(default=0, server_default="0")
    risk_preference: Mapped[str | None] = mapped_column(
        Enum(
            "保守",
            "稳健",
            "进取",
            "激进",
            name="risk_preference",
            native_enum=False,
            create_constraint=True,
        )
    )
    financial_goals: Mapped[list[str] | dict | None] = mapped_column(JSON())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now(), onupdate=func.now()
    )
