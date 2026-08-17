from datetime import datetime
from decimal import Decimal
import json

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agents.tools.query_transactions import create_query_transactions_tool
from app.models import Base, Ledger, Transaction, User


@pytest_asyncio.fixture
async def transaction_tool():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                User(
                    id=1,
                    email="user-a@example.com",
                    password_hash="hash-a",
                    nickname="User A",
                ),
                User(
                    id=2,
                    email="user-b@example.com",
                    password_hash="hash-b",
                    nickname="User B",
                ),
                Ledger(id=1, user_id=1, name="A Ledger"),
                Ledger(id=2, user_id=2, name="B Ledger"),
                Transaction(
                    id=1,
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="food",
                    amount=Decimal("10.50"),
                    note="breakfast",
                    occurred_at=datetime(2026, 1, 5, 8, 0),
                ),
                Transaction(
                    id=2,
                    user_id=1,
                    ledger_id=1,
                    type="income",
                    category="salary",
                    amount=Decimal("1000.00"),
                    note="January salary",
                    occurred_at=datetime(2026, 1, 31, 23, 30),
                ),
                Transaction(
                    id=3,
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="food",
                    amount=Decimal("20.00"),
                    note="lunch",
                    occurred_at=datetime(2026, 2, 1, 12, 0),
                ),
                Transaction(
                    id=4,
                    user_id=2,
                    ledger_id=2,
                    type="expense",
                    category="private",
                    amount=Decimal("999.00"),
                    note="User B only",
                    occurred_at=datetime(2026, 1, 15, 12, 0),
                ),
            ]
        )
        await session.commit()

    yield create_query_transactions_tool(session_factory)
    await engine.dispose()


async def invoke_tool(transaction_tool, **overrides) -> dict:
    arguments = {
        "user_id": 1,
        "start_date": None,
        "end_date": None,
        "category": None,
        "txn_type": None,
        "group_by": None,
        "limit": 20,
    }
    arguments.update(overrides)
    return json.loads(await transaction_tool.ainvoke(arguments))


@pytest.mark.asyncio
async def test_filters_transactions_by_inclusive_date_range(transaction_tool) -> None:
    result = await invoke_tool(
        transaction_tool, start_date="2026-01-01", end_date="2026-01-31"
    )

    assert result["count"] == 2
    assert {transaction["id"] for transaction in result["transactions"]} == {1, 2}


@pytest.mark.asyncio
async def test_filters_transactions_by_category(transaction_tool) -> None:
    result = await invoke_tool(transaction_tool, category="food")

    assert result["count"] == 2
    assert {transaction["category"] for transaction in result["transactions"]} == {
        "food"
    }


@pytest.mark.asyncio
async def test_filters_transactions_by_type(transaction_tool) -> None:
    result = await invoke_tool(transaction_tool, txn_type="income")

    assert result["count"] == 1
    assert result["transactions"][0]["id"] == 2


@pytest.mark.asyncio
async def test_groups_transactions_by_category(transaction_tool) -> None:
    result = await invoke_tool(transaction_tool, group_by="category")

    assert result == {
        "count": 2,
        "groups": [
            {"category": "food", "count": 2, "total_amount": "30.50"},
            {"category": "salary", "count": 1, "total_amount": "1000.00"},
        ],
    }


@pytest.mark.asyncio
async def test_groups_transactions_by_month(transaction_tool) -> None:
    result = await invoke_tool(transaction_tool, group_by="month")

    assert result == {
        "count": 2,
        "groups": [
            {"month": "2026-01", "count": 2, "total_amount": "1010.50"},
            {"month": "2026-02", "count": 1, "total_amount": "20.00"},
        ],
    }


@pytest.mark.asyncio
async def test_returns_clear_message_when_no_transactions_match(
    transaction_tool,
) -> None:
    result = await invoke_tool(transaction_tool, category="travel")

    assert result == {"count": 0, "message": "该条件下无交易记录"}


@pytest.mark.asyncio
async def test_user_id_filter_prevents_cross_user_access(transaction_tool) -> None:
    result = await invoke_tool(transaction_tool, user_id=1, category="private")

    assert result == {"count": 0, "message": "该条件下无交易记录"}


@pytest.mark.asyncio
async def test_limit_caps_transactions_in_reverse_chronological_order(
    transaction_tool,
) -> None:
    result = await invoke_tool(transaction_tool, limit=1)

    assert result["count"] == 1
    assert result["transactions"][0]["id"] == 3
