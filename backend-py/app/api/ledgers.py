"""Ledger CRUD (legacy ``/api/ledgers`` contract)."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Ledger

router = APIRouter(prefix="/api/ledgers", tags=["ledgers"])


def _serialize_ledger(ledger: Ledger) -> dict:
    return {
        "id": ledger.id,
        "user_id": ledger.user_id,
        "name": ledger.name,
        "icon": ledger.icon,
        "color": ledger.color,
        "base_currency": ledger.base_currency,
        "created_at": ledger.created_at.isoformat() if ledger.created_at else None,
    }


class LedgerCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    base_currency: str = Field(default="CNY")
    icon: str | None = None
    color: str | None = None


class LedgerUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str | None = None
    base_currency: str | None = None
    icon: str | None = None
    color: str | None = None


@router.get("")
async def list_ledgers(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    ledgers = list(
        (
            await db.scalars(
                select(Ledger)
                .where(Ledger.user_id == user_id)
                .order_by(Ledger.created_at.asc(), Ledger.id.asc())
            )
        ).all()
    )
    return {"success": True, "data": [_serialize_ledger(item) for item in ledgers]}


@router.post("")
async def create_ledger(
    payload: LedgerCreate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not payload.name:
        raise HTTPException(status_code=400, detail="缺少账本名称")
    ledger = Ledger(
        user_id=user_id,
        name=payload.name,
        base_currency=payload.base_currency or "CNY",
        icon=payload.icon,
        color=payload.color,
    )
    db.add(ledger)
    await db.commit()
    await db.refresh(ledger)
    return {"success": True, "data": _serialize_ledger(ledger)}


async def _get_owned_ledger(
    db: AsyncSession, user_id: int, ledger_id: int
) -> Ledger | None:
    return await db.scalar(
        select(Ledger).where(
            Ledger.id == ledger_id,
            Ledger.user_id == user_id,
        )
    )


@router.put("/{ledger_id}")
async def update_ledger(
    ledger_id: int,
    payload: LedgerUpdate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    ledger = await _get_owned_ledger(db, user_id, ledger_id)
    if ledger is None:
        raise HTTPException(status_code=404, detail="账本不存在")

    if payload.name is not None:
        ledger.name = payload.name
    if payload.base_currency is not None:
        ledger.base_currency = payload.base_currency
    if payload.icon is not None:
        ledger.icon = payload.icon
    if payload.color is not None:
        ledger.color = payload.color

    await db.commit()
    await db.refresh(ledger)
    return {"success": True, "data": _serialize_ledger(ledger)}


@router.delete("/{ledger_id}")
async def delete_ledger(
    ledger_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    ledger = await _get_owned_ledger(db, user_id, ledger_id)
    if ledger is None:
        raise HTTPException(status_code=404, detail="账本不存在")
    await db.delete(ledger)
    await db.commit()
    return {"success": True}
