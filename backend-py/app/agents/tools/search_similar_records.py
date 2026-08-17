from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime
from decimal import Decimal
import json
from typing import Any

from langchain_core.tools import BaseTool, tool
from qdrant_client import AsyncQdrantClient
from qdrant_client.http import models

from app.agents.tools.rerank import rerank_documents
from app.core.config import Settings
from app.core.llm import embed_text


COLLECTION_NAME = "transactions_v1"
Embedder = Callable[[str, Settings], Awaitable[list[float]]]
Reranker = Callable[
    [str, list[dict[str, Any]], Settings],
    Awaitable[list[dict[str, Any]]],
]


async def ensure_collection(
    client: AsyncQdrantClient,
    collection_name: str,
    vector_size: int,
) -> None:
    if await client.collection_exists(collection_name):
        return
    await client.create_collection(
        collection_name=collection_name,
        vectors_config=models.VectorParams(
            size=vector_size,
            distance=models.Distance.COSINE,
        ),
    )


def _transaction_text(payload: dict[str, Any]) -> str:
    return " | ".join(
        str(payload.get(key) or "")
        for key in ("category", "amount", "note", "occurred_at")
    )


def create_search_similar_records_tool(
    client: AsyncQdrantClient,
    settings: Settings,
    *,
    embedder: Embedder = embed_text,
    reranker: Reranker = rerank_documents,
) -> BaseTool:
    @tool
    async def search_similar_records(query: str, user_id: int) -> str:
        """Search semantically similar transactions for exactly one user."""
        await ensure_collection(
            client, COLLECTION_NAME, settings.embedding_dimension
        )
        vector = await embedder(query, settings)
        points = await client.search(
            collection_name=COLLECTION_NAME,
            query_vector=vector,
            query_filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="user_id",
                        match=models.MatchValue(value=user_id),
                    )
                ]
            ),
            limit=settings.rag_top_k,
            with_payload=True,
        )
        documents = []
        for point in points:
            payload = dict(point.payload or {})
            documents.append(
                {
                    **payload,
                    "text": _transaction_text(payload),
                    "source": "交易记录",
                    "transaction_id": payload.get("transaction_id", point.id),
                    "vector_score": point.score,
                }
            )
        ranked = await reranker(query, documents, settings)
        refs = [
            {
                "source": "交易记录",
                "transaction_id": document.get("transaction_id"),
            }
            for document in ranked
        ]
        from app.agents.tools.rerank import build_context

        return json.dumps(
            {
                "results": ranked,
                "context": build_context(ranked, settings.rag_max_context_chars),
                "dataset_refs": refs,
            },
            ensure_ascii=False,
        )

    return search_similar_records


async def upsert_transaction_embedding(
    client: AsyncQdrantClient,
    settings: Settings,
    *,
    transaction_id: int,
    user_id: int,
    category: str,
    amount: Decimal,
    note: str | None,
    occurred_at: datetime,
    embedder: Embedder = embed_text,
) -> None:
    await ensure_collection(client, COLLECTION_NAME, settings.embedding_dimension)
    payload = {
        "user_id": user_id,
        "transaction_id": transaction_id,
        "category": category,
        "amount": format(amount, "f"),
        "note": note,
        "occurred_at": occurred_at.isoformat(),
    }
    vector = await embedder(_transaction_text(payload), settings)
    await client.upsert(
        collection_name=COLLECTION_NAME,
        points=[
            models.PointStruct(
                id=transaction_id,
                vector=vector,
                payload=payload,
            )
        ],
        wait=True,
    )

