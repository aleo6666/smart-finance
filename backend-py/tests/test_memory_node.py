import hashlib
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from langchain_core.messages import AIMessage, HumanMessage

from app.core.config import Settings
from app.models import Base, KnowledgeDocument
from app.services.knowledge import chunk_point_id


def _extract_memory_candidates(messages):
    try:
        from app.agents.nodes.memory_node import extract_memory_candidates
    except ImportError:
        pytest.fail("memory_node extraction is not implemented")
    return extract_memory_candidates(messages)


def test_rule_prefilter_matches_monthly_saving_statement() -> None:
    candidates = _extract_memory_candidates(
        [HumanMessage(content="我每月存 2000。今天天气不错。")]
    )

    assert candidates == ["我每月存 2000"]


def test_rule_prefilter_ignores_ordinary_chat() -> None:
    candidates = _extract_memory_candidates(
        [HumanMessage(content="今天天气不错，我们聊聊电影吧。")]
    )

    assert candidates == []


class JsonModel:
    def __init__(self, content: str) -> None:
        self.content = content
        self.calls: list[list[object]] = []

    async def ainvoke(self, messages: list[object]) -> AIMessage:
        from langchain_core.messages import SystemMessage
        if messages and any(
            isinstance(m, SystemMessage) and "意图识别器" in str(m.content)
            for m in messages
        ):
            return AIMessage(
                content='{"category": "chat", "subtype": "other", "confidence": 1.0, "reason": "test"}'
            )
        self.calls.append(messages)
        return AIMessage(content=self.content)


@pytest.mark.asyncio
async def test_llm_json_decision_returns_normalized_financial_fact() -> None:
    from app.agents.nodes.memory_node import classify_memory_candidate

    model = JsonModel(
        '{"is_financial_fact": true, "category": "goal", '
        '"content": "我要在年底存 5 万。", "dedup_key": "untrusted"}'
    )

    fact = await classify_memory_candidate(model, "我的目标是年底存 5 万")

    assert fact == {
        "category": "goal",
        "content": "我要在年底存 5 万。",
        "dedup_key": hashlib.sha256("我要在年底存5万".encode()).hexdigest(),
    }
    assert len(model.calls) == 1
    assert "is_financial_fact" in model.calls[0][0].content


@pytest.mark.asyncio
async def test_llm_json_decision_rejects_non_financial_candidate() -> None:
    from app.agents.nodes.memory_node import classify_memory_candidate

    model = JsonModel(
        '{"is_financial_fact": false, "category": "preference", '
        '"content": "我喜欢电影", "dedup_key": "ignored"}'
    )

    assert await classify_memory_candidate(model, "我喜欢电影") is None


class MemoryQdrant:
    def __init__(self) -> None:
        self.keys: set[tuple[int, str]] = set()
        self.filters: list[object] = []

    async def collection_exists(self, collection_name: str) -> bool:
        return True

    async def scroll(self, **kwargs):
        query_filter = kwargs["scroll_filter"]
        self.filters.append(query_filter)
        values = {
            condition.key: condition.match.value for condition in query_filter.must
        }
        found = (values["user_id"], values["dedup_key"]) in self.keys
        return ([object()] if found else [], None)


@pytest.mark.asyncio
async def test_same_user_and_content_are_only_ingested_once() -> None:
    from app.agents.nodes.memory_node import persist_conversation_memories

    model = JsonModel(
        '{"is_financial_fact": true, "category": "rule", '
        '"content": "我每月存 2000", "dedup_key": "ignored"}'
    )
    qdrant = MemoryQdrant()
    ingested: list[dict[str, str]] = []

    async def ingest(fact: dict[str, str]) -> None:
        ingested.append(fact)
        qdrant.keys.add((7, fact["dedup_key"]))

    messages = [HumanMessage(content="我每月存 2000")]
    first = await persist_conversation_memories(
        messages=messages,
        user_id=7,
        model=model,
        qdrant=qdrant,
        ingester=ingest,
    )
    second = await persist_conversation_memories(
        messages=messages,
        user_id=7,
        model=model,
        qdrant=qdrant,
        ingester=ingest,
    )

    assert (first, second) == (1, 0)
    assert [fact["content"] for fact in ingested] == ["我每月存 2000"]
    latest_filter = {
        condition.key: condition.match.value
        for condition in qdrant.filters[-1].must
    }
    assert latest_filter == {
        "user_id": 7,
        "dedup_key": ingested[0]["dedup_key"],
    }


@pytest.mark.asyncio
async def test_first_memory_is_ingested_before_collection_exists() -> None:
    from app.agents.nodes.memory_node import persist_conversation_memories

    class EmptyQdrant:
        async def collection_exists(self, collection_name: str) -> bool:
            return False

        async def scroll(self, **kwargs):
            raise AssertionError("missing collection must not be scrolled")

    ingested: list[dict[str, str]] = []

    async def ingest(fact: dict[str, str]) -> None:
        ingested.append(fact)

    count = await persist_conversation_memories(
        messages=[HumanMessage(content="我每月存 2000")],
        user_id=7,
        model=JsonModel(
            '{"is_financial_fact": true, "category": "rule", '
            '"content": "我每月存 2000", "dedup_key": "ignored"}'
        ),
        qdrant=EmptyQdrant(),
        ingester=ingest,
    )

    assert count == 1
    assert len(ingested) == 1


