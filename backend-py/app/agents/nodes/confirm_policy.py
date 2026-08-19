"""Deterministic confirmation policy for agent-initiated record writes.

The pure function ``confirm_required`` decides whether a drafted transaction
needs human approval before it is written. ``is_first_category`` performs the
one database lookup the policy needs (whether a user has ever recorded the
given category), keeping the policy function itself side-effect free.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Transaction


def _as_decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def confirm_required(
    draft: dict[str, Any],
    settings: Any,
    *,
    is_first_category: bool = False,
) -> dict[str, Any]:
    """Return ``{"confirm_required": bool, "reason": str|None}`` for a draft.

    Confirmation triggers when any of the following holds:
      - amount >= ``record_confirm_threshold``
      - category not in ``confirm_fast_categories``
      - note contains a ``confirm_ambiguous_words`` marker
      - category is the user's first occurrence for this category
    """
    amount = _as_decimal(draft.get("amount"))
    category = str(draft.get("category") or "")
    note = str(draft.get("note") or "")

    if amount >= settings.record_confirm_threshold:
        return {
            "confirm_required": True,
            "reason": f"金额 {amount} 达到确认阈值 {settings.record_confirm_threshold}",
        }
    if category not in settings.confirm_fast_categories:
        return {
            "confirm_required": True,
            "reason": f"类别 {category} 不在小额直通白名单",
        }
    if any(word in note for word in settings.confirm_ambiguous_words):
        return {
            "confirm_required": True,
            "reason": "备注含歧义词，需人工确认",
        }
    if is_first_category:
        return {
            "confirm_required": True,
            "reason": f"类别 {category} 首次出现，需人工确认",
        }
    return {"confirm_required": False, "reason": None}


async def is_first_category(
    session: AsyncSession, user_id: int, category: str
) -> bool:
    """Return True when the user has no existing transaction in ``category``."""
    existing_id = await session.scalar(
        select(Transaction.id)
        .where(
            Transaction.user_id == user_id,
            Transaction.category == category,
        )
        .limit(1)
    )
    return existing_id is None
