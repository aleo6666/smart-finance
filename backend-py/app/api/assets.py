"""Asset and liability CRUD (``/api/assets``) plus a net-worth overview.

The legacy Vue AssetsPanel page calls ``/api/assets/overview`` and
``/api/assets``; the Python backend previously had the tables but no API.
"""

from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Asset, Liability

router = APIRouter(prefix="/api/assets", tags=["assets"])

MONEY = Decimal("0.01")
ASSET_TYPES = ["cash", "bank_deposit", "investment", "property", "vehicle", "other"]
LIABILITY_TYPES = ["credit_card", "loan", "mortgage", "other"]


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _serialize_asset(asset: Asset) -> dict:
    return {
        "id": asset.id,
        "user_id": asset.user_id,
        "type": asset.type,
        "name": asset.name,
        "amount": str(asset.amount),
        "currency": asset.currency,
        "acquired_date": asset.acquired_date.isoformat() if asset.acquired_date else None,
        "notes": asset.notes,
        "created_at": asset.created_at.isoformat() if asset.created_at else None,
    }


def _serialize_liability(liability: Liability) -> dict:
    return {
        "id": liability.id,
        "user_id": liability.user_id,
        "type": liability.type,
        "name": liability.name,
        "amount": str(liability.amount),
        "interest_rate": str(liability.interest_rate) if liability.interest_rate is not None else None,
        "monthly_payment": str(liability.monthly_payment) if liability.monthly_payment is not None else None,
        "due_date": liability.due_date.isoformat() if liability.due_date else None,
        "created_at": liability.created_at.isoformat() if liability.created_at else None,
    }


class AssetCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str
    name: str
    amount: Decimal
    currency: str = "CNY"
    acquired_date: str | None = None
    notes: str | None = None


class AssetUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str | None = None
    name: str | None = None
    amount: Decimal | None = None
    currency: str | None = None
    acquired_date: str | None = None
    notes: str | None = None


class LiabilityCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str
    name: str
    amount: Decimal
    interest_rate: Decimal | None = None
    monthly_payment: Decimal | None = None
    due_date: str | None = None


class LiabilityUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str | None = None
    name: str | None = None
    amount: Decimal | None = None
    interest_rate: Decimal | None = None
    monthly_payment: Decimal | None = None
    due_date: str | None = None


