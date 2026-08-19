"""任务 A8：写操作 interrupt 人工确认端到端（图级）。

覆盖：大额写操作触发 interrupt、resume=True 落库、resume=False 取消。
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


class _Settings:
    record_confirm_threshold = Decimal("200")
    confirm_fast_categories = ["餐饮", "交通", "日用品", "娱乐", "医疗"]
    confirm_ambiguous_words = ["报销", "分期", "借款", "预付", "押金"]


class _ScriptedLLM:
    def __init__(self, script: list[AIMessage]) -> None:
        self.script = script
        self.i = 0

    def bind_tools(self, tools: list[object]):
        return self

    async def ainvoke(self, messages: list[object]) -> AIMessage:
        resp = self.script[min(self.i, len(self.script) - 1)]
        self.i += 1
        return resp


def _tool_call(name: str, args: dict, cid: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": cid}])


@pytest_asyncio.fixture
async def db_session_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield sessions
    await engine.dispose()


@pytest.mark.asyncio
async def test_large_write_interrupts_then_commits_on_confirm(db_session_factory) -> None:
    llm = _ScriptedLLM(
        [
            _tool_call(
                "create_record",
                {"user_id": 7, "category": "居住", "amount": Decimal("5000.00"), "note": "房租"},
                "c1",
            ),
            AIMessage(content="已确认记账"),
        ]
    )
    sessions = db_session_factory

    async def exec_pending(pending: dict) -> str:
        args = pending["args"]
        async with sessions() as s:
            rec = await insert_record(
                s, user_id=args["user_id"], type=args.get("type", "expense"),
                category=args["category"], amount=args["amount"],
                note=args.get("note"), idempotency_key=pending["idempotency_key"],
            )
        return f"已确认记账：{rec.category} {rec.amount} 元"

    graph = create_agent_graph(
        model=llm,
        tools=[create_create_record_tool(sessions, _Settings())],
        max_iterations=8,
        tool_timeout=5,
        pending_write_executor=exec_pending,
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="交房租5000")], "user_id": 7},
        config={"configurable": {"thread_id": "confirm-e2e"}},
    )
    assert result.get("__interrupt__"), "大额写操作应触发 interrupt"

    resumed = await graph.ainvoke(
        Command(resume=True),
        config={"configurable": {"thread_id": "confirm-e2e"}},
    )
    assert "已确认记账" in resumed["messages"][-1].content
    async with sessions() as s:
        rows = (
            await s.scalars(
                select(Transaction).where(
                    Transaction.user_id == 7, Transaction.category == "居住"
                )
            )
        ).all()
    assert len(rows) == 1
    assert rows[0].amount == Decimal("5000.00")


@pytest.mark.asyncio
async def test_large_write_cancel_on_reject(db_session_factory) -> None:
    llm = _ScriptedLLM(
        [
            _tool_call(
                "create_record",
                {"user_id": 7, "category": "居住", "amount": Decimal("3000.00"), "note": "房租"},
                "c2",
            ),
            AIMessage(content="ok"),
        ]
    )
    sessions = db_session_factory

    async def exec_pending(pending: dict) -> str:
        args = pending["args"]
        async with sessions() as s:
            rec = await insert_record(
                s, user_id=args["user_id"], type=args.get("type", "expense"),
                category=args["category"], amount=args["amount"],
                note=args.get("note"), idempotency_key=pending["idempotency_key"],
            )
        return f"已确认记账：{rec.category} {rec.amount} 元"

    graph = create_agent_graph(
        model=llm,
        tools=[create_create_record_tool(sessions, _Settings())],
        max_iterations=8,
        tool_timeout=5,
        pending_write_executor=exec_pending,
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="转3000房租")], "user_id": 7},
        config={"configurable": {"thread_id": "cancel-e2e"}},
    )
    assert result.get("__interrupt__"), "大额写操作应触发 interrupt"

    resumed = await graph.ainvoke(
        Command(resume=False),
        config={"configurable": {"thread_id": "cancel-e2e"}},
    )
    assert "已取消" in resumed["messages"][-1].content
    async with sessions() as s:
        rows = (
            await s.scalars(
                select(Transaction).where(
                    Transaction.user_id == 7, Transaction.category == "居住"
                )
            )
        ).all()
    assert len(rows) == 0
