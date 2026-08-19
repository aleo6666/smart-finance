"""任务 A6：create_record 幂等测试（直测 insert_record，确认策略另测）。

覆盖：重复调用只落一笔、不同输入落多笔、显式幂等键。
"""
from __future__ import annotations

from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agents.tools.create_record import (
    compute_idempotency_key,
    insert_record,
)
from app.models import Base, Transaction


@pytest_asyncio.fixture
async def db_session_factory():
    """Fresh in-memory SQLite session factory with schema created."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield sessions
    await engine.dispose()


@pytest.mark.asyncio
async def test_same_input_twice_lands_once(db_session_factory) -> None:
    async with db_session_factory() as session:
        key = compute_idempotency_key(7, Decimal("25.00"), "餐饮", "午餐", None)
        r1 = await insert_record(
            session, user_id=7, type="expense", category="餐饮",
            amount=Decimal("25.00"), note="午餐", idempotency_key=key,
        )
        r2 = await insert_record(
            session, user_id=7, type="expense", category="餐饮",
            amount=Decimal("25.00"), note="午餐", idempotency_key=key,
        )
        assert r1.id == r2.id  # 幂等：同一记录

        rows = (
            await session.scalars(
                select(Transaction).where(
                    Transaction.user_id == 7,
                    Transaction.category == "餐饮",
                )
            )
        ).all()
        assert len(rows) == 1


@pytest.mark.asyncio
async def test_different_note_lands_two_records(db_session_factory) -> None:
    async with db_session_factory() as session:
        k1 = compute_idempotency_key(7, Decimal("25.00"), "餐饮", "午餐", None)
        k2 = compute_idempotency_key(7, Decimal("25.00"), "餐饮", "晚餐", None)
        await insert_record(
            session, user_id=7, type="expense", category="餐饮",
            amount=Decimal("25.00"), note="午餐", idempotency_key=k1,
        )
        await insert_record(
            session, user_id=7, type="expense", category="餐饮",
            amount=Decimal("25.00"), note="晚餐", idempotency_key=k2,
        )
        rows = (
            await session.scalars(
                select(Transaction).where(Transaction.user_id == 7)
            )
        ).all()
        assert len(rows) == 2


@pytest.mark.asyncio
async def test_explicit_idempotency_key_deduplicates(db_session_factory) -> None:
    async with db_session_factory() as session:
        key = compute_idempotency_key(7, Decimal("25.00"), "餐饮", "午餐", None)
        r1 = await insert_record(
            session, user_id=7, type="expense", category="餐饮",
            amount=Decimal("25.00"), note="午餐", idempotency_key=key,
        )
        r2 = await insert_record(
            session, user_id=7, type="expense", category="餐饮",
            amount=Decimal("25.00"), note="午餐", idempotency_key=key,
        )
        assert r1.id == r2.id
        rows = (
            await session.scalars(
                select(Transaction).where(Transaction.user_id == 7)
            )
        ).all()
        assert len(rows) == 1
