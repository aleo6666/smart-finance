from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.llm import parse_json_object
from app.models import ConversationMessage, ConversationSummary

logger = logging.getLogger(__name__)


def _to_message(row: ConversationMessage) -> BaseMessage:
    if row.role == "assistant":
        return AIMessage(content=row.content)
    return HumanMessage(content=row.content)


async def _latest_summary(
    db: AsyncSession, user_id: int
) -> ConversationSummary | None:
    return (
        await db.scalars(
            select(ConversationSummary)
            .where(ConversationSummary.user_id == user_id)
            .order_by(ConversationSummary.id.desc())
            .limit(1)
        )
    ).first()


async def load_conversation_context(
    db: AsyncSession, user_id: int, *, limit: int = 20
) -> tuple[str | None, list[BaseMessage]]:
    """读取该用户的滚动摘要 + 最近窗口历史；失败时降级为空上下文。"""
    summary_text: str | None = None
    covered_until_id = 0
    try:
        summary_row = await _latest_summary(db, user_id)
        if summary_row is not None and summary_row.covered_until_id > 0:
            summary_text = summary_row.summary
            covered_until_id = summary_row.covered_until_id
    except Exception:
        logger.warning("load conversation summary failed", exc_info=True)

    messages: list[BaseMessage] = []
    try:
        rows = (
            await db.scalars(
                select(ConversationMessage)
                .where(
                    ConversationMessage.user_id == user_id,
                    ConversationMessage.id > covered_until_id,
                )
                .order_by(ConversationMessage.id.desc())
                .limit(limit)
            )
        ).all()
        messages = [_to_message(row) for row in reversed(rows)]
    except Exception:
        logger.warning("load conversation history failed", exc_info=True)
    return summary_text, messages


async def save_conversation_messages(
    db: AsyncSession, user_id: int, *, user_text: str, assistant_text: str
) -> None:
    """写入一轮 user/assistant 消息；失败仅记日志，不影响主流程。"""
    try:
        db.add_all(
            [
                ConversationMessage(
                    user_id=user_id, role="user", content=user_text
                ),
                ConversationMessage(
                    user_id=user_id, role="assistant", content=assistant_text
                ),
            ]
        )
        await db.commit()
    except Exception:
        await db.rollback()
        logger.warning("save conversation messages failed", exc_info=True)


def _format_time_range(rows: list[ConversationMessage]) -> str:
    first = rows[0].created_at or datetime.now()
    last = rows[-1].created_at or datetime.now()
    if first.date() == last.date():
        return f"{first.month}月{first.day}日"
    return f"{first.month}月{first.day}日至{last.month}月{last.day}日"


def _format_transcript(rows: list[ConversationMessage]) -> str:
    lines: list[str] = []
    for row in rows:
        label = "用户" if row.role == "user" else "助手"
        lines.append(f"{label}：{row.content}")
    return "\n".join(lines)


async def _generate_summary(
    model: Any,
    old_summary: str,
    rows: list[ConversationMessage],
) -> str | None:
    """调用 LLM 生成滚动摘要；非法输出/异常均降级返回 None。"""
    parts = [
        "请把下面的对话压缩成一段简洁的滚动摘要，供后续无上下文对话时注入记忆。",
        "要求：保留关键财务事实与数字、用户目标/偏好、未完成的意图；",
        "摘要需带时间范围描述（如“8月19日：用户询问餐饮支出……”）。",
        "只返回 JSON 对象，不要 Markdown：{\"summary\": \"...\"}。",
    ]
    time_range = _format_time_range(rows)
    if time_range:
        parts.append(f"时间范围：{time_range}")
    if old_summary:
        parts.append(f"旧摘要（在此基础上追加）：{old_summary}")
    parts.append(f"新对话：\n{_format_transcript(rows)}")
    prompt = "\n".join(parts)

    try:
        response = await model.ainvoke([HumanMessage(content=prompt)])
    except Exception:
        logger.warning("roll summary: LLM call failed", exc_info=True)
        return None
    parsed = parse_json_object(response.content)
    summary = parsed.get("summary") if parsed else None
    if not isinstance(summary, str) or not summary.strip():
        logger.warning("roll summary: LLM returned invalid JSON")
        return None
    return summary.strip()


