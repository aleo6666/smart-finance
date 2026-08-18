"""会话记忆（L1 历史 + L3 滚动摘要）测试：加载 / 隔离 / 滑窗 / 注入 / 落库 / 摘要 / 降级。"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.agents.graph import create_agent_graph
from app.api.deps import create_access_token
from app.core.database import get_db
from app.main import create_app
from app.models import Base, ConversationMessage, ConversationSummary
from app.services.conversation_memory import (
    load_conversation_context,
    maybe_roll_summary,
)


async def _make_session_factory() -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return engine, sessions


class CapturingModel:
    """记录 ainvoke 入参并返回固定回复的模型（无工具调用，图只跑一轮）。"""

    def __init__(self, reply: str = "好的。") -> None:
        self.reply = reply
        self.calls: list[list[object]] = []

    def bind_tools(self, tools: list[object]) -> CapturingModel:
        return self

    async def ainvoke(self, messages: list[object]) -> AIMessage:
        self.calls.append(list(messages))
        return AIMessage(content=self.reply)


class SummaryModel:
    def __init__(self, content: str = '{"summary": "8月19日：用户询问餐饮支出与环比。"}') -> None:
        self.content = content

    async def ainvoke(self, messages: list[object]) -> AIMessage:
        return AIMessage(content=self.content)


class FailingModel:
    async def ainvoke(self, messages: list[object]) -> AIMessage:
        raise RuntimeError("LLM unavailable")


async def _post_chat(
    message: str,
    *,
    summary: str | None = None,
    covered_until_id: int = 0,
    covered_count: int = 0,
) -> tuple[object, async_sessionmaker[AsyncSession], AsyncEngine, CapturingModel]:
    """构造带 in-memory DB 与捕获模型的 app，POST /api/chat 并返回响应与资源。"""
    engine, sessions = await _make_session_factory()
    if summary is not None:
        async with sessions() as session:
            session.add(
                ConversationSummary(
                    user_id=7,
                    summary=summary,
                    covered_until_id=covered_until_id,
                    covered_count=covered_count,
                )
            )
            await session.commit()

    model = CapturingModel()
    agent = create_agent_graph(model=model, tools=[])
    app = create_app(chat_agent=agent)

    async def override_get_db():
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    token = create_access_token(7)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/api/chat",
            json={"message": message},
            headers={"Authorization": f"Bearer {token}"},
        )
    return response, sessions, engine, model


@pytest.mark.asyncio
async def test_load_conversation_context_empty() -> None:
    engine, sessions = await _make_session_factory()
    try:
        async with sessions() as session:
            summary, history = await load_conversation_context(session, 7)
        assert summary is None
        assert history == []
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_load_conversation_context_returns_window_in_order() -> None:
    engine, sessions = await _make_session_factory()
    try:
        async with sessions() as session:
            session.add_all(
                [
                    ConversationMessage(user_id=7, role="user", content="上个月餐饮花了多少？"),
                    ConversationMessage(user_id=7, role="assistant", content="上个月餐饮支出 500 元。"),
                    ConversationMessage(user_id=7, role="user", content="那环比呢？"),
                ]
            )
            await session.commit()
            summary, history = await load_conversation_context(session, 7)
        assert summary is None
        assert [type(message).__name__ for message in history] == [
            "HumanMessage",
            "AIMessage",
            "HumanMessage",
        ]
        assert [message.content for message in history] == [
            "上个月餐饮花了多少？",
            "上个月餐饮支出 500 元。",
            "那环比呢？",
        ]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_load_conversation_context_is_user_isolated() -> None:
    engine, sessions = await _make_session_factory()
    try:
        async with sessions() as session:
            session.add(ConversationMessage(user_id=7, role="user", content="用户 A 的历史"))
            session.add(ConversationMessage(user_id=7, role="assistant", content="用户 A 的回复"))
            await session.commit()
            summary, history = await load_conversation_context(session, 99)
        assert summary is None
        assert history == []
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_load_conversation_context_sliding_window() -> None:
    engine, sessions = await _make_session_factory()
    try:
        async with sessions() as session:
            for index in range(5):
                session.add(
                    ConversationMessage(user_id=7, role="user", content=f"问题{index}")
                )
            await session.commit()
            summary, history = await load_conversation_context(session, 7, limit=3)
        assert summary is None
        assert [message.content for message in history] == ["问题2", "问题3", "问题4"]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_chat_injects_summary_as_system_message() -> None:
    summary_text = "8月19日：用户询问餐饮支出与环比。"
    response, _sessions, engine, model = await _post_chat(
        "那环比呢？",
        summary=summary_text,
        covered_until_id=4,
        covered_count=4,
    )
    assert response.status_code == 200

    captured = model.calls[0]
    summary_index = next(
        index
        for index, message in enumerate(captured)
        if isinstance(message, SystemMessage) and summary_text in str(message.content)
    )
    human_index = next(
        index
        for index, message in enumerate(captured)
        if isinstance(message, HumanMessage) and str(message.content) == "那环比呢？"
    )
    assert summary_index < human_index
    await engine.dispose()


@pytest.mark.asyncio
async def test_chat_persists_user_and_assistant_messages() -> None:
    response, sessions, engine, _model = await _post_chat("我这个月餐饮花了多少")
    assert response.status_code == 200

    async with sessions() as session:
        rows = (
            await session.scalars(
                select(ConversationMessage).order_by(ConversationMessage.id.asc())
            )
        ).all()
    assert [(row.role, row.content) for row in rows] == [
        ("user", "我这个月餐饮花了多少"),
        ("assistant", "好的。"),
    ]
    await engine.dispose()


@pytest.mark.asyncio
async def test_maybe_roll_summary_advances_and_cleans() -> None:
    engine, sessions = await _make_session_factory()
    try:
        async with sessions() as session:
            for index in range(3):
                session.add(ConversationMessage(user_id=7, role="user", content=f"问题{index}"))
                session.add(ConversationMessage(user_id=7, role="assistant", content=f"回答{index}"))
            await session.commit()

            ok = await maybe_roll_summary(
                session, 7, SummaryModel(), threshold=3, max_history=500
            )
            assert ok is True

        async with sessions() as session:
            summary = (await session.scalars(select(ConversationSummary))).one()
            assert summary.user_id == 7
            assert summary.covered_until_id == 6
            assert summary.covered_count == 6
            assert "餐饮" in summary.summary
            remaining = (await session.scalars(select(ConversationMessage))).all()
            assert remaining == []
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_maybe_roll_summary_degrades_on_invalid_json() -> None:
    engine, sessions = await _make_session_factory()
    try:
        async with sessions() as session:
            for index in range(3):
                session.add(ConversationMessage(user_id=7, role="user", content=f"问题{index}"))
            await session.commit()

            ok = await maybe_roll_summary(
                session, 7, SummaryModel(content="这不是 JSON"), threshold=3
            )
            assert ok is False

        async with sessions() as session:
            assert await session.scalar(select(ConversationSummary)) is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_maybe_roll_summary_degrades_on_exception() -> None:
    engine, sessions = await _make_session_factory()
    try:
        async with sessions() as session:
            for index in range(3):
                session.add(ConversationMessage(user_id=7, role="user", content=f"问题{index}"))
            await session.commit()

            ok = await maybe_roll_summary(session, 7, FailingModel(), threshold=3)
            assert ok is False

        async with sessions() as session:
            assert await session.scalar(select(ConversationSummary)) is None
    finally:
        await engine.dispose()
