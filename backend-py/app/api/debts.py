"""Debt repayment planning (``/api/debts``).

Reuses the ``liabilities`` table (credit_card / loan / mortgage / other)
and adds repayment-plan math on top: payoff months, monthly interest and
a suggested repayment order by interest rate.
"""

import math
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Liability

router = APIRouter(prefix="/api/debts", tags=["debts"])

MONEY = Decimal("0.01")
MONTHS_IN_YEAR = Decimal("12")
LIABILITY_TYPES = ["credit_card", "loan", "mortgage", "other"]


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _serialize(item: Liability) -> dict:
    return {
        "id": item.id,
        "user_id": item.user_id,
        "type": item.type,
        "name": item.name,
        "amount": str(item.amount),
        "interest_rate": str(item.interest_rate) if item.interest_rate is not None else None,
        "monthly_payment": str(item.monthly_payment) if item.monthly_payment is not None else None,
        "due_date": item.due_date.isoformat() if item.due_date else None,
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


def _plan(item: Liability) -> dict:
    """Estimate payoff timeline and monthly interest for one debt."""
    amount = item.amount
    monthly = item.monthly_payment
    rate = item.interest_rate  # 年化利率（如 0.18 表示 18%）
    serialized = _serialize(item)
    monthly_interest = (
        amount * rate / MONTHS_IN_YEAR if rate is not None else Decimal("0")
    )
    serialized["monthly_interest"] = str(_money(monthly_interest))

    if monthly is None or monthly <= 0:
        serialized["payoff_months"] = None
        serialized["repayment_advice"] = "设置月供后可估算还清时间"
        return serialized
    if monthly <= monthly_interest:
        serialized["payoff_months"] = None
        serialized["repayment_advice"] = "月供低于利息，本金无法减少，需提高月供"
        return serialized
    if rate is None or rate == 0:
        payoff_months = int(math.ceil(amount / monthly))
    else:
        r = rate / MONTHS_IN_YEAR
        ratio = 1 - amount * r / monthly
        if ratio <= 0:
            payoff_months = None
        else:
            payoff_months = int(math.ceil(-math.log(ratio) / math.log(1 + r)))
    serialized["payoff_months"] = payoff_months
    serialized["repayment_advice"] = (
        f"按当前月供约需 {payoff_months} 个月还清，建议优先偿还高息负债"
        if payoff_months is not None
        else "建议提高月供以加快还清"
    )
    return serialized


class DebtCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str
    name: str
    amount: Decimal
    interest_rate: Decimal | None = None
    monthly_payment: Decimal | None = None
    due_date: str | None = None


class DebtUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str | None = None
    name: str | None = None
    amount: Decimal | None = None
    interest_rate: Decimal | None = None
    monthly_payment: Decimal | None = None
    due_date: str | None = None


async def _get_owned(db: AsyncSession, user_id: int, debt_id: int) -> Liability | None:
    return await db.scalar(
        select(Liability).where(Liability.id == debt_id, Liability.user_id == user_id)
    )


@router.get("/overview")
async def debts_overview(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    items = list(
        (await db.scalars(select(Liability).where(Liability.user_id == user_id))).all()
    )
    total = sum((i.amount for i in items), Decimal("0"))
    total_monthly = sum(
        (i.monthly_payment for i in items if i.monthly_payment is not None),
        Decimal("0"),
    )
    plan = [
        _plan(item)
        for item in items
        if item.monthly_payment and item.monthly_payment > 0
    ]
    # 高利率优先：按年化利率降序排列
    plan.sort(
        key=lambda p: Decimal(p["interest_rate"]) if p["interest_rate"] else Decimal("0"),
        reverse=True,
    )
    return {
        "success": True,
        "data": {
            "total_debt": str(_money(total)),
            "total_monthly_payment": str(_money(total_monthly)),
            "debt_count": len(items),
            "repayment_plan": plan,
        },
    }


@router.get("")
async def get_debts(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    items = list(
        (
            await db.scalars(
                select(Liability)
                .where(Liability.user_id == user_id)
                .order_by(Liability.created_at.desc(), Liability.id.desc())
            )
        ).all()
    )
    return {"success": True, "data": [_plan(item) for item in items]}


@router.post("")
async def create_debt(
    payload: DebtCreate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if payload.type not in LIABILITY_TYPES:
        raise HTTPException(status_code=400, detail="不支持的负债类型")
    if not payload.name:
        raise HTTPException(status_code=400, detail="缺少负债名称")
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="负债金额必须大于0")
    item = Liability(
        user_id=user_id,
        type=payload.type,
        name=payload.name,
        amount=_money(payload.amount),
        interest_rate=payload.interest_rate,
        monthly_payment=payload.monthly_payment,
        due_date=_parse_date(payload.due_date),
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return {"success": True, "data": _plan(item)}


@router.put("/{debt_id}")
async def update_debt(
    debt_id: int,
    payload: DebtUpdate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await _get_owned(db, user_id, debt_id)
    if item is None:
        raise HTTPException(status_code=404, detail="负债不存在")
    if payload.type is not None:
        if payload.type not in LIABILITY_TYPES:
            raise HTTPException(status_code=400, detail="不支持的负债类型")
        item.type = payload.type
    if payload.name is not None:
        item.name = payload.name
    if payload.amount is not None:
        if payload.amount <= 0:
            raise HTTPException(status_code=400, detail="负债金额必须大于0")
        item.amount = _money(payload.amount)
    if payload.interest_rate is not None:
        item.interest_rate = payload.interest_rate
    if payload.monthly_payment is not None:
        item.monthly_payment = payload.monthly_payment
    if payload.due_date is not None:
        item.due_date = _parse_date(payload.due_date)
    await db.commit()
    await db.refresh(item)
    return {"success": True, "data": _plan(item)}


@router.delete("/{debt_id}")
async def delete_debt(
    debt_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await _get_owned(db, user_id, debt_id)
    if item is None:
        raise HTTPException(status_code=404, detail="负债不存在")
    await db.delete(item)
    await db.commit()
    return {"success": True, "message": "已删除"}


def _parse_date(value: str | None):
    from datetime import date

    if not value:
        return None
    return date.fromisoformat(value)
