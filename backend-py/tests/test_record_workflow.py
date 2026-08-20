"""记账确定性 workflow 端到端测试（新路径，替代旧 create_record 工具循环测试）。

覆盖：小额直通落库 / 大额 interrupt / 确认落库 / 取消不落库 / 无金额提示。
"""
from __future__ import annotations

from decimal import Decimal

import pytest
import pytest_asyncio
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.types import Command
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agents.graph import create_agent_graph
from app.agents.tools.create_record import create_create_record_tool, insert_record
from app.models import Base, Transaction


class _DraftLLM:
    """fake LLM：返回 JSON 草稿（模拟记账解析器）。"""

    def __init__(self, draft_json: str) -> None:
        self.draft_json = draft_json
        self.calls = 0

    def bind_tools(self, tools: list[object]):
        return self

    async def ainvoke(self, messages: list[object]) -> AIMessage:
        self.calls += 1
        return AIMessage(content=self.draft_json)


@pytest_asyncio.fixture
async def db_session_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield sessions
    await engine.dispose()


async def _seed_category(sessions, user_id: int, category: str, amount: str = "10.00", note: str = "seed") -> None:
    """预种记录，让类别非"首次出现"（避免首类别确认干扰金额规则测试）。"""
    async with sessions() as s:
        await insert_record(
            s, user_id=user_id, type="expense", category=category,
            amount=Decimal(amount), note=note,
            idempotency_key=f"seed-{user_id}-{category}",
        )


@pytest.mark.asyncio
async def test_small_record_writes_directly_without_interrupt(db_session_factory) -> None:
    await _seed_category(db_session_factory, 7, "餐饮")
    llm = _DraftLLM(
        '{"type": "expense", "category": "餐饮", "amount": 25, "note": "午餐", "occurred_at": ""}'
    )
    graph = create_agent_graph(
        model=llm,
        tools=[create_create_record_tool(db_session_factory, _FakeSettings())],
        sessions_factory=db_session_factory,
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="今天午餐花了25元")], "user_id": 7},
        config={"configurable": {"thread_id": "wf-small"}},
    )
    assert result.get("__interrupt__") is None, "小额直通不应触发 interrupt"
    assert "已记账" in result["messages"][-1].content
    assert llm.calls == 1, "记账 workflow 应只调用 1 次 LLM（无 ReAct 循环）"
    async with db_session_factory() as s:
        rows = (await s.scalars(select(Transaction).where(Transaction.user_id == 7))).all()
    assert len(rows) == 2  # seed + 午餐


@pytest.mark.asyncio
async def test_large_record_interrupts_then_commits_on_confirm(db_session_factory) -> None:
    await _seed_category(db_session_factory, 7, "居住")
    llm = _DraftLLM(
        '{"type": "expense", "category": "居住", "amount": 5000, "note": "房租", "occurred_at": ""}'
    )

    async def exec_pending(pending: dict) -> str:
        args = pending["args"]
        async with db_session_factory() as s:
            rec = await insert_record(
                s, user_id=args["user_id"], type=args.get("type", "expense"),
                category=args["category"], amount=args["amount"],
                note=args.get("note"), idempotency_key=pending["idempotency_key"],
            )
        return f"已确认记账：{rec.category} {rec.amount} 元"

    graph = create_agent_graph(
        model=llm,
        tools=[create_create_record_tool(db_session_factory, _FakeSettings())],
        sessions_factory=db_session_factory,
        pending_write_executor=exec_pending,
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="交房租5000")], "user_id": 7},
        config={"configurable": {"thread_id": "wf-large"}},
    )
    assert result.get("__interrupt__"), "大额写操作应触发 interrupt"
    assert llm.calls == 1, "记账 workflow 触发确认时也只调 1 次 LLM"

    resumed = await graph.ainvoke(
        Command(resume=True),
        config={"configurable": {"thread_id": "wf-large"}},
    )
    assert "已确认记账" in resumed["messages"][-1].content
    async with db_session_factory() as s:
        rows = (
            await s.scalars(
                select(Transaction).where(
                    Transaction.user_id == 7, Transaction.category == "居住"
                )
            )
        ).all()
    assert len(rows) == 2  # seed + 房租
    assert rows[-1].amount == Decimal("5000.00")


@pytest.mark.asyncio
async def test_large_record_cancel_on_reject(db_session_factory) -> None:
    await _seed_category(db_session_factory, 7, "居住")
    llm = _DraftLLM(
        '{"type": "expense", "category": "居住", "amount": 3000, "note": "房租", "occurred_at": ""}'
    )

    async def exec_pending(pending: dict) -> str:
        args = pending["args"]
        async with db_session_factory() as s:
            rec = await insert_record(
                s, user_id=args["user_id"], type=args.get("type", "expense"),
                category=args["category"], amount=args["amount"],
                note=args.get("note"), idempotency_key=pending["idempotency_key"],
            )
        return f"已确认记账：{rec.category} {rec.amount} 元"

    graph = create_agent_graph(
        model=llm,
        tools=[create_create_record_tool(db_session_factory, _FakeSettings())],
        sessions_factory=db_session_factory,
        pending_write_executor=exec_pending,
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="转3000房租")], "user_id": 7},
        config={"configurable": {"thread_id": "wf-cancel"}},
    )
    assert result.get("__interrupt__")

    resumed = await graph.ainvoke(
        Command(resume=False),
        config={"configurable": {"thread_id": "wf-cancel"}},
    )
    assert "已取消" in resumed["messages"][-1].content
    async with db_session_factory() as s:
        rows = (
            await s.scalars(
                select(Transaction).where(
                    Transaction.user_id == 7, Transaction.category == "居住"
                )
            )
        ).all()
    assert len(rows) == 1  # 只有 seed，房租未落库


@pytest.mark.asyncio
async def test_no_amount_goes_chat_not_record(db_session_factory) -> None:
    """没金额的语句不触发记账 workflow（第一性约束：没金额不记账）。"""
    from app.agents.graph import classify_intent

    assert classify_intent("记一笔午餐") == "chat"


class _FakeSettings:
    record_confirm_threshold = Decimal("200")
    confirm_fast_categories = ["餐饮", "交通", "日用品", "娱乐", "医疗"]
    confirm_ambiguous_words = ["报销", "分期", "借款", "预付", "押金"]