@pytest.mark.asyncio
async def test_llm_failure_falls_back_to_rule_candidate() -> None:
    from app.agents.nodes.memory_node import persist_conversation_memories

    class FailingModel:
        async def ainvoke(self, messages: list[object]) -> AIMessage:
            raise RuntimeError("LLM unavailable")

    qdrant = MemoryQdrant()
    ingested: list[dict[str, str]] = []

    async def ingest(fact: dict[str, str]) -> None:
        ingested.append(fact)

    count = await persist_conversation_memories(
        messages=[HumanMessage(content="我每月固定存 2000 元")],
        user_id=9,
        model=FailingModel(),
        qdrant=qdrant,
        ingester=ingest,
    )

    assert count == 1
    assert ingested[0]["category"] == "rule"
    assert ingested[0]["content"] == "我每月固定存 2000 元"


@pytest.mark.asyncio
async def test_memory_node_ingests_into_user_private_space() -> None:
    from app.agents.nodes.memory_node import create_memory_node

    class SessionContext:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, exc_type, exc, traceback):
            return False

    qdrant = MemoryQdrant()
    calls: list[dict[str, object]] = []

    async def ingest(db, client, settings, **kwargs) -> None:
        calls.append(kwargs)

    node = create_memory_node(
        model=JsonModel(
            '{"is_financial_fact": true, "category": "preference", '
            '"content": "我喜欢低风险理财", "dedup_key": "ignored"}'
        ),
        session_factory=SessionContext,
        qdrant=qdrant,
        settings=SimpleNamespace(memory_auto_ingest=True),
        knowledge_ingester=ingest,
    )

    result = await node(
        {"messages": [HumanMessage(content="我喜欢低风险理财")], "user_id": 7}
    )

    assert result == {}
    assert calls[0]["user_id"] == 7
    assert calls[0]["space_id"] == 7
    assert calls[0]["source_type"] == "chat_memory"
    assert calls[0]["text"] == "我喜欢低风险理财"
    assert calls[0]["extra_payload"]["category"] == "preference"
    assert calls[0]["extra_payload"]["dedup_key"]


@pytest.mark.asyncio
async def test_memory_node_skips_all_work_when_disabled() -> None:
    from app.agents.nodes.memory_node import create_memory_node

    def fail_session_factory():
        raise AssertionError("disabled memory must not open a database session")

    node = create_memory_node(
        model=object(),
        session_factory=fail_session_factory,
        qdrant=object(),
        settings=SimpleNamespace(memory_auto_ingest=False),
    )

    assert await node(
        {"messages": [HumanMessage(content="我每月存 2000")], "user_id": 7}
    ) == {}


@pytest.mark.asyncio
async def test_memory_node_persists_chat_memory_document() -> None:
    from app.agents.nodes.memory_node import create_memory_node

    class FakeQdrant:
        def __init__(self) -> None:
            self.exists = False
            self.points: dict[str, object] = {}

        async def collection_exists(self, collection_name: str) -> bool:
            return self.exists

        async def create_collection(self, **kwargs) -> None:
            self.exists = True

        async def scroll(self, **kwargs):
            return [], None

        async def upsert(self, **kwargs) -> None:
            for point in kwargs["points"]:
                self.points[point.id] = point

    async def embed(text: str, settings: Settings) -> list[float]:
        return [0.1, 0.2, 0.3]

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    settings = Settings(
        _env_file=None,
        database_url="sqlite+aiosqlite:///:memory:",
        qdrant_url="http://fake-qdrant",
        jwt_secret="test-secret-that-is-long-enough",
        embedding_dimension=3,
    )
    qdrant = FakeQdrant()
    node = create_memory_node(
        model=JsonModel(
            '{"is_financial_fact": true, "category": "rule", '
            '"content": "我每月固定存 2000 元", "dedup_key": "ignored"}'
        ),
        session_factory=sessions,
        qdrant=qdrant,
        settings=settings,
        embedder=embed,
    )

    await node(
        {"messages": [HumanMessage(content="我每月固定存 2000 元")], "user_id": 7}
    )
    async with sessions() as session:
        document = await session.scalar(select(KnowledgeDocument))

    assert document is not None
    assert document.user_id == document.space_id == 7
    assert document.source_type == "chat_memory"
    point = qdrant.points[chunk_point_id(document.id, 0)]
    assert point.payload["content"] == "我每月固定存 2000 元"
    assert point.payload["dedup_key"]
    await engine.dispose()


@pytest.mark.asyncio
async def test_agent_graph_runs_non_blocking_memory_step_after_final_answer() -> None:
    from app.agents.graph import create_agent_graph

    class FinalModel:
        def bind_tools(self, tools: list[object]):
            return self

        async def ainvoke(self, messages: list[object]) -> AIMessage:
            from langchain_core.messages import SystemMessage
            if messages and any(
                isinstance(m, SystemMessage) and "意图识别器" in str(m.content)
                for m in messages
            ):
                return AIMessage(
                    content='{"category": "chat", "subtype": "other", "confidence": 1.0, "reason": "test"}'
                )
            return AIMessage(content="done")

    observed: list[int] = []

    async def failing_memory(state) -> dict:
        observed.append(state["user_id"])
        raise RuntimeError("memory store unavailable")

    graph = create_agent_graph(
        model=FinalModel(), tools=[], memory_processor=failing_memory
    )

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="普通问题")], "user_id": 11}
    ,
        config={"configurable": {"thread_id": "test"}})

    assert observed == [11]
    assert result["messages"][-1].content == "done"
