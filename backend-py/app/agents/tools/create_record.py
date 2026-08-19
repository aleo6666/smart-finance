"""Agent write tool: idempotent transaction creation.

Unlike the read-only agent tools, this tool persists a new transaction. It
reuses ``RecordCreate`` validation (positive Decimal amount, income/expense
enum, income_source enum) and writes through an idempotency key so repeated
submissions from the model only land one record.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
import hashlib
import json

from langchain_core.tools import BaseTool, tool
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agents.nodes.confirm_policy import confirm_required, is_first_category
from app.api.deps import get_or_create_default_ledger, get_owned_ledger
from app.api.records import RecordCreate, _parse_occurred_at
from app.models import Transaction


def compute_idempotency_key(
    user_id: int,
    amount: Decimal,
    category: str,
    note: str | None,
    occurred_at: str | None,
) -> str:
    """Derive a stable key from the record identity (first 16 sha256 chars)."""
    raw = "|".join(
        [
            str(user_id),
            str(amount),
            category or "",
            note or "",
            occurred_at or "",
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


async def _find_existing(
    session: AsyncSession, user_id: int, idempotency_key: str
) -> Transaction | None:
    return await session.scalar(
        select(Transaction).where(
            Transaction.user_id == user_id,
            Transaction.idempotency_key == idempotency_key,
        )
    )


async def _resolve_ledger_id(
    session: AsyncSession, user_id: int, ledger_id: int | None
) -> int:
    if ledger_id is not None:
        ledger = await get_owned_ledger(session, user_id, ledger_id)
        if ledger is None:
            raise ValueError("账本不存在")
        return ledger.id
    return (await get_or_create_default_ledger(session, user_id)).id


def _dataset_ref(record: Transaction) -> dict:
    return {
        "record_id": record.id,
        "amount": str(record.amount),
        "category": record.category,
        "occurred_at": record.occurred_at.isoformat() if record.occurred_at else None,
    }


def _success_payload(record: Transaction, *, created: bool) -> dict:
    message = (
        f"已记账：{record.category} {record.amount} 元"
        if created
        else f"记录已存在（幂等），未重复写入：{record.category} {record.amount} 元"
    )
    return {
        "content": message,
        "context": "",
        "dataset_refs": [_dataset_ref(record)],
    }


async def insert_record(
    session: AsyncSession,
    *,
    user_id: int,
    type: str,
    category: str,
    amount: Decimal,
    currency: str = "CNY",
    ledger_id: int | None = None,
    note: str | None = None,
    occurred_at: str | None = None,
    income_source: str | None = None,
    idempotency_key: str,
) -> Transaction:
    """Idempotently insert a transaction, returning the existing row if present."""
    existing = await _find_existing(session, user_id, idempotency_key)
    if existing is not None:
        return existing

    resolved_ledger_id = await _resolve_ledger_id(session, user_id, ledger_id)
    record = Transaction(
        user_id=user_id,
        ledger_id=resolved_ledger_id,
        type=type,
        category=category,
        amount=amount,
        currency=currency or "CNY",
        note=note,
        income_source=(income_source if type == "income" else None),
        occurred_at=_parse_occurred_at(occurred_at) or datetime.now(),
        idempotency_key=idempotency_key,
    )
    session.add(record)
    await session.commit()
    await session.refresh(record)
    return record


def create_create_record_tool(
    session_factory: async_sessionmaker[AsyncSession],
    settings,
) -> BaseTool:
    @tool
    async def create_record(
        user_id: int,
        category: str,
        amount: Decimal,
        type: str = "expense",
        currency: str = "CNY",
        ledger_id: int | None = None,
        note: str | None = None,
        occurred_at: str | None = None,
        income_source: str | None = None,
        idempotency_key: str | None = None,
    ) -> str:
        """为用户新增一笔收入或支出记录并落库（幂等）。

        边界：只写 transactions 表，不改预算、目标或账本，不返回投资建议。
        输入约束：category 必填，amount 必须为正数（两位小数），type 限 income/expense；
        income 类型可带 income_source（salary/bonus/part_time/investment/other）。
        禁忌：金额≤0 会被拒绝；同一输入重复提交只落一笔（幂等）；不提供投资建议。
        """
        payload = RecordCreate(
            type=type,
            category=category,
            amount=amount,
            currency=currency,
            ledger_id=ledger_id,
            note=note,
            occurred_at=occurred_at,
            income_source=income_source,
        )
        key = idempotency_key or compute_idempotency_key(
            user_id,
            payload.amount,
            payload.category,
            payload.note,
            str(payload.occurred_at) if payload.occurred_at is not None else None,
        )

        async with session_factory() as session:
            existing = await _find_existing(session, user_id, key)
            if existing is not None:
                return json.dumps(
                    _success_payload(existing, created=False),
                    ensure_ascii=False,
                    default=str,
                )

            first = await is_first_category(session, user_id, payload.category)
            decision = confirm_required(
                {
                    "amount": payload.amount,
                    "category": payload.category,
                    "note": payload.note,
                },
                settings,
                is_first_category=first,
            )
            if decision["confirm_required"]:
                return json.dumps(
                    {
                        "confirm_required": True,
                        "reason": decision["reason"],
                        "idempotency_key": key,
                        "content": f"该记账需人工确认：{decision['reason']}",
                        "context": "",
                        "dataset_refs": [],
                    },
                    ensure_ascii=False,
                    default=str,
                )

            record = await insert_record(
                session,
                user_id=user_id,
                type=payload.type,
                category=payload.category,
                amount=payload.amount,
                currency=payload.currency or "CNY",
                ledger_id=payload.ledger_id,
                note=payload.note,
                occurred_at=str(payload.occurred_at)
                if payload.occurred_at is not None
                else None,
                income_source=payload.income_source,
                idempotency_key=key,
            )
            return json.dumps(
                _success_payload(record, created=True),
                ensure_ascii=False,
                default=str,
            )

    return create_record
