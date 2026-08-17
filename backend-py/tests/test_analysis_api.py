from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.database import get_db
from app.main import create_app
from app.models import Base, Budget, Goal, Ledger, Transaction, User, UserProfile


@pytest_asyncio.fixture
async def analysis_api_client():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    today = date.today()
    month_start = date(today.year, today.month, 1)
    month_end = date(today.year, today.month, monthrange(today.year, today.month)[1])
    target_date = today + timedelta(days=365)
    async with sessions() as session:
        session.add_all(
            [
                User(id=1, email="analysis@example.com", password_hash="hash"),
                User(id=2, email="isolated@example.com", password_hash="hash"),
                Ledger(id=1, user_id=1, name="Analysis"),
                Ledger(id=2, user_id=2, name="Isolated"),
                Budget(
                    user_id=1,
                    ledger_id=1,
                    category="food",
                    amount=Decimal("500"),
                    period="monthly",
                    period_start=month_start,
                    period_end=month_end,
                ),
                Transaction(
                    id=1,
                    user_id=1,
                    ledger_id=1,
                    type="income",
                    category="salary",
                    income_source="salary",
                    amount=Decimal("3000"),
                    occurred_at=datetime.combine(month_start, datetime.min.time()),
                ),
                Transaction(
                    id=2,
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="food",
                    note="restaurant",
                    amount=Decimal("700"),
                    occurred_at=datetime.combine(month_start, datetime.min.time())
                    + timedelta(days=1),
                ),
                Transaction(
                    id=3,
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="food",
                    note="restaurant",
                    amount=Decimal("700"),
                    occurred_at=datetime.combine(month_start, datetime.min.time())
                    + timedelta(days=2),
                ),
                Transaction(
                    user_id=2,
                    ledger_id=2,
                    type="expense",
                    category="private",
                    amount=Decimal("999999"),
                    occurred_at=datetime.now(),
                ),
                Goal(
                    user_id=1,
                    name="Emergency",
                    target_amount=Decimal("10000"),
                    current_amount=Decimal("1000"),
                    target_date=target_date,
                ),
                UserProfile(user_id=1, age=35, risk_preference="稳健"),
            ]
        )
        await session.commit()

    application = create_app(chat_agent=object())

    async def override_get_db():
        async with sessions() as session:
            yield session

    application.dependency_overrides[get_db] = override_get_db
    with TestClient(application) as client:
        yield client
    await engine.dispose()


def test_budget_analysis_endpoint_returns_decimal_strings(analysis_api_client) -> None:
    month = date.today().strftime("%Y-%m")
    response = analysis_api_client.post(
        "/api/analysis/budget",
        json={"user_id": 1, "ledger_id": 1, "month": month},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["overspent_categories"][0]["category"] == "food"
    assert payload["overspent_categories"][0]["over_by"] == "900.00"


def test_analysis_post_endpoints_smoke(analysis_api_client) -> None:
    paths = ("forecast", "anomalies", "goals", "benchmark")
    for path in paths:
        response = analysis_api_client.post(
            f"/api/analysis/{path}", json={"user_id": 1}
        )
        assert response.status_code == 200, (path, response.text)
        assert response.json()["reason"] is None, path


def test_analysis_all_returns_five_analyses_and_isolates_user(
    analysis_api_client,
) -> None:
    response = analysis_api_client.get("/api/analysis/all?user_id=1")

    assert response.status_code == 200
    assert set(response.json()) == {
        "budget",
        "forecast",
        "anomalies",
        "goals",
        "benchmark",
    }

    isolated = analysis_api_client.post(
        "/api/analysis/anomalies", json={"user_id": 2, "days": 30}
    )
    assert isolated.status_code == 200
    anomalies = isolated.json()["anomalies"] or []
    assert all(item.get("transaction_id") not in {1, 2, 3} for item in anomalies)
