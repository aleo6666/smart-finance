"""Insurance policy manager (``/api/insurance``).

CRUD for policies plus an overview of coverage totals, annual premiums
and policies expiring / premiums due within 60 days.
"""

from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import InsurancePolicy

router = APIRouter(prefix="/api/insurance", tags=["insurance"])

MONEY = Decimal("0.01")
TYPES = ["人寿", "医疗", "重疾", "意外", "财产", "其他"]
FREQUENCIES = ["yearly", "quarterly", "monthly", "one_time"]
STATUSES = ["active", "expired", "cancelled"]


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _serialize(item: InsurancePolicy) -> dict:
    return {
        "id": item.id,
        "user_id": item.user_id,
        "name": item.name,
        "type": item.type,
        "company": item.company,
        "policy_number": item.policy_number,
        "holder": item.holder,
        "insured_amount": str(item.insured_amount),
        "annual_premium": str(item.annual_premium),
        "payment_frequency": item.payment_frequency,
        "start_date": item.start_date.isoformat() if item.start_date else None,
        "end_date": item.end_date.isoformat() if item.end_date else None,
        "status": item.status,
        "notes": item.notes,
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


class PolicyCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    type: str
    company: str | None = None
    policy_number: str | None = None
    holder: str | None = None
    insured_amount: Decimal
    annual_premium: Decimal
    payment_frequency: str = "yearly"
    start_date: str | None = None
    end_date: str | None = None
    status: str = "active"
    notes: str | None = None


class PolicyUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str | None = None
    type: str | None = None
    company: str | None = None
    policy_number: str | None = None
    holder: str | None = None
    insured_amount: Decimal | None = None
    annual_premium: Decimal | None = None
    payment_frequency: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    status: str | None = None
    notes: str | None = None


@router.get("/overview")
async def insurance_overview(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    items = list(
        (
            await db.scalars(
                select(InsurancePolicy).where(InsurancePolicy.user_id == user_id)
            )
        ).all()
    )
    active = [i for i in items if i.status == "active"]
    total_insured = sum((i.insured_amount for i in active), Decimal("0"))
    total_premium = sum((i.annual_premium for i in active), Decimal("0"))
    today = date.today()
    horizon = today + timedelta(days=60)
    expiring = [
        _serialize(i)
        for i in active
        if i.end_date is not None
        and today <= i.end_date <= horizon
    ]
    expiring.sort(key=lambda p: p["end_date"] or "")
    return {
        "success": True,
        "data": {
            "count": len(active),
            "total_insured": str(_money(total_insured)),
            "total_annual_premium": str(_money(total_premium)),
            "expiring_soon": expiring,
        },
    }


@router.get("")
async def get_policies(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    items = list(
        (
            await db.scalars(
                select(InsurancePolicy)
                .where(InsurancePolicy.user_id == user_id)
                .order_by(InsurancePolicy.created_at.desc(), InsurancePolicy.id.desc())
            )
        ).all()
    )
    return {"success": True, "data": [_serialize(item) for item in items]}


@router.post("")
async def create_policy(
    payload: PolicyCreate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not payload.name:
        raise HTTPException(status_code=400, detail="缺少保单名称")
    if payload.type not in TYPES:
        raise HTTPException(status_code=400, detail="不支持的保单类型")
    if payload.insured_amount < 0:
        raise HTTPException(status_code=400, detail="保额不能为负")
    if payload.annual_premium < 0:
        raise HTTPException(status_code=400, detail="年缴保费不能为负")
    if payload.payment_frequency not in FREQUENCIES:
        raise HTTPException(status_code=400, detail="不支持的缴费频率")
    if payload.status not in STATUSES:
        raise HTTPException(status_code=400, detail="不支持的状态")

    item = InsurancePolicy(
        user_id=user_id,
        name=payload.name,
        type=payload.type,
        company=payload.company,
        policy_number=payload.policy_number,
        holder=payload.holder,
        insured_amount=_money(payload.insured_amount),
        annual_premium=_money(payload.annual_premium),
        payment_frequency=payload.payment_frequency,
        start_date=_parse_date(payload.start_date),
        end_date=_parse_date(payload.end_date),
        status=payload.status,
        notes=payload.notes,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return {"success": True, "data": _serialize(item)}


@router.put("/{policy_id}")
async def update_policy(
    policy_id: int,
    payload: PolicyUpdate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await db.scalar(
        select(InsurancePolicy).where(
            InsurancePolicy.id == policy_id,
            InsurancePolicy.user_id == user_id,
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="保单不存在")
    if payload.name is not None:
        item.name = payload.name
    if payload.type is not None:
        if payload.type not in TYPES:
            raise HTTPException(status_code=400, detail="不支持的保单类型")
        item.type = payload.type
    if payload.company is not None:
        item.company = payload.company
    if payload.policy_number is not None:
        item.policy_number = payload.policy_number
    if payload.holder is not None:
        item.holder = payload.holder
    if payload.insured_amount is not None:
        if payload.insured_amount < 0:
            raise HTTPException(status_code=400, detail="保额不能为负")
        item.insured_amount = _money(payload.insured_amount)
    if payload.annual_premium is not None:
        if payload.annual_premium < 0:
            raise HTTPException(status_code=400, detail="年缴保费不能为负")
        item.annual_premium = _money(payload.annual_premium)
    if payload.payment_frequency is not None:
        if payload.payment_frequency not in FREQUENCIES:
            raise HTTPException(status_code=400, detail="不支持的缴费频率")
        item.payment_frequency = payload.payment_frequency
    if payload.start_date is not None:
        item.start_date = _parse_date(payload.start_date)
    if payload.end_date is not None:
        item.end_date = _parse_date(payload.end_date)
    if payload.status is not None:
        if payload.status not in STATUSES:
            raise HTTPException(status_code=400, detail="不支持的状态")
        item.status = payload.status
    if payload.notes is not None:
        item.notes = payload.notes
    await db.commit()
    await db.refresh(item)
    return {"success": True, "data": _serialize(item)}


@router.delete("/{policy_id}")
async def delete_policy(
    policy_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await db.scalar(
        select(InsurancePolicy).where(
            InsurancePolicy.id == policy_id,
            InsurancePolicy.user_id == user_id,
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="保单不存在")
    await db.delete(item)
    await db.commit()
    return {"success": True, "message": "已删除"}


def _parse_date(value: str | None):
    if not value:
        return None
    return date.fromisoformat(value)
