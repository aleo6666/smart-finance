import logging

import pytest

from app.agents.tools.rerank import build_context, rerank_documents
from app.core.config import Settings


def make_settings(**overrides: object) -> Settings:
    values = {
        "database_url": "sqlite+aiosqlite:///:memory:",
        "qdrant_url": "http://127.0.0.1:6333",
        "jwt_secret": "test-secret-that-is-long-enough",
        "rerank_api_key": "rerank-secret",
        "rerank_base_url": "https://rerank.example.com/v1",
        "rag_top_k": 4,
        "rag_rerank_top_k": 2,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


@pytest.mark.asyncio
async def test_rerank_uses_api_order_and_top_k() -> None:
    documents = [
        {"text": "first", "id": "a"},
        {"text": "second", "id": "b"},
        {"text": "third", "id": "c"},
    ]

    async def fake_rerank_call(**kwargs: object) -> list[dict[str, object]]:
        assert kwargs["query"] == "emergency fund"
        assert kwargs["documents"] == ["first", "second", "third"]
        return [
            {"index": 2, "relevance_score": 0.9},
            {"index": 0, "relevance_score": 0.8},
            {"index": 1, "relevance_score": 0.1},
        ]

    result = await rerank_documents(
        "emergency fund",
        documents,
        make_settings(),
        rerank_call=fake_rerank_call,
    )

    assert [document["id"] for document in result] == ["c", "a"]
    assert [document["rerank_score"] for document in result] == [0.9, 0.8]


@pytest.mark.asyncio
async def test_rerank_failure_falls_back_to_original_order(
    caplog: pytest.LogCaptureFixture,
) -> None:
    documents = [{"text": str(index), "id": index} for index in range(4)]

    async def unavailable(**kwargs: object) -> list[dict[str, object]]:
        raise RuntimeError("rerank offline")

    with caplog.at_level(logging.WARNING):
        result = await rerank_documents(
            "query",
            documents,
            make_settings(),
            rerank_call=unavailable,
        )

    assert [document["id"] for document in result] == [0, 1]
    assert "rerank" in caplog.text.lower()


def test_context_has_source_annotations_and_respects_character_limit() -> None:
    documents = [
        {
            "text": "A" * 80,
            "source": "知识库",
            "document_id": "doc-1",
            "chunk_index": 2,
        }
    ]

    context = build_context(documents, max_chars=60)

    assert context.startswith("[来源: 知识库 doc_id=doc-1 chunk_index=2]")
    assert len(context) == 60
