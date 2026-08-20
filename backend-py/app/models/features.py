"""Feature-module models: investments, subscriptions, tax, insurance,
privacy consents and family sharing.

All money/price columns are Numeric to preserve decimal precision;
enums use native_enum=False so MySQL stores portable VARCHAR values.
"""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
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


class Investment(Base):
    __tablename__ = "investments"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    symbol: Mapped[str | None] = mapped_column(String(32))
    type: Mapped[str] = mapped_column(
        Enum(
            "fund",
            "stock",
            "bond",
            "gold",
            "crypto",
            "other",
            name="investment_type",
            native_enum=False,
            create_constraint=True,
        )
    )
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    cost_price: Mapped[Decimal] = mapped_column(Numeric(12, 4))
    current_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    currency: Mapped[str] = mapped_column(
        String(16), default="CNY", server_default="CNY"
    )
    acquired_date: Mapped[date | None] = mapped_column(Date())
    notes: Mapped[str | None] = mapped_column(Text())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )


class Subscription(Base):
    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    category: Mapped[str | None] = mapped_column(String(64))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    billing_cycle: Mapped[str] = mapped_column(
        Enum(
            "monthly",
            "quarterly",
            "yearly",
            name="billing_cycle",
            native_enum=False,
            create_constraint=True,
        )
    )
    next_billing_date: Mapped[date] = mapped_column(Date())
    status: Mapped[str] = mapped_column(
        Enum(
            "active",
            "paused",
            "cancelled",
            name="subscription_status",
            native_enum=False,
            create_constraint=True,
        ),
        default="active",
        server_default="active",
    )
    notes: Mapped[str | None] = mapped_column(Text())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )


class TaxRecord(Base):
    __tablename__ = "tax_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    year: Mapped[int] = mapped_column()
    month: Mapped[int] = mapped_column()
    income: Mapped[Decimal] = mapped_column(Numeric(12, 2))  # 月度税前工资
    bonus: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), default=Decimal("0"), server_default="0.00"
    )  # 年终奖/一次性奖金（单独计税简化）
    social_insurance: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), default=Decimal("0"), server_default="0.00"
    )  # 五险一金个人缴纳
    special_deduction: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), default=Decimal("0"), server_default="0.00"
    )  # 专项附加扣除（累计）
    taxable_income: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    tax_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    net_income: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )


class InsurancePolicy(Base):
    __tablename__ = "insurance_policies"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    type: Mapped[str] = mapped_column(
        Enum(
            "人寿",
            "医疗",
            "重疾",
            "意外",
            "财产",
            "其他",
            name="insurance_type",
            native_enum=False,
            create_constraint=True,
        )
    )
    company: Mapped[str | None] = mapped_column(String(128))
    policy_number: Mapped[str | None] = mapped_column(String(64))
    holder: Mapped[str | None] = mapped_column(String(64))  # 被保人
    insured_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    annual_premium: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    payment_frequency: Mapped[str] = mapped_column(
        Enum(
            "yearly",
            "quarterly",
            "monthly",
            "one_time",
            name="premium_frequency",
            native_enum=False,
            create_constraint=True,
        ),
        default="yearly",
        server_default="yearly",
    )
    start_date: Mapped[date | None] = mapped_column(Date())
    end_date: Mapped[date | None] = mapped_column(Date())
    status: Mapped[str] = mapped_column(
        Enum(
            "active",
            "expired",
            "cancelled",
            name="policy_status",
            native_enum=False,
            create_constraint=True,
        ),
        default="active",
        server_default="active",
    )
    notes: Mapped[str | None] = mapped_column(Text())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )


class PrivacyConsent(Base):
    __tablename__ = "privacy_consents"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    consent_type: Mapped[str] = mapped_column(String(64))  # privacy_policy / data_analysis
    version: Mapped[str] = mapped_column(String(32))
    granted: Mapped[bool] = mapped_column(default=True, server_default="1")
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime())


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    invite_code: Mapped[str] = mapped_column(String(16), unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )


class LedgerMember(Base):
    """A team's member (ledger_id NULL) or a ledger shared to a team.

    ``(team_id, user_id)`` is unique; sharing a ledger adds rows with the
    same pair plus a non-NULL ledger_id (one row per shared ledger).
    """

    __tablename__ = "ledger_members"
    __table_args__ = (
        # 成员唯一（含 owner）；账本共享不受此约束
        None,
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(
        ForeignKey("teams.id", ondelete="CASCADE"), index=True
    )
    ledger_id: Mapped[int | None] = mapped_column(
        ForeignKey("ledgers.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(
        Enum(
            "owner",
            "member",
            name="ledger_member_role",
            native_enum=False,
            create_constraint=True,
        ),
        default="member",
        server_default="member",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )
