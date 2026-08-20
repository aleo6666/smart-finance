"""Subscription manager (``/api/subscriptions``).

Tracks recurring memberships, computes monthly-equivalent spend and
lists bills due within the next N days.
"""

from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Subscription

router = APIRouter(prefix="/api/subscriptions", tags=["subscriptions"])

MONEY = Decimal("0.01")
MONTHLY_MULTIPLIERS = {"monthly": Decimal("1"), "quarterly": Decimal("1") / Decimal("3"), "yearly": Decimal("1") / Decimal("12")}
BILLING_CYCLES = ["monthly", "quarterly", "yearly"]
STATUSES = ["active", "paused", "cancelled"]


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _serialize(item: Subscription) -> dict:
    return {
        "id": item.id,
        "user_id": item.user_id,
        "name": item.name,
        "category": item.category,
        "amount": str(item.amount),
        "billing_cycle": item.billing_cycle,
        "next_billing_date": item.next_billing_date.isoformat(),
        "status": item.status,
        "notes": item.notes,
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


class SubscriptionCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    category: str | None = None
    amount: Decimal
    billing_cycle: str = "monthly"
    next_billing_date: str
    status: str = "active"
    notes: str | None = None


class SubscriptionUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str | None = None
    category: str | None = None
    amount: Decimal | None = None
    billing_cycle: str | None = None
    next_billing_date: str | None = None
    status: str | None = None
    notes: str | None = None


@router.get("/overview")
async def subscriptions_overview(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    items = list(
        (
            await db.scalars(
                select(Subscription).where(Subscription.user_id == user_id)
            )
        ).all()
    )
    active = [i for i in items if i.status == "active"]
    monthly_equivalent = sum(
        (
            i.amount * MONTHLY_MULTIPLIERS[i.billing_cycle]
            for i in active
            if i.billing_cycle in MONTHLY_MULTIPLIERS
        ),
        Decimal("0"),
    )
    today = date.today()
    due_soon = [
        _serialize(i)
        for i in active
        if i.next_billing_date >= today
        and i.next_billing_date <= today + timedelta(days=30)
    ]
    due_soon.sort(key=lambda s: s["next_billing_date"])
    return {
        "success": True,
        "data": {
            "count": len(active),
            "monthly_equivalent": str(_money(monthly_equivalent)),
            "yearly_equivalent": str(_money(monthly_equivalent * Decimal("12"))),
            "due_soon": due_soon,
        },
    }


@router.get("")
async def get_subscriptions(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    status: str | None = Query(default=None),
) -> dict:
    statement = select(Subscription).where(Subscription.user_id == user_id)
    if status:
        statement = statement.where(Subscription.status == status)
    items = list(
        (
            await db.scalars(
                statement.order_by(Subscription.next_billing_date.asc(), Subscription.id.asc())
            )
        ).all()
    )
    return {"success": True, "data": [_serialize(item) for item in items]}


@router.get("/upcoming")
async def get_upcoming(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    days: int = Query(default=30, ge=1, le=365),
) -> dict:
    today = date.today()
    items = list(
        (
            await db.scalars(
                select(Subscription)
                .where(
                    Subscription.user_id == user_id,
                    Subscription.status == "active",
                    Subscription.next_billing_date >= today,
                    Subscription.next_billing_date <= today + timedelta(days=days),
                )
                .order_by(Subscription.next_billing_date.asc())
            )
        ).all()
    )
    return {"success": True, "data": [_serialize(item) for item in items]}


@router.post("")
async def create_subscription(
    payload: SubscriptionCreate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not payload.name:
        raise HTTPException(status_code=400, detail="缺少订阅名称")
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="金额必须大于0")
    if payload.billing_cycle not in BILLING_CYCLES:
        raise HTTPException(status_code=400, detail="不支持的计费周期")
    if payload.status not in STATUSES:
        raise HTTPException(status_code=400, detail="不支持的状态")
    item = Subscription(
        user_id=user_id,
        name=payload.name,
        category=payload.category,
        amount=_money(payload.amount),
        billing_cycle=payload.billing_cycle,
        next_billing_date=date.fromisoformat(payload.next_billing_date),
        status=payload.status,
        notes=payload.notes,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return {"success": True, "data": _serialize(item)}


@router.put("/{subscription_id}")
async def update_subscription(
    subscription_id: int,
    payload: SubscriptionUpdate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await db.scalar(
        select(Subscription).where(
            Subscription.id == subscription_id,
            Subscription.user_id == user_id,
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="订阅不存在")
    if payload.name is not None:
        item.name = payload.name
    if payload.category is not None:
        item.category = payload.category
    if payload.amount is not None:
        if payload.amount <= 0:
            raise HTTPException(status_code=400, detail="金额必须大于0")
        item.amount = _money(payload.amount)
    if payload.billing_cycle is not None:
        if payload.billing_cycle not in BILLING_CYCLES:
            raise HTTPException(status_code=400, detail="不支持的计费周期")
        item.billing_cycle = payload.billing_cycle
    if payload.next_billing_date is not None:
        item.next_billing_date = date.fromisoformat(payload.next_billing_date)
    if payload.status is not None:
        if payload.status not in STATUSES:
            raise HTTPException(status_code=400, detail="不支持的状态")
        item.status = payload.status
    if payload.notes is not None:
        item.notes = payload.notes
    await db.commit()
    await db.refresh(item)
    return {"success": True, "data": _serialize(item)}


@router.delete("/{subscription_id}")
async def delete_subscription(
    subscription_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await db.scalar(
        select(Subscription).where(
            Subscription.id == subscription_id,
            Subscription.user_id == user_id,
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="订阅不存在")
    await db.delete(item)
    await db.commit()
    return {"success": True, "message": "已删除"}
