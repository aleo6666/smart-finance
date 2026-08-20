from __future__ import annotations

import hashlib
import logging
import re
import unicodedata
from collections.abc import Awaitable, Callable
from typing import Any, Literal, TypedDict, cast

from langchain_core.messages import BaseMessage, HumanMessage
from qdrant_client.http import models

from app.agents.tools.search_knowledge_base import COLLECTION_NAME
from app.core.config import Settings
from app.core.llm import embed_text, parse_json_object
from app.services.knowledge import ingest_knowledge_document


MEMORY_PATTERN = re.compile(
    r"存(?:钱|款)?|储蓄|目标|偏好|预算|不要|坚持|喜欢|我不"
)
MEMORY_CATEGORIES = {"rule", "goal", "preference"}
logger = logging.getLogger(__name__)


class MemoryFact(TypedDict):
    category: Literal["rule", "goal", "preference"]
    content: str
    dedup_key: str


def extract_memory_candidates(messages: list[BaseMessage]) -> list[str]:
    """Return conversation sentences that may contain durable financial facts."""
    candidates: list[str] = []
    for message in messages:
        if not isinstance(message.content, str):
            continue
        for sentence in re.split(r"[。！？!?\n]+", message.content):
            candidate = sentence.strip()
            if candidate and MEMORY_PATTERN.search(candidate):
                candidates.append(candidate)
    return candidates


def memory_dedup_key(content: str) -> str:
    normalized = unicodedata.normalize("NFKC", content).casefold()
    normalized = re.sub(r"[\W_]+", "", normalized)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


async def classify_memory_candidate(model: Any, candidate: str) -> MemoryFact | None:
    prompt = (
        "判断候选句是否包含应长期记住的用户财务规则、目标或偏好。"
        "只返回 JSON 对象，不要 Markdown："
        '{"is_financial_fact": boolean, "category": "rule|goal|preference", '
        '"content": "规范且忠于原意的事实", "dedup_key": "内容语义键"}。'
        f"\n候选句：{candidate}"
    )
    response = await model.ainvoke([HumanMessage(content=prompt)])
    parsed = parse_json_object(response.content)
    if not parsed:
        raise ValueError("memory classifier returned invalid JSON")
    if parsed.get("is_financial_fact") is not True:
        return None
    category = parsed.get("category")
    content = parsed.get("content")
    if category not in MEMORY_CATEGORIES or not isinstance(content, str):
        raise ValueError("memory classifier returned invalid fields")
    content = content.strip()
    if not content:
        raise ValueError("memory classifier returned empty content")
    return {
        "category": cast(Literal["rule", "goal", "preference"], category),
        "content": content,
        "dedup_key": memory_dedup_key(content),
    }


def _fallback_memory_fact(candidate: str) -> MemoryFact:
    if re.search(r"目标|(?:我要|我想).{0,12}存", candidate):
        category = "goal"
    elif re.search(r"偏好|喜欢|不要|我不", candidate):
        category = "preference"
    else:
        category = "rule"
    return {
        "category": cast(Literal["rule", "goal", "preference"], category),
        "content": candidate,
        "dedup_key": memory_dedup_key(candidate),
    }


async def _memory_exists(qdrant: Any, user_id: int, dedup_key: str) -> bool:
    if not await qdrant.collection_exists(COLLECTION_NAME):
        return False
    points, _ = await qdrant.scroll(
        collection_name=COLLECTION_NAME,
        scroll_filter=models.Filter(
            must=[
                models.FieldCondition(
                    key="user_id", match=models.MatchValue(value=user_id)
                ),
                models.FieldCondition(
                    key="dedup_key", match=models.MatchValue(value=dedup_key)
                ),
            ]
        ),
        limit=1,
        with_payload=False,
        with_vectors=False,
    )
    return bool(points)


async def persist_conversation_memories(
    *,
    messages: list[BaseMessage],
    user_id: int,
    model: Any,
    qdrant: Any,
    ingester: Callable[[MemoryFact], Awaitable[None]],
) -> int:
    """Classify, deduplicate, and persist durable facts without raising.

    成本策略（小马/用户决策：能单 agent 就单 agent，token 贵要省）：
    - extract_memory_candidates 已用规则预筛（MEMORY_PATTERN）
    - 类别直接用规则分类（_fallback_memory_fact），**零 LLM 调用**
    - 规则分类器足够（目标/偏好/规则三类的关键词覆盖），省掉每条候选的 LLM 分类
    """
    ingested = 0
    for candidate in extract_memory_candidates(messages):
        fact = _fallback_memory_fact(candidate)
        if fact is None:
            continue
        try:
            if await _memory_exists(qdrant, user_id, fact["dedup_key"]):
                continue
            await ingester(fact)
            ingested += 1
        except Exception:
            logger.warning("Memory auto-ingest failed", exc_info=True)
    return ingested


def create_memory_node(
    *,
    model: Any,
    session_factory: Any,
    qdrant: Any,
    settings: Settings,
    knowledge_ingester: Any = ingest_knowledge_document,
    embedder: Any = embed_text,
):
    async def memory_node(state: dict[str, Any]) -> dict[str, Any]:
        if not settings.memory_auto_ingest:
            return {}
        try:
            user_id = state["user_id"]
            async with session_factory() as db:

                async def ingest(fact: MemoryFact) -> None:
                    await knowledge_ingester(
                        db,
                        qdrant,
                        settings,
                        user_id=user_id,
                        space_id=user_id,
                        title=f"对话记忆 {fact['category']}",
                        source_type="chat_memory",
                        file_path=None,
                        text=fact["content"],
                        embedder=embedder,
                        extra_payload={
                            "category": fact["category"],
                            "dedup_key": fact["dedup_key"],
                        },
                    )

                await persist_conversation_memories(
                    messages=state.get("messages", []),
                    user_id=user_id,
                    model=model,
                    qdrant=qdrant,
                    ingester=ingest,
                )
        except Exception:
            logger.warning("Conversation memory node failed", exc_info=True)
        return {}

    return memory_node
