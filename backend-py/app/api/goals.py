"""Savings-goal CRUD (``/api/goals``) plus the legacy budget endpoints.

The legacy Vue client reads goals via ``/api/goals`` and budgets via
``/api/goals/budgets``. Budget logic lives in budgets.py and is reused here.
"""

from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.budgets import list_budgets, upsert_budget
from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Goal

router = APIRouter(prefix="/api/goals", tags=["goals"])

MONEY = Decimal("0.01")


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _serialize_goal(goal: Goal) -> dict:
    target_date = goal.target_date
    return {
        "id": goal.id,
        "user_id": goal.user_id,
        "name": goal.name,
        "target_amount": str(goal.target_amount),
        "current_amount": str(goal.current_amount),
        "target_date": target_date.isoformat() if target_date else None,
        "deadline": target_date.isoformat() if target_date else None,
        "completed": 1 if goal.current_amount >= goal.target_amount else 0,
        "created_at": goal.created_at.isoformat() if goal.created_at else None,
    }


class GoalCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    target_amount: Decimal
    current_amount: Decimal = Decimal("0")
    target_date: str | None = Field(
        default=None, validation_alias=AliasChoices("target_date", "deadline")
    )


class GoalUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str | None = None
    target_amount: Decimal | None = None
    current_amount: Decimal | None = None
    target_date: str | None = Field(
        default=None, validation_alias=AliasChoices("target_date", "deadline")
    )
    completed: int | bool | None = None


class BudgetSetRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    category: str | None = None
    amount: Decimal
    period: str = "monthly"
    ledger_id: int | None = Field(
        default=None, validation_alias=AliasChoices("ledger_id", "ledgerId")
    )


@router.get("")
async def get_goals(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    ledger_id: int | None = Query(default=None, alias="ledgerId"),
) -> dict:
    statement = (
        select(Goal)
        .where(Goal.user_id == user_id)
        .order_by(Goal.created_at.desc(), Goal.id.desc())
    )
    goals = list((await db.scalars(statement)).all())
    # The SQL model has no ledger column; the query param is accepted for
    # legacy compatibility and simply ignored.
    return {"success": True, "data": [_serialize_goal(goal) for goal in goals]}


@router.post("")
async def create_goal(
    payload: GoalCreate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not payload.name:
        raise HTTPException(status_code=400, detail="缺少目标名称")
    if payload.target_amount <= 0:
        raise HTTPException(status_code=400, detail="目标金额必须大于0")

    target_date = (
        date.fromisoformat(payload.target_date)
        if payload.target_date
        else date.today() + timedelta(days=365)
    )
    goal = Goal(
        user_id=user_id,
        name=payload.name,
        target_amount=_money(payload.target_amount),
        current_amount=_money(payload.current_amount or Decimal("0")),
        target_date=target_date,
    )
    db.add(goal)
    await db.commit()
    await db.refresh(goal)
    return {"success": True, "data": _serialize_goal(goal)}


async def _get_owned_goal(
    db: AsyncSession, user_id: int, goal_id: int
) -> Goal | None:
    return await db.scalar(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id)
    )


@router.put("/{goal_id}")
async def update_goal(
    goal_id: int,
    payload: GoalUpdate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    goal = await _get_owned_goal(db, user_id, goal_id)
    if goal is None:
        raise HTTPException(status_code=404, detail="目标不存在")

    if payload.name is not None:
        goal.name = payload.name
    if payload.target_amount is not None:
        if payload.target_amount <= 0:
            raise HTTPException(status_code=400, detail="目标金额必须大于0")
        goal.target_amount = _money(payload.target_amount)
    if payload.target_date is not None:
        goal.target_date = date.fromisoformat(payload.target_date)

    if payload.completed:
        goal.current_amount = goal.target_amount
    elif payload.current_amount is not None:
        goal.current_amount = _money(payload.current_amount)

    await db.commit()
    await db.refresh(goal)
    return {"success": True, "data": _serialize_goal(goal)}


@router.delete("/{goal_id}")
async def delete_goal(
    goal_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    goal = await _get_owned_goal(db, user_id, goal_id)
    if goal is None:
        raise HTTPException(status_code=404, detail="目标不存在")
    await db.delete(goal)
    await db.commit()
    return {"success": True, "message": "已删除"}


@router.get("/budgets")
async def get_goal_budgets(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    ledger_id: int | None = Query(default=None, alias="ledgerId"),
) -> dict:
    return {"success": True, "data": await list_budgets(db, user_id, ledger_id)}


@router.post("/budgets")
async def set_goal_budget(
    payload: BudgetSetRequest,
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
