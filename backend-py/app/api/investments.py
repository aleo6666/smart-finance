"""Investment portfolio CRUD (``/api/investments``) with P&L overview."""

from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Investment

router = APIRouter(prefix="/api/investments", tags=["investments"])

MONEY = Decimal("0.01")
INVESTMENT_TYPES = ["fund", "stock", "bond", "gold", "crypto", "other"]


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _serialize(item: Investment) -> dict:
    cost = item.cost_price * item.quantity
    current = (
        (item.current_price * item.quantity) if item.current_price is not None else None
    )
    return {
        "id": item.id,
        "user_id": item.user_id,
        "name": item.name,
        "symbol": item.symbol,
        "type": item.type,
        "quantity": str(item.quantity),
        "cost_price": str(item.cost_price),
        "current_price": str(item.current_price) if item.current_price is not None else None,
        "currency": item.currency,
        "acquired_date": item.acquired_date.isoformat() if item.acquired_date else None,
        "notes": item.notes,
        "cost_value": str(_money(cost)),
        "current_value": str(_money(current)) if current is not None else None,
        "profit": str(_money(current - cost)) if current is not None else None,
        "profit_rate": (
            str(((current - cost) / cost).quantize(Decimal("0.0001")))
            if current is not None and cost != 0
            else None
        ),
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


class InvestmentCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    symbol: str | None = None
    type: str
    quantity: Decimal
    cost_price: Decimal
    current_price: Decimal | None = None
    currency: str = "CNY"
    acquired_date: str | None = None
    notes: str | None = None


class InvestmentUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str | None = None
    symbol: str | None = None
    type: str | None = None
    quantity: Decimal | None = None
    cost_price: Decimal | None = None
    current_price: Decimal | None = None
    currency: str | None = None
    acquired_date: str | None = None
    notes: str | None = None


@router.get("/overview")
async def investments_overview(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    items = list(
        (await db.scalars(select(Investment).where(Investment.user_id == user_id))).all()
    )
    total_cost = sum((i.cost_price * i.quantity for i in items), Decimal("0"))
    total_value = sum(
        (
            (i.current_price * i.quantity)
            for i in items
            if i.current_price is not None
        ),
        Decimal("0"),
    )
    priced_count = sum(1 for i in items if i.current_price is not None)
    return {
        "success": True,
        "data": {
            "total_cost": str(_money(total_cost)),
            "total_value": str(_money(total_value)),
            "total_profit": str(_money(total_value - total_cost)),
            "profit_rate": (
                str(((total_value - total_cost) / total_cost).quantize(Decimal("0.0001")))
                if total_cost != 0
                else None
            ),
            "count": len(items),
            "priced_count": priced_count,
        },
    }


@router.get("")
async def get_investments(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    items = list(
        (
            await db.scalars(
                select(Investment)
                .where(Investment.user_id == user_id)
                .order_by(Investment.created_at.desc(), Investment.id.desc())
            )
        ).all()
    )
    return {"success": True, "data": [_serialize(item) for item in items]}


@router.post("")
async def create_investment(
    payload: InvestmentCreate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if payload.type not in INVESTMENT_TYPES:
        raise HTTPException(status_code=400, detail="不支持的投资类型")
    if not payload.name:
        raise HTTPException(status_code=400, detail="缺少投资名称")
    if payload.quantity <= 0:
        raise HTTPException(status_code=400, detail="数量必须大于0")
    if payload.cost_price < 0:
        raise HTTPException(status_code=400, detail="成本价不能为负")

    item = Investment(
        user_id=user_id,
        name=payload.name,
        symbol=payload.symbol,
        type=payload.type,
        quantity=payload.quantity,
        cost_price=payload.cost_price,
        current_price=payload.current_price,
        currency=payload.currency or "CNY",
        acquired_date=date.fromisoformat(payload.acquired_date)
        if payload.acquired_date
        else None,
        notes=payload.notes,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return {"success": True, "data": _serialize(item)}


@router.put("/{investment_id}")
async def update_investment(
    investment_id: int,
    payload: InvestmentUpdate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await db.scalar(
        select(Investment).where(
            Investment.id == investment_id, Investment.user_id == user_id
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="投资不存在")
    if payload.name is not None:
        item.name = payload.name
    if payload.symbol is not None:
        item.symbol = payload.symbol
    if payload.type is not None:
        if payload.type not in INVESTMENT_TYPES:
            raise HTTPException(status_code=400, detail="不支持的投资类型")
        item.type = payload.type
    if payload.quantity is not None:
        if payload.quantity <= 0:
            raise HTTPException(status_code=400, detail="数量必须大于0")
        item.quantity = payload.quantity
    if payload.cost_price is not None:
        if payload.cost_price < 0:
            raise HTTPException(status_code=400, detail="成本价不能为负")
        item.cost_price = payload.cost_price
    if payload.current_price is not None:
        item.current_price = payload.current_price
    if payload.currency is not None:
        item.currency = payload.currency
    if payload.acquired_date is not None:
        item.acquired_date = date.fromisoformat(payload.acquired_date)
    if payload.notes is not None:
        item.notes = payload.notes
    await db.commit()
    await db.refresh(item)
    return {"success": True, "data": _serialize(item)}


@router.delete("/{investment_id}")
async def delete_investment(
    investment_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await db.scalar(
        select(Investment).where(
            Investment.id == investment_id, Investment.user_id == user_id
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="投资不存在")
    await db.delete(item)
    await db.commit()
    return {"success": True, "message": "已删除"}
