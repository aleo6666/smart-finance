"""Transaction CRUD (legacy ``/api/records`` contract).

Request/response field names stay compatible with the legacy Node backend:
the canonical Python model uses ``note``/``occurred_at``/``ledger_id`` while
the Vue client still sends ``description``/``date``/``ledgerId``. Both spellings
are accepted on input and emitted on output.
"""

from datetime import date, datetime, time
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_or_create_default_ledger, get_owned_ledger
from app.core.database import get_db
from app.models import Transaction

router = APIRouter(prefix="/api/records", tags=["records"])

MONEY = Decimal("0.01")
INCOME_SOURCES = {"salary", "bonus", "part_time", "investment", "other"}


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _parse_occurred_at(value: str | datetime | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    text = value.strip()
    if not text:
        return None
    if len(text) == 10:  # YYYY-MM-DD
        return datetime.combine(date.fromisoformat(text), time.min)
    return datetime.fromisoformat(text)


def _serialize_record(record: Transaction) -> dict:
    occurred_at = record.occurred_at
    amount = str(record.amount)
    return {
        "id": record.id,
        "ledger_id": record.ledger_id,
        "ledgerId": record.ledger_id,
        "type": record.type,
        "category": record.category,
        "amount": amount,
        "currency": record.currency,
        "note": record.note,
        "description": record.note or "",
        "income_source": record.income_source,
        "occurred_at": occurred_at.isoformat() if occurred_at else None,
        "date": occurred_at.strftime("%Y-%m-%d") if occurred_at else None,
        "amount_cny": amount,
        "merchant": None,
        "project": None,
        "member": None,
        "created_at": record.created_at.isoformat() if record.created_at else None,
    }


class RecordCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str = "expense"
    category: str
    amount: Decimal
    currency: str = "CNY"
    ledger_id: int | None = Field(
        default=None, validation_alias=AliasChoices("ledger_id", "ledgerId")
    )
    note: str | None = Field(
        default=None, validation_alias=AliasChoices("note", "description")
    )
    occurred_at: str | datetime | None = Field(
        default=None, validation_alias=AliasChoices("occurred_at", "date")
    )
    income_source: str | None = None

    @field_validator("type")
    @classmethod
    def _validate_type(cls, value: str) -> str:
        if value not in {"income", "expense"}:
            raise ValueError("type must be income or expense")
        return value

    @field_validator("amount")
    @classmethod
    def _validate_amount(cls, value: Decimal) -> Decimal:
        quantized = _money(value)
        if quantized <= 0:
            raise ValueError("amount must be positive")
        return quantized

    @field_validator("income_source")
    @classmethod
    def _validate_income_source(cls, value: str | None) -> str | None:
        if value is not None and value not in INCOME_SOURCES:
            raise ValueError("invalid income_source")
        return value


class RecordUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str | None = None
    category: str | None = None
    amount: Decimal | None = None
    currency: str | None = None
    ledger_id: int | None = Field(
        default=None, validation_alias=AliasChoices("ledger_id", "ledgerId")
    )
    note: str | None = Field(
        default=None, validation_alias=AliasChoices("note", "description")
    )
    occurred_at: str | datetime | None = Field(
        default=None, validation_alias=AliasChoices("occurred_at", "date")
    )
    income_source: str | None = None

    @field_validator("type")
    @classmethod
    def _validate_type(cls, value: str | None) -> str | None:
        if value is not None and value not in {"income", "expense"}:
            raise ValueError("type must be income or expense")
        return value

    @field_validator("amount")
    @classmethod
    def _validate_amount(cls, value: Decimal | None) -> Decimal | None:
        if value is None:
            return None
        quantized = _money(value)
        if quantized <= 0:
            raise ValueError("amount must be positive")
        return quantized


async def _get_owned_record(
    db: AsyncSession, user_id: int, record_id: int
) -> Transaction | None:
    return await db.scalar(
        select(Transaction).where(
            Transaction.id == record_id,
            Transaction.user_id == user_id,
        )
    )


@router.get("")
async def list_records(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    ledger_id: int | None = Query(default=None, alias="ledgerId"),
    start_date: str | None = Query(default=None, alias="startDate"),
    end_date: str | None = Query(default=None, alias="endDate"),
    category: str | None = Query(default=None),
    type: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int | None = Query(default=None, alias="pageSize", ge=1),
    limit: int | None = Query(default=None, ge=1),
) -> dict:
    effective_limit = limit or page_size or 50
    statement = select(Transaction).where(Transaction.user_id == user_id)

    if ledger_id is not None:
        statement = statement.where(Transaction.ledger_id == ledger_id)
    if start_date is not None:
        statement = statement.where(
            Transaction.occurred_at >= datetime.combine(date.fromisoformat(start_date), time.min)
        )
    if end_date is not None:
        statement = statement.where(
            Transaction.occurred_at <= datetime.combine(date.fromisoformat(end_date), time.max)
        )
    if category is not None:
        statement = statement.where(Transaction.category == category)
    if type is not None:
        statement = statement.where(Transaction.type == type)

    statement = (
        statement.order_by(Transaction.occurred_at.desc(), Transaction.id.desc())
        .limit(effective_limit)
        .offset((page - 1) * effective_limit)
    )
    records = list((await db.scalars(statement)).all())
    return {"success": True, "data": [_serialize_record(record) for record in records]}


@router.post("")
async def create_record(
    payload: RecordCreate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if payload.ledger_id is not None:
        ledger = await get_owned_ledger(db, user_id, payload.ledger_id)
        if ledger is None:
            raise HTTPException(status_code=404, detail="账本不存在")
        ledger_id = ledger.id
    else:
        ledger_id = (await get_or_create_default_ledger(db, user_id)).id

    income_source = payload.income_source if payload.type == "income" else None
    record = Transaction(
        user_id=user_id,
        ledger_id=ledger_id,
        type=payload.type,
        category=payload.category,
        amount=payload.amount,
        currency=payload.currency or "CNY",
        note=payload.note,
        income_source=income_source,
        occurred_at=_parse_occurred_at(payload.occurred_at) or datetime.now(),
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)
    return {"success": True, "data": _serialize_record(record)}


@router.get("/stats")
async def record_stats(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    ledger_id: int | None = Query(default=None, alias="ledgerId"),
    start_date: str | None = Query(default=None, alias="startDate"),
    end_date: str | None = Query(default=None, alias="endDate"),
) -> dict:
    statement = select(Transaction).where(Transaction.user_id == user_id)
    if ledger_id is not None:
        statement = statement.where(Transaction.ledger_id == ledger_id)
    if start_date is not None:
        statement = statement.where(
            Transaction.occurred_at >= datetime.combine(date.fromisoformat(start_date), time.min)
        )
    if end_date is not None:
        statement = statement.where(
            Transaction.occurred_at <= datetime.combine(date.fromisoformat(end_date), time.max)
        )

    rows = list((await db.scalars(statement)).all())
    income = Decimal("0")
    expense = Decimal("0")
    category_totals: dict[str, Decimal] = {}
    for record in rows:
        if record.type == "income":
            income += record.amount
        else:
            expense += record.amount
            category_totals[record.category] = (
                category_totals.get(record.category, Decimal("0")) + record.amount
            )

    categories = [
        {"category": category, "amount": str(_money(total))}
        for category, total in sorted(
            category_totals.items(), key=lambda item: item[1], reverse=True
        )
    ]
    return {
        "success": True,
        "data": {
            "income": str(_money(income)),
            "expense": str(_money(expense)),
            "count": len(rows),
            "categories": categories,
        },
    }


@router.put("/{record_id}")
async def update_record(
    record_id: int,
    payload: RecordUpdate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    record = await _get_owned_record(db, user_id, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="记录不存在")

    if payload.type is not None:
        record.type = payload.type
    if payload.category is not None:
        record.category = payload.category
    if payload.amount is not None:
        record.amount = payload.amount
    if payload.currency is not None:
        record.currency = payload.currency
    if payload.ledger_id is not None:
        ledger = await get_owned_ledger(db, user_id, payload.ledger_id)
        if ledger is None:
            raise HTTPException(status_code=404, detail="账本不存在")
        record.ledger_id = ledger.id
    if payload.note is not None:
        record.note = payload.note
    if payload.occurred_at is not None:
        record.occurred_at = _parse_occurred_at(payload.occurred_at)
    if payload.income_source is not None:
        record.income_source = (
            payload.income_source if record.type == "income" else None
        )
    if record.type == "expense":
        record.income_source = None

    await db.commit()
    await db.refresh(record)
    return {"success": True, "data": _serialize_record(record)}


@router.delete("/{record_id}")
async def delete_record(
    record_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    record = await _get_owned_record(db, user_id, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    await db.delete(record)
    await db.commit()
    return {"success": True}