async def _upsert_summary(
    db: AsyncSession,
    user_id: int,
    summary_row: ConversationSummary | None,
    summary_text: str,
    segment_max_id: int,
    segment_count: int,
) -> None:
    if summary_row is None:
        db.add(
            ConversationSummary(
                user_id=user_id,
                summary=summary_text,
                covered_until_id=segment_max_id,
                covered_count=segment_count,
            )
        )
    else:
        summary_row.summary = summary_text
        summary_row.covered_until_id = segment_max_id
        summary_row.covered_count = (
            summary_row.covered_count or 0
        ) + segment_count
    await db.commit()


async def _cleanup_covered_messages(
    db: AsyncSession,
    user_id: int,
    *,
    covered_until_id: int,
    max_history: int,
) -> None:
    """删除已被摘要覆盖的消息，并兜底每用户保留上限。

    安全约束：只删 ``id <= covered_until_id``（已确认被摘要覆盖）的消息；
    尚未覆盖的消息（``id > covered_until_id``）一律保留，避免丢上下文。
    """
    await db.execute(
        delete(ConversationMessage).where(
            ConversationMessage.user_id == user_id,
            ConversationMessage.id <= covered_until_id,
        )
    )
    # 保留上限兜底：正常流程下覆盖区间已清空、剩余量 < summary_threshold << max_history，
    # 不会触发；若未覆盖消息异常堆积超过 max_history，仅能再清已覆盖部分（此处为空），
    # 未覆盖消息绝不删除。
    remaining_count = (
        await db.scalar(
            select(func.count())
            .select_from(ConversationMessage)
            .where(ConversationMessage.user_id == user_id)
        )
    ) or 0
    if remaining_count > max_history:
        overflow_ids = (
            await db.scalars(
                select(ConversationMessage.id)
                .where(
                    ConversationMessage.user_id == user_id,
                    ConversationMessage.id <= covered_until_id,
                )
                .order_by(ConversationMessage.id.asc())
                .limit(remaining_count - max_history)
            )
        ).all()
        if overflow_ids:
            await db.execute(
                delete(ConversationMessage).where(
                    ConversationMessage.id.in_(overflow_ids)
                )
            )
    await db.commit()


async def maybe_roll_summary(
    db: AsyncSession,
    user_id: int,
    model: Any,
    *,
    threshold: int = 20,
    max_history: int = 500,
) -> bool:
    """累计达到阈值后滚动生成摘要并清理旧消息；全程容错，失败返回 False。"""
    summary_row: ConversationSummary | None = None
    try:
        summary_row = await _latest_summary(db, user_id)
        covered_until_id = summary_row.covered_until_id if summary_row else 0
        pending_count = (
            await db.scalar(
                select(func.count())
                .select_from(ConversationMessage)
                .where(
                    ConversationMessage.user_id == user_id,
                    ConversationMessage.id > covered_until_id,
                )
            )
        ) or 0
        if pending_count < threshold:
            return False
        pending_rows = (
            await db.scalars(
                select(ConversationMessage)
                .where(
                    ConversationMessage.user_id == user_id,
                    ConversationMessage.id > covered_until_id,
                )
                .order_by(ConversationMessage.id.asc())
            )
        ).all()
    except Exception:
        logger.warning("roll summary: load pending messages failed", exc_info=True)
        return False

    old_summary = summary_row.summary if summary_row else ""
    summary_text = await _generate_summary(model, old_summary, pending_rows)
    if summary_text is None:
        return False

    segment_max_id = pending_rows[-1].id
    segment_count = len(pending_rows)
    try:
        await _upsert_summary(
            db,
            user_id,
            summary_row,
            summary_text,
            segment_max_id,
            segment_count,
        )
    except Exception:
        await db.rollback()
        logger.warning("roll summary: upsert summary failed", exc_info=True)
        return False

    try:
        await _cleanup_covered_messages(
            db,
            user_id,
            covered_until_id=segment_max_id,
            max_history=max_history,
        )
    except Exception:
        await db.rollback()
        logger.warning("roll summary: cleanup failed", exc_info=True)
    return True
