from datetime import datetime
from decimal import Decimal
import json
from types import SimpleNamespace

import pytest

from app.agents.tools.search_knowledge_base import (
    create_search_knowledge_base_tool,
)
from app.agents.tools.search_similar_records import (
    create_search_similar_records_tool,
    upsert_transaction_embedding,
)
from app.core.config import Settings


def make_settings(**overrides: object) -> Settings:
    values = {
        "database_url": "sqlite+aiosqlite:///:memory:",
        "qdrant_url": "http://127.0.0.1:6333",
        "jwt_secret": "test-secret-that-is-long-enough",
        "embedding_dimension": 3,
        "rag_top_k": 10,
        "rag_rerank_top_k": 5,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


class FakeQdrantClient:
    def __init__(self, points: list[SimpleNamespace], *, collection_exists: bool):
        self.points = points
        self.exists = collection_exists
        self.created: list[dict[str, object]] = []
        self.searches: list[dict[str, object]] = []
        self.upserts: list[dict[str, object]] = []

    async def collection_exists(self, collection_name: str) -> bool:
        return self.exists

    async def create_collection(self, **kwargs: object) -> None:
        self.created.append(kwargs)
        self.exists = True

    async def search(self, **kwargs: object) -> list[SimpleNamespace]:
        self.searches.append(kwargs)
        return self.points

    async def upsert(self, **kwargs: object) -> None:
        self.upserts.append(kwargs)


async def fake_embedder(text: str, settings: Settings) -> list[float]:
    assert text
    assert settings.embedding_dimension == 3
    return [0.1, 0.2, 0.3]


async def keep_order(
    query: str,
    documents: list[dict[str, object]],
    settings: Settings,
) -> list[dict[str, object]]:
    return documents[: settings.rag_rerank_top_k]


@pytest.mark.asyncio
async def test_similar_records_enforces_user_filter_top_k_and_creates_collection() -> None:
    point = SimpleNamespace(
        id=11,
        score=0.8,
        payload={
            "user_id": 7,
            "transaction_id": 11,
            "category": "food",
            "amount": "23.50",
            "note": "lunch",
            "occurred_at": "2026-08-01T12:00:00",
        },
    )
    client = FakeQdrantClient([point], collection_exists=False)
    settings = make_settings()
    tool = create_search_similar_records_tool(
        client,
        settings,
        embedder=fake_embedder,
        reranker=keep_order,
    )

    result = json.loads(await tool.ainvoke({"query": "recent lunch", "user_id": 7}))

    assert client.created[0]["collection_name"] == "transactions_v1"
    assert client.created[0]["vectors_config"].size == 3
    search = client.searches[0]
    assert search["limit"] == 10
    assert search["query_filter"].must[0].key == "user_id"
    assert search["query_filter"].must[0].match.value == 7
    assert result["dataset_refs"] == [
        {"source": "交易记录", "transaction_id": 11}
    ]
    assert "[来源: 交易记录 transaction_id=11]" in result["context"]


@pytest.mark.asyncio
async def test_knowledge_search_filters_for_user_or_public() -> None:
    points = [
        SimpleNamespace(
            id=1,
            score=0.9,
            payload={
                "user_id": 0,
                "document_id": "guide",
                "chunk_index": 0,
                "title": "Emergency fund",
                "source_type": "article",
                "content": "Keep a liquid reserve.",
            },
        )
    ]
    client = FakeQdrantClient(points, collection_exists=True)
    tool = create_search_knowledge_base_tool(
        client,
        make_settings(),
        embedder=fake_embedder,
        reranker=keep_order,
    )

    result = json.loads(await tool.ainvoke({"query": "emergency fund", "user_id": 7}))

    query_filter = client.searches[0]["query_filter"]
    assert query_filter.must == []
    assert [condition.match.value for condition in query_filter.should] == [7, 0]
    assert result["dataset_refs"] == [
        {
            "source": "知识库",
            "document_id": "guide",
            "chunk_index": 0,
        }
    ]


@pytest.mark.asyncio
async def test_transaction_embedding_upsert_is_idempotent_and_keeps_decimal_amount() -> None:
    client = FakeQdrantClient([], collection_exists=True)

    await upsert_transaction_embedding(
        client,
        make_settings(),
        transaction_id=42,
        user_id=7,
        category="food",
        amount=Decimal("19.90"),
        note="dinner",
        occurred_at=datetime(2026, 8, 2, 19, 0),
        embedder=fake_embedder,
    )

    call = client.upserts[0]
    assert call["collection_name"] == "transactions_v1"
    assert call["wait"] is True
    point = call["points"][0]
    assert point.id == 42
    assert point.payload["amount"] == "19.90"

