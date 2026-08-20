"""Tax estimation (``/api/tax``).

Monthly-withholding approximation using the annual comprehensive income
tax brackets converted to monthly equivalents (standard 5000 CNY/month
deduction). Year-end bonus is taxed separately with the simplified rule.
"""

from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import TaxRecord

router = APIRouter(prefix="/api/tax", tags=["tax"])

MONEY = Decimal("0.01")
STANDARD_DEDUCTION = Decimal("5000")

# (上限, 税率, 速算扣除数) 月度换算表 —— 对应年度综合所得税率
MONTHLY_BRACKETS = [
    (Decimal("3000"), Decimal("0.03"), Decimal("0")),
    (Decimal("12000"), Decimal("0.10"), Decimal("210")),
    (Decimal("25000"), Decimal("0.20"), Decimal("1410")),
    (Decimal("35000"), Decimal("0.25"), Decimal("2660")),
    (Decimal("55000"), Decimal("0.30"), Decimal("4410")),
    (Decimal("80000"), Decimal("0.35"), Decimal("7160")),
    (None, Decimal("0.45"), Decimal("15160")),
]


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _bracket(taxable: Decimal) -> tuple[Decimal, Decimal]:
    """Return (rate, quick_deduction) for a monthly taxable income."""
    for upper, rate, deduction in MONTHLY_BRACKETS:
        if upper is None or taxable <= upper:
            return rate, deduction
    return Decimal("0.45"), Decimal("15160")


def _tax_on(taxable: Decimal) -> Decimal:
    if taxable <= 0:
        return Decimal("0")
    rate, deduction = _bracket(taxable)
    return taxable * rate - deduction


def _serialize(item: TaxRecord) -> dict:
    return {
        "id": item.id,
        "user_id": item.user_id,
        "year": item.year,
        "month": item.month,
        "income": str(item.income),
        "bonus": str(item.bonus),
        "social_insurance": str(item.social_insurance),
        "special_deduction": str(item.special_deduction),
        "taxable_income": str(item.taxable_income),
        "tax_amount": str(item.tax_amount),
        "net_income": str(item.net_income),
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


class TaxCalculateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    year: int = Field(ge=2020, le=2100)
    month: int = Field(ge=1, le=12)
    income: Decimal  # 月度税前工资
    bonus: Decimal = Decimal("0")  # 年终奖/一次性奖金（单独计税）
    social_insurance: Decimal = Decimal("0")  # 五险一金个人部分
    special_deduction: Decimal = Decimal("0")  # 专项附加扣除（月度）


@router.post("/calculate")
async def calculate_tax(
    payload: TaxCalculateRequest,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if payload.income < 0:
        raise HTTPException(status_code=400, detail="收入不能为负")

    monthly_taxable = (
        payload.income
        - STANDARD_DEDUCTION
        - payload.social_insurance
        - payload.special_deduction
    )
    monthly_tax = _tax_on(monthly_taxable)

    # 年终奖单独计税（简化）：奖金/12 定位税率档
    bonus_tax = Decimal("0")
    if payload.bonus > 0:
        per_month = payload.bonus / Decimal("12")
        rate, deduction = _bracket(per_month)
        bonus_tax = payload.bonus * rate - deduction

    total_tax = _money(monthly_tax + bonus_tax)
    net_income = _money(payload.income + payload.bonus - total_tax)

    record = TaxRecord(
        user_id=user_id,
        year=payload.year,
        month=payload.month,
        income=_money(payload.income),
        bonus=_money(payload.bonus),
        social_insurance=_money(payload.social_insurance),
        special_deduction=_money(payload.special_deduction),
        taxable_income=_money(monthly_taxable),
        tax_amount=total_tax,
        net_income=net_income,
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)
    return {
        "success": True,
        "data": {
            **_serialize(record),
            "monthly_tax": str(_money(monthly_tax)),
            "bonus_tax": str(_money(bonus_tax)),
        },
    }


@router.get("/records")
async def get_tax_records(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    records = list(
        (
            await db.scalars(
                select(TaxRecord)
                .where(TaxRecord.user_id == user_id)
                .order_by(TaxRecord.year.desc(), TaxRecord.month.desc(), TaxRecord.id.desc())
            )
        ).all()
    )
    return {"success": True, "data": [_serialize(item) for item in records]}


@router.delete("/records/{record_id}")
async def delete_tax_record(
    record_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    record = await db.scalar(
        select(TaxRecord).where(
            TaxRecord.id == record_id, TaxRecord.user_id == user_id
        )
    )
    if record is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    await db.delete(record)
    await db.commit()
    return {"success": True, "message": "已删除"}