@router.get("/overview")
async def assets_overview(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    assets = list(
        (await db.scalars(select(Asset).where(Asset.user_id == user_id))).all()
    )
    liabilities = list(
        (
            await db.scalars(
                select(Liability).where(Liability.user_id == user_id)
            )
        ).all()
    )
    total_assets = sum((a.amount for a in assets), Decimal("0"))
    total_liabilities = sum((li.amount for li in liabilities), Decimal("0"))
    return {
        "success": True,
        "data": {
            "total_assets": str(_money(total_assets)),
            "total_liabilities": str(_money(total_liabilities)),
            "net_worth": str(_money(total_assets - total_liabilities)),
            "asset_count": len(assets),
            "liability_count": len(liabilities),
        },
    }


@router.get("")
async def get_assets(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    include_liabilities: bool = Query(default=True, alias="includeLiabilities"),
) -> dict:
    assets = list(
        (
            await db.scalars(
                select(Asset)
                .where(Asset.user_id == user_id)
                .order_by(Asset.created_at.desc(), Asset.id.desc())
            )
        ).all()
    )
    data: dict = {"assets": [_serialize_asset(a) for a in assets]}
    if include_liabilities:
        liabilities = list(
            (
                await db.scalars(
                    select(Liability)
                    .where(Liability.user_id == user_id)
                    .order_by(Liability.created_at.desc(), Liability.id.desc())
                )
            ).all()
        )
        data["liabilities"] = [_serialize_liability(li) for li in liabilities]
    return {"success": True, "data": data}


@router.post("")
async def create_asset(
    payload: AssetCreate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if payload.type not in ASSET_TYPES:
        raise HTTPException(status_code=400, detail="不支持的资产类型")
    if not payload.name:
        raise HTTPException(status_code=400, detail="缺少资产名称")
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="资产金额必须大于0")

    asset = Asset(
        user_id=user_id,
        type=payload.type,
        name=payload.name,
        amount=_money(payload.amount),
        currency=payload.currency or "CNY",
        acquired_date=date.fromisoformat(payload.acquired_date)
        if payload.acquired_date
        else None,
        notes=payload.notes,
    )
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    return {"success": True, "data": _serialize_asset(asset)}


@router.put("/{asset_id}")
async def update_asset(
    asset_id: int,
    payload: AssetUpdate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    asset = await db.scalar(
        select(Asset).where(Asset.id == asset_id, Asset.user_id == user_id)
    )
    if asset is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    if payload.type is not None:
        if payload.type not in ASSET_TYPES:
            raise HTTPException(status_code=400, detail="不支持的资产类型")
        asset.type = payload.type
    if payload.name is not None:
        asset.name = payload.name
    if payload.amount is not None:
        if payload.amount <= 0:
            raise HTTPException(status_code=400, detail="资产金额必须大于0")
        asset.amount = _money(payload.amount)
    if payload.currency is not None:
        asset.currency = payload.currency
    if payload.acquired_date is not None:
        asset.acquired_date = date.fromisoformat(payload.acquired_date)
    if payload.notes is not None:
        asset.notes = payload.notes
    await db.commit()
    await db.refresh(asset)
    return {"success": True, "data": _serialize_asset(asset)}


@router.delete("/{asset_id}")
async def delete_asset(
    asset_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    asset = await db.scalar(
        select(Asset).where(Asset.id == asset_id, Asset.user_id == user_id)
    )
    if asset is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    await db.delete(asset)
    await db.commit()
    return {"success": True, "message": "已删除"}


@router.get("/liabilities")
async def get_liabilities(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    liabilities = list(
        (
            await db.scalars(
                select(Liability)
                .where(Liability.user_id == user_id)
                .order_by(Liability.created_at.desc(), Liability.id.desc())
            )
        ).all()
    )
    return {
        "success": True,
        "data": [_serialize_liability(li) for li in liabilities],
    }


@router.post("/liabilities")
async def create_liability(
    payload: LiabilityCreate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if payload.type not in LIABILITY_TYPES:
        raise HTTPException(status_code=400, detail="不支持的负债类型")
    if not payload.name:
        raise HTTPException(status_code=400, detail="缺少负债名称")
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="负债金额必须大于0")

    liability = Liability(
        user_id=user_id,
        type=payload.type,
        name=payload.name,
        amount=_money(payload.amount),
        interest_rate=payload.interest_rate,
        monthly_payment=payload.monthly_payment,
        due_date=date.fromisoformat(payload.due_date) if payload.due_date else None,
    )
    db.add(liability)
    await db.commit()
    await db.refresh(liability)
    return {"success": True, "data": _serialize_liability(liability)}


@router.put("/liabilities/{liability_id}")
async def update_liability(
    liability_id: int,
    payload: LiabilityUpdate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    liability = await db.scalar(
        select(Liability).where(
            Liability.id == liability_id, Liability.user_id == user_id
        )
    )
    if liability is None:
        raise HTTPException(status_code=404, detail="负债不存在")
    if payload.type is not None:
        if payload.type not in LIABILITY_TYPES:
            raise HTTPException(status_code=400, detail="不支持的负债类型")
        liability.type = payload.type
    if payload.name is not None:
        liability.name = payload.name
    if payload.amount is not None:
        if payload.amount <= 0:
            raise HTTPException(status_code=400, detail="负债金额必须大于0")
        liability.amount = _money(payload.amount)
    if payload.interest_rate is not None:
        liability.interest_rate = payload.interest_rate
    if payload.monthly_payment is not None:
        liability.monthly_payment = payload.monthly_payment
    if payload.due_date is not None:
        liability.due_date = date.fromisoformat(payload.due_date)
    await db.commit()
    await db.refresh(liability)
    return {"success": True, "data": _serialize_liability(liability)}


@router.delete("/liabilities/{liability_id}")
async def delete_liability(
    liability_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    liability = await db.scalar(
        select(Liability).where(
            Liability.id == liability_id, Liability.user_id == user_id
        )
    )
    if liability is None:
        raise HTTPException(status_code=404, detail="负债不存在")
    await db.delete(liability)
    await db.commit()
    return {"success": True, "message": "已删除"}
