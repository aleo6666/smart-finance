from __future__ import annotations

from collections.abc import Awaitable, Callable
import logging
from typing import Any

import httpx

from app.core.config import Settings


logger = logging.getLogger(__name__)
RerankCall = Callable[..., Awaitable[list[dict[str, Any]]]]


async def _http_rerank(
    *,
    query: str,
    documents: list[str],
    model: str,
    api_key: str,
    base_url: str,
) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(
            f"{base_url.rstrip('/')}/rerank",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "query": query,
                "documents": documents,
                "top_n": len(documents),
            },
        )
        response.raise_for_status()
        payload = response.json()
    results = payload.get("results", []) if isinstance(payload, dict) else []
    if not isinstance(results, list):
        raise ValueError("rerank response must contain a results list")
    return results


async def rerank_documents(
    query: str,
    documents: list[dict[str, Any]],
    settings: Settings,
    *,
    rerank_call: RerankCall | None = None,
) -> list[dict[str, Any]]:
    if not documents:
        return []

    top_k = min(settings.rag_rerank_top_k, len(documents))
    call = rerank_call or _http_rerank
    try:
        if rerank_call is None and (
            settings.rerank_api_key is None or not settings.rerank_base_url
        ):
            raise RuntimeError("rerank API is not configured")
        results = await call(
            query=query,
            documents=[str(document.get("text", "")) for document in documents],
            model=settings.rerank_model,
            api_key=(
                settings.rerank_api_key.get_secret_value()
                if settings.rerank_api_key is not None
                else ""
            ),
            base_url=settings.rerank_base_url or "",
        )
        ranked: list[dict[str, Any]] = []
        for item in results[:top_k]:
            index = int(item["index"])
            if index < 0 or index >= len(documents):
                raise ValueError("rerank result index is out of range")
            document = dict(documents[index])
            document["rerank_score"] = item.get("relevance_score")
            ranked.append(document)
        if len(ranked) < top_k:
            raise ValueError("rerank returned too few results")
        return ranked
    except Exception as exc:
        logger.warning("rerank failed; using vector-search order: %s", exc)
        return [dict(document) for document in documents[:top_k]]


def _source_label(document: dict[str, Any]) -> str:
    source = str(document.get("source", "未知"))
    if source == "知识库":
        return (
            f"[来源: 知识库 doc_id={document.get('document_id')} "
            f"chunk_index={document.get('chunk_index')}]"
        )
    if source == "交易记录":
        return f"[来源: 交易记录 transaction_id={document.get('transaction_id')}]"
    return f"[来源: {source}]"


def build_context(documents: list[dict[str, Any]], max_chars: int) -> str:
    blocks = [
        f"{_source_label(document)}\n{document.get('text', '')}" for document in documents
    ]
    return "\n\n".join(blocks)[:max_chars]
