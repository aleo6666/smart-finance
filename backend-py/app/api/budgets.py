"""Budget CRUD (``/api/budgets``) plus helpers reused by goals.py.

The legacy frontend talks to ``/api/goals/budgets`` (see goals.py), which reuses
``list_budgets`` / ``upsert_budget`` below. A "total" budget (no category) is
stored with an empty-string category because the SQL model keeps the column
non-null.
"""

import calendar
from datetime import date, datetime, time
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_or_create_default_ledger
from app.core.database import get_db
from app.models import Budget, Transaction

router = APIRouter(prefix="/api/budgets", tags=["budgets"])

TOTAL_BUDGET_CATEGORY = ""


def _current_month_bounds(today: date) -> tuple[datetime, datetime]:
    start = date(today.year, today.month, 1)
    last_day = calendar.monthrange(today.year, today.month)[1]
    end = date(today.year, today.month, last_day)
    return datetime.combine(start, time.min), datetime.combine(end, time.max)


def _period_bounds(period: str, today: date) -> tuple[date, date]:
    if period == "yearly":
        return date(today.year, 1, 1), date(today.year, 12, 31)
    last_day = calendar.monthrange(today.year, today.month)[1]
    return date(today.year, today.month, 1), date(today.year, today.month, last_day)


def _serialize_budget(budget: Budget, spent: Decimal) -> dict:
    percent = (
        int((spent / budget.amount).quantize(Decimal("1"))) if budget.amount > 0 else 0
    )
    return {
        "id": budget.id,
        "user_id": budget.user_id,
        "ledger_id": budget.ledger_id,
        "category": budget.category or None,
        "amount": str(budget.amount),
        "period": budget.period,
        "period_start": budget.period_start.isoformat() if budget.period_start else None,
        "period_end": budget.period_end.isoformat() if budget.period_end else None,
        "spent": str(spent),
        "percent": percent,
        "created_at": budget.created_at.isoformat() if budget.created_at else None,
    }


async def _spend_by_category(
    db: AsyncSession, user_id: int, start: datetime, end: datetime
) -> dict[str, Decimal]:
    rows = (
        await db.execute(
            select(Transaction.category, func.sum(Transaction.amount))
            .where(
                Transaction.user_id == user_id,
                Transaction.type == "expense",
                Transaction.occurred_at >= start,
                Transaction.occurred_at <= end,
            )
            .group_by(Transaction.category)
        )
    ).all()
    totals: dict[str, Decimal] = {}
    for category, amount in rows:
        totals[category or TOTAL_BUDGET_CATEGORY] = Decimal(amount or 0)
    return totals


async def list_budgets(
    db: AsyncSession, user_id: int, ledger_id: int | None = None
) -> list[dict]:
    statement = (
        select(Budget)
        .where(Budget.user_id == user_id)
        .order_by(Budget.created_at.asc(), Budget.id.asc())
    )
    if ledger_id is not None:
        statement = statement.where(Budget.ledger_id == ledger_id)
    budgets = list((await db.scalars(statement)).all())

    month_start, month_end = _current_month_bounds(date.today())
    spend = await _spend_by_category(db, user_id, month_start, month_end)
    total_spend = sum(spend.values(), Decimal("0"))

    result = []
    for budget in budgets:
        spent = (
            total_spend if not budget.category else spend.get(budget.category, Decimal("0"))
        )
        result.append(_serialize_budget(budget, spent))
    return result


async def upsert_budget(
    db: AsyncSession,
    user_id: int,
    *,
    category: str | None,
    amount: Decimal,
    period: str = "monthly",
    ledger_id: int | None = None,
) -> dict:
    normalized_category = (category or "").strip()
    if ledger_id is None:
        ledger_id = (await get_or_create_default_ledger(db, user_id)).id

    existing = await db.scalar(
        select(Budget).where(
            Budget.user_id == user_id,
            Budget.period == period,
            Budget.category == normalized_category,
        )
    )
    if existing is not None:
        existing.amount = amount
        existing.ledger_id = ledger_id
        budget = existing
    else:
        today = date.today()
        period_start, period_end = _period_bounds(period, today)
        budget = Budget(
            user_id=user_id,
            ledger_id=ledger_id,
            category=normalized_category,
            amount=amount,
            period=period,
            period_start=period_start,
            period_end=period_end,
        )
        db.add(budget)
    await db.commit()
    await db.refresh(budget)

    month_start, month_end = _current_month_bounds(date.today())
    spend = await _spend_by_category(db, user_id, month_start, month_end)
    spent = (
        sum(spend.values(), Decimal("0"))
        if not budget.category
        else spend.get(budget.category, Decimal("0"))
    )
    return _serialize_budget(budget, spent)


class BudgetCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    category: str | None = None
    amount: Decimal
    period: str = "monthly"
    ledger_id: int | None = Field(
        default=None, validation_alias=AliasChoices("ledger_id", "ledgerId")
    )


class BudgetUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    category: str | None = None
    amount: Decimal | None = None
    period: str | None = None


@router.get("")
async def get_budgets(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    ledger_id: int | None = Query(default=None, alias="ledgerId"),
) -> dict:
    return {"success": True, "data": await list_budgets(db, user_id, ledger_id)}


@router.post("")
async def create_budget(
    payload: BudgetCreate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="预算金额必须大于0")
    if payload.period not in {"monthly", "yearly"}:
        raise HTTPException(status_code=400, detail="period 必须为 monthly 或 yearly")
    budget = await upsert_budget(
        db,
        user_id,
        category=payload.category,
        amount=payload.amount,
        period=payload.period,
        ledger_id=payload.ledger_id,
    )
    return {"success": True, "data": budget}


async def _get_owned_budget(
    db: AsyncSession, user_id: int, budget_id: int
) -> Budget | None:
    return await db.scalar(
        select(Budget).where(
            Budget.id == budget_id,
            Budget.user_id == user_id,
        )
    )


@router.put("/{budget_id}")
async def update_budget(
    budget_id: int,
    payload: BudgetUpdate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    budget = await _get_owned_budget(db, user_id, budget_id)
    if budget is None:
        raise HTTPException(status_code=404, detail="预算不存在")

    if payload.amount is not None:
        if payload.amount <= 0:
            raise HTTPException(status_code=400, detail="预算金额必须大于0")
        budget.amount = payload.amount
    if payload.category is not None:
        budget.category = (payload.category or "").strip()
    if payload.period is not None:
        if payload.period not in {"monthly", "yearly"}:
            raise HTTPException(status_code=400, detail="period 必须为 monthly 或 yearly")
        budget.period = payload.period
        period_start, period_end = _period_bounds(payload.period, date.today())
        budget.period_start = period_start
        budget.period_end = period_end

    await db.commit()
    await db.refresh(budget)

    month_start, month_end = _current_month_bounds(date.today())
    spend = await _spend_by_category(db, user_id, month_start, month_end)
    spent = (
        sum(spend.values(), Decimal("0"))
        if not budget.category
        else spend.get(budget.category, Decimal("0"))
    )
    return {"success": True, "data": _serialize_budget(budget, spent)}


@router.delete("/{budget_id}")
async def delete_budget(
    budget_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    budget = await _get_owned_budget(db, user_id, budget_id)
    if budget is None:
        raise HTTPException(status_code=404, detail="预算不存在")
    await db.delete(budget)
    await db.commit()
    return {"success": True}
