from datetime import datetime, timedelta
from decimal import Decimal

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import Asset, Base, Ledger, Liability, Transaction, User
from app.services.financial_overview import get_user_financial_overview


@pytest_asyncio.fixture
async def financial_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    now = datetime.now()
    async with session_factory() as session:
        session.add_all(
            [
                User(id=1, email="one@example.com", password_hash="hash"),
                User(id=2, email="two@example.com", password_hash="hash"),
                User(id=3, email="three@example.com", password_hash="hash"),
                Ledger(id=1, user_id=1, name="One"),
                Ledger(id=2, user_id=2, name="Two"),
                Ledger(id=3, user_id=3, name="Three"),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="income",
                    category="salary",
                    amount=Decimal("30000.00"),
                    occurred_at=now - timedelta(days=10),
                ),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="food",
                    amount=Decimal("3000.00"),
                    occurred_at=now - timedelta(days=9),
                ),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="housing",
                    amount=Decimal("6000.00"),
                    occurred_at=now - timedelta(days=8),
                ),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="old",
                    amount=Decimal("99999.00"),
                    occurred_at=now - timedelta(days=100),
                ),
                Asset(
                    user_id=1, type="cash", name="Cash", amount=Decimal("9000")
                ),
                Asset(
                    user_id=1,
                    type="bank_deposit",
                    name="Bank",
                    amount=Decimal("9000"),
                ),
                Asset(
                    user_id=1,
                    type="investment",
                    name="Fund",
                    amount=Decimal("30000"),
                ),
                Asset(
                    user_id=1,
                    type="property",
                    name="Home",
                    amount=Decimal("52000"),
                ),
                Liability(
                    user_id=1,
                    type="loan",
                    name="Loan",
                    amount=Decimal("20000"),
                    monthly_payment=Decimal("2000"),
                ),
                Transaction(
                    user_id=2,
                    ledger_id=2,
                    type="income",
                    category="salary",
                    amount=Decimal("999999.00"),
                    occurred_at=now - timedelta(days=5),
                ),
                Asset(
                    user_id=2,
                    type="cash",
                    name="Other cash",
                    amount=Decimal("999999"),
                ),
                Transaction(
                    user_id=3,
                    ledger_id=3,
                    type="income",
                    category="salary",
                    amount=Decimal("9000.00"),
                    occurred_at=now - timedelta(days=4),
                ),
                Transaction(
                    user_id=3,
                    ledger_id=3,
                    type="expense",
                    category="food",
                    amount=Decimal("3000.00"),
                    occurred_at=now - timedelta(days=3),
                ),
                Liability(
                    user_id=3,
                    type="credit_card",
                    name="Card",
                    amount=Decimal("1000"),
                    monthly_payment=Decimal("100"),
                ),
            ]
        )
        await session.commit()
        yield session

    await engine.dispose()


async def test_financial_overview_aggregates_user_data(financial_session) -> None:
    result = await get_user_financial_overview(financial_session, user_id=1, months=3)

    assert result["user_id"] == 1
    assert result["period"]["months"] == 3
    assert result["raw"] == {
        "income": {"total": Decimal("30000.00"), "monthly": Decimal("10000.00")},
        "expenses": {
            "total": Decimal("9000.00"),
            "monthly": Decimal("3000.00"),
            "food": Decimal("3000.00"),
            "fixed": Decimal("6000.00"),
        },
        "assets": {
            "total": Decimal("100000.00"),
            "liquid": Decimal("18000.00"),
            "investment": Decimal("30000.00"),
        },
        "liabilities": {
            "total": Decimal("20000.00"),
            "monthly_payment": Decimal("2000.00"),
        },
    }
    assert result["metrics"]["savings_rate"]["value"] == Decimal("0.7")
    assert result["metrics"]["debt_ratio"]["value"] == Decimal("0.2")
    assert result["metrics"]["liquidity_ratio"]["value"] == Decimal("6")
    assert result["metrics"]["debt_to_income"]["value"] == Decimal("0.2")
    assert result["metrics"]["investment_ratio"]["value"] == Decimal("0.3")
    assert result["metrics"]["engel_coefficient"]["value"] == Decimal(1) / Decimal(3)
    assert result["metrics"]["free_savings_rate"]["value"] == Decimal("0.8")
    assert result["metrics"]["net_worth"]["value"] == Decimal("80000.00")


async def test_financial_overview_marks_missing_asset_metrics(
    financial_session,
) -> None:
    result = await get_user_financial_overview(financial_session, user_id=3, months=3)

    assert result["raw"]["assets"] == {
        "total": None,
        "liquid": None,
        "investment": None,
    }
    assert result["metrics"]["savings_rate"]["value"] == Decimal(2) / Decimal(3)
    assert result["metrics"]["debt_ratio"]["value"] is None
    assert result["metrics"]["debt_ratio"]["reason"] == (
        "缺少资产数据，无法计算负债率"
    )
    assert result["metrics"]["liquidity_ratio"]["value"] is None
    assert "reason" in result["metrics"]["liquidity_ratio"]
    assert result["metrics"]["net_worth"]["value"] is None
    assert "reason" in result["metrics"]["net_worth"]


async def test_financial_overview_isolates_user_id(financial_session) -> None:
    result = await get_user_financial_overview(financial_session, user_id=1, months=3)

    assert result["raw"]["income"]["total"] == Decimal("30000.00")
    assert result["raw"]["assets"]["total"] == Decimal("100000.00")


async def test_financial_overview_explains_missing_fixed_expenses(
    financial_session,
) -> None:
    result = await get_user_financial_overview(financial_session, user_id=2, months=3)

    metric = result["metrics"]["free_savings_rate"]
    assert metric["value"] is None
    assert metric["reason"] == "缺少固定支出数据，无法计算自由储蓄率"
