from datetime import datetime
from decimal import Decimal

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.database import get_db
from app.main import create_app
from app.models import Base, Ledger, Report, Transaction, User
from app.services.report_generator import (
    generate_monthly_report,
    get_report,
    list_reports,
)


@pytest_asyncio.fixture
async def report_store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        session.add_all(
            [
                User(id=1, email="report@example.com", password_hash="hash"),
                User(id=2, email="report2@example.com", password_hash="hash"),
                Ledger(id=1, user_id=1, name="Report"),
                Ledger(id=2, user_id=2, name="Private"),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="income",
                    category="工资",
                    amount=Decimal("10000"),
                    occurred_at=datetime(2026, 3, 1),
                ),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="餐饮",
                    amount=Decimal("3000"),
                    occurred_at=datetime(2026, 3, 2),
                ),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="房租",
                    amount=Decimal("6000"),
                    occurred_at=datetime(2026, 3, 3),
                ),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="餐饮",
                    amount=Decimal("2000"),
                    occurred_at=datetime(2026, 2, 2),
                ),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="房租",
                    amount=Decimal("5000"),
                    occurred_at=datetime(2026, 2, 3),
                ),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="餐饮",
                    amount=Decimal("1000"),
                    occurred_at=datetime(2025, 3, 2),
                ),
                Transaction(
                    user_id=2,
                    ledger_id=2,
                    type="expense",
                    category="private",
                    amount=Decimal("999999"),
                    occurred_at=datetime(2026, 3, 2),
                ),
            ]
        )
        await session.commit()
    yield engine, sessions
    await engine.dispose()


@pytest.mark.asyncio
async def test_monthly_report_renders_data_driven_text_and_persists(
    report_store,
) -> None:
    _, sessions = report_store
    async with sessions() as session:
        result = await generate_monthly_report(session, 1, 2026, 3)

        assert result["content"]["summary"]["income"] == "10000.00"
        assert result["content"]["summary"]["expenses"] == "9000.00"
        assert any(
            "本月餐饮支出 3000.00 元，环比上升 50.00%，主要因为较上月增加 1000.00 元"
            in text
            for text in result["content"]["narratives"]
        )
        assert any(
            "建议将储蓄率提升至 20%，减少非必要支出" in advice
            and "不构成投资建议，不推荐具体产品" in advice
            for advice in result["content"]["action_advice"]
        )
        assert result["content"]["comparisons"]["year_over_year"]["categories"]["餐饮"]["change_rate"] == "2.0000"
        persisted = await session.scalar(select(Report).where(Report.id == result["id"]))
        assert persisted is not None
        assert persisted.user_id == 1
        assert persisted.content == result["content"]


@pytest.mark.asyncio
async def test_report_history_and_detail_are_user_isolated(report_store) -> None:
    _, sessions = report_store
    async with sessions() as session:
        generated = await generate_monthly_report(session, 1, 2026, 3)
        assert len(await list_reports(session, 1)) == 1
        assert await list_reports(session, 2) == []
        assert await get_report(session, generated["id"], 1) is not None
        assert await get_report(session, generated["id"], 2) is None


def test_report_api_generate_list_and_detail(report_store) -> None:
    _, sessions = report_store
    application = create_app(chat_agent=object())

    async def override_get_db():
        async with sessions() as session:
            yield session

    application.dependency_overrides[get_db] = override_get_db
    with TestClient(application) as client:
        generated = client.post(
            "/api/reports/generate",
            json={"user_id": 1, "year": 2026, "month": 3},
        )
        assert generated.status_code == 200
        report_id = generated.json()["id"]

        history = client.get("/api/reports?user_id=1")
        assert history.status_code == 200
        assert [item["id"] for item in history.json()] == [report_id]

        detail = client.get(f"/api/reports/{report_id}?user_id=1")
        assert detail.status_code == 200
        assert detail.json()["period"] == "2026-03"

        isolated = client.get(f"/api/reports/{report_id}?user_id=2")
        assert isolated.status_code == 404
