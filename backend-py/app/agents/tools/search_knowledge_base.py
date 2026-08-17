from __future__ import annotations

import json
from typing import Any

from langchain_core.tools import BaseTool, tool
from qdrant_client import AsyncQdrantClient
from qdrant_client.http import models

from app.agents.tools.rerank import build_context, rerank_documents
from app.agents.tools.search_similar_records import Embedder, Reranker, ensure_collection
from app.core.config import Settings
from app.core.llm import embed_text


COLLECTION_NAME = "knowledge_chunks_v1"


def create_search_knowledge_base_tool(
    client: AsyncQdrantClient,
    settings: Settings,
    *,
    embedder: Embedder = embed_text,
    reranker: Reranker = rerank_documents,
) -> BaseTool:
    @tool
    async def search_knowledge_base(query: str, user_id: int) -> str:
        """Search private and public financial knowledge for one user."""
        await ensure_collection(
            client, COLLECTION_NAME, settings.embedding_dimension
        )
        vector = await embedder(query, settings)
        points = await client.search(
            collection_name=COLLECTION_NAME,
            query_vector=vector,
            query_filter=models.Filter(
                must=[],
                should=[
                    models.FieldCondition(
                        key="user_id", match=models.MatchValue(value=user_id)
                    ),
                    models.FieldCondition(
                        key="user_id", match=models.MatchValue(value=0)
                    ),
                ],
            ),
            limit=settings.rag_top_k,
            with_payload=True,
        )
        documents: list[dict[str, Any]] = []
        for point in points:
            payload = dict(point.payload or {})
            documents.append(
                {
                    **payload,
                    "text": str(payload.get("content") or ""),
                    "source": "知识库",
                    "vector_score": point.score,
                }
            )
        ranked = await reranker(query, documents, settings)
        refs = [
            {
                "source": "知识库",
                "document_id": document.get("document_id"),
                "chunk_index": document.get("chunk_index"),
            }
            for document in ranked
        ]
        return json.dumps(
            {
                "results": ranked,
                "context": build_context(ranked, settings.rag_max_context_chars),
                "dataset_refs": refs,
            },
            ensure_ascii=False,
        )

    return search_knowledge_base

