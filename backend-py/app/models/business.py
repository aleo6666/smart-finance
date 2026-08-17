from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    nickname: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now(), onupdate=func.now()
    )


class Ledger(Base):
    __tablename__ = "ledgers"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    icon: Mapped[str | None] = mapped_column(String(64))
    color: Mapped[str | None] = mapped_column(String(32))
    base_currency: Mapped[str] = mapped_column(
        String(16), default="CNY", server_default="CNY"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint(
            "income_source IS NULL OR income_source IN "
            "('salary', 'bonus', 'part_time', 'investment', 'other')",
            name="ck_transactions_income_source_values",
        ),
        CheckConstraint(
            "type = 'income' OR income_source IS NULL",
            name="ck_transactions_income_source_income_only",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    ledger_id: Mapped[int] = mapped_column(
        ForeignKey("ledgers.id", ondelete="CASCADE")
    )
    type: Mapped[str] = mapped_column(
        Enum(
            "income",
            "expense",
            name="transaction_type",
            native_enum=False,
            create_constraint=True,
        )
    )
    category: Mapped[str] = mapped_column(String(64))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(
        String(16), default="CNY", server_default="CNY"
    )
    note: Mapped[str | None] = mapped_column(Text())
    receipt_path: Mapped[str | None] = mapped_column(String(512))
    income_source: Mapped[str | None] = mapped_column(
        Enum(
            "salary",
            "bonus",
            "part_time",
            "investment",
            "other",
            name="income_source",
            native_enum=False,
            create_constraint=False,
        )
    )
    occurred_at: Mapped[datetime] = mapped_column(DateTime())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )


class Budget(Base):
    __tablename__ = "budgets"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    ledger_id: Mapped[int] = mapped_column(
        ForeignKey("ledgers.id", ondelete="CASCADE")
    )
    category: Mapped[str] = mapped_column(String(64))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    period: Mapped[str] = mapped_column(
        Enum(
            "monthly",
            "yearly",
            name="budget_period",
            native_enum=False,
            create_constraint=True,
        )
    )
    period_start: Mapped[date] = mapped_column(Date())
    period_end: Mapped[date] = mapped_column(Date())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )


class Goal(Base):
    __tablename__ = "goals"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    target_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    current_amount: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), default=Decimal("0.00"), server_default="0.00"
    )
    target_date: Mapped[date] = mapped_column(Date())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )


class Reminder(Base):
    __tablename__ = "reminders"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(index=True)
    type: Mapped[str] = mapped_column(
        String(64), default="anomaly", server_default="anomaly"
    )
    title: Mapped[str] = mapped_column(String(255))
    message: Mapped[str | None] = mapped_column(Text())
    status: Mapped[str] = mapped_column(
        String(32), default="pending", server_default="pending"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime())
