from datetime import datetime, timedelta
from decimal import Decimal

import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.database import get_db
from app.main import create_app
from app.models import Asset, Base, Ledger, Liability, Transaction, User


@pytest_asyncio.fixture
async def financial_api_client():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                User(id=1, email="api@example.com", password_hash="hash"),
                Ledger(id=1, user_id=1, name="API ledger"),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="income",
                    category="salary",
                    amount=Decimal("1000.00"),
                    income_source="salary",
                    occurred_at=datetime.now() - timedelta(days=2),
                ),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="food",
                    amount=Decimal("500.00"),
                    occurred_at=datetime.now() - timedelta(days=1),
                ),
                Asset(
                    user_id=1,
                    type="cash",
                    name="Cash",
                    amount=Decimal("2000.00"),
                ),
                Liability(
                    user_id=1,
                    type="loan",
                    name="Loan",
                    amount=Decimal("500.00"),
                    monthly_payment=Decimal("50.00"),
                ),
            ]
        )
        await session.commit()

    application = create_app(chat_agent=object())

    async def override_get_db():
        async with session_factory() as session:
            yield session

    application.dependency_overrides[get_db] = override_get_db
    with TestClient(application) as client:
        yield client

    await engine.dispose()


def test_financial_metrics_api_returns_decimal_strings(financial_api_client) -> None:
    response = financial_api_client.get("/api/financial/metrics?user_id=1")

    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {"user_id", "period", "metrics"}
    assert payload["user_id"] == 1
    assert payload["metrics"]["savings_rate"] == {
        "value": "0.5",
        "label": "储蓄率",
        "unit": "%",
    }
    assert payload["metrics"]["net_worth"]["value"] == "1500.00"


def test_financial_overview_api_returns_metrics_and_raw_data(
    financial_api_client,
) -> None:
    response = financial_api_client.get("/api/financial/overview?user_id=1")

    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {"user_id", "period", "metrics", "raw"}
    assert payload["raw"]["income"]["total"] == "1000.00"
    assert payload["raw"]["expenses"]["total"] == "500.00"
    assert payload["raw"]["assets"]["total"] == "2000.00"
    assert payload["raw"]["liabilities"]["total"] == "500.00"
