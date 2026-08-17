from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Asset, Liability, Transaction
from app.services.metrics import compute_metrics


ZERO = Decimal("0")
LIQUID_ASSET_TYPES = {"cash", "bank_deposit"}
FIXED_EXPENSE_CATEGORIES = {
    "housing",
    "rent",
    "mortgage",
    "utilities",
    "insurance",
    "住房",
    "房租",
    "房贷",
    "水电",
    "保险",
}
FOOD_CATEGORIES = {"food", "食品", "餐饮"}


async def _transaction_totals(
    db: AsyncSession, user_id: int, period_start: datetime
) -> tuple[dict[str, Decimal | None], Decimal | None]:
    statement = (
        select(
            Transaction.type,
            Transaction.category,
            func.sum(Transaction.amount).label("amount"),
        )
        .where(
            Transaction.user_id == user_id,
            Transaction.occurred_at >= period_start,
        )
        .group_by(Transaction.type, Transaction.category)
    )
    rows = (await db.execute(statement)).all()

    total_income: Decimal | None = None
    total_expenses: Decimal | None = None
    food_expenses = ZERO
    categorized_fixed_expenses = ZERO
    for row in rows:
        amount = row.amount
        if row.type == "income":
            total_income = (total_income or ZERO) + amount
        elif row.type == "expense":
            total_expenses = (total_expenses or ZERO) + amount
            if row.category in FOOD_CATEGORIES:
                food_expenses += amount
            if row.category in FIXED_EXPENSE_CATEGORIES:
                categorized_fixed_expenses += amount

    return (
        {
            "income": total_income,
            "expenses": total_expenses,
            "food": food_expenses if total_expenses is not None else None,
        },
        categorized_fixed_expenses if total_expenses is not None else None,
    )


async def _asset_totals(
    db: AsyncSession, user_id: int
) -> dict[str, Decimal | None]:
    statement = (
        select(Asset.type, func.sum(Asset.amount).label("amount"))
        .where(Asset.user_id == user_id)
        .group_by(Asset.type)
    )
    rows = (await db.execute(statement)).all()
    if not rows:
        return {"total": None, "liquid": None, "investment": None}

    total = ZERO
    liquid = ZERO
    investment = ZERO
    for row in rows:
        total += row.amount
        if row.type in LIQUID_ASSET_TYPES:
            liquid += row.amount
        if row.type == "investment":
            investment += row.amount
    return {"total": total, "liquid": liquid, "investment": investment}


async def _liability_totals(
    db: AsyncSession, user_id: int
) -> dict[str, Decimal | None]:
    statement = select(
        func.sum(Liability.amount).label("total"),
        func.sum(Liability.monthly_payment).label("monthly_payment"),
    ).where(Liability.user_id == user_id)
    row = (await db.execute(statement)).one()
    return {"total": row.total, "monthly_payment": row.monthly_payment}


def _missing_reason(
    key: str,
    income: dict[str, Decimal | None],
    expenses: dict[str, Decimal | None],
    assets: dict[str, Decimal | None],
    liabilities: dict[str, Decimal | None],
) -> str:
    if key in {"debt_ratio", "investment_ratio", "liquidity_ratio", "net_worth"}:
        if assets["total"] is None:
            names = {
                "debt_ratio": "负债率",
                "investment_ratio": "投资资产比率",
                "liquidity_ratio": "流动性比率",
                "net_worth": "净资产",
            }
            return f"缺少资产数据，无法计算{names[key]}"
    if key in {"debt_ratio", "debt_to_income", "net_worth"}:
        if liabilities["total"] is None:
            names = {
                "debt_ratio": "负债率",
                "debt_to_income": "负债收入比",
                "net_worth": "净资产",
            }
            return f"缺少负债数据，无法计算{names[key]}"
    if key == "debt_to_income" and liabilities["monthly_payment"] is None:
        return "缺少月还款额数据，无法计算负债收入比"
    if key in {"savings_rate", "debt_to_income", "free_savings_rate"}:
        if income["total"] is None:
            return "缺少收入数据，无法计算该指标"
    if key == "free_savings_rate" and expenses["fixed"] is None:
        return "缺少固定支出数据，无法计算自由储蓄率"
    if key in {"savings_rate", "liquidity_ratio", "engel_coefficient"}:
        if expenses["total"] is None:
            return "缺少支出数据，无法计算该指标"
    return "数据为 0 或包含负值，无法计算该指标"


async def get_user_financial_overview(
    db: AsyncSession, user_id: int, months: int = 3
) -> dict:
    if months < 1:
        raise ValueError("months must be at least 1")

    period_end = datetime.now()
    period_start = period_end - timedelta(days=30 * months)
    transaction_totals, categorized_fixed = await _transaction_totals(
        db, user_id, period_start
    )
    fixed_expenses = categorized_fixed
    assets = await _asset_totals(db, user_id)
    liabilities = await _liability_totals(db, user_id)

    decimal_months = Decimal(months)
    total_income = transaction_totals["income"]
    total_expenses = transaction_totals["expenses"]
    income = {
        "total": total_income,
        "monthly": total_income / decimal_months if total_income is not None else None,
    }
    expenses = {
        "total": total_expenses,
        "monthly": (
            total_expenses / decimal_months if total_expenses is not None else None
        ),
        "food": transaction_totals["food"],
        "fixed": fixed_expenses,
    }
    metrics = compute_metrics(
        income=income,
        expenses=expenses,
        fixed_expenses=fixed_expenses,
        assets=assets,
        liabilities=liabilities,
    )
    for key, metric in metrics.items():
        if metric["value"] is None:
            metric["reason"] = _missing_reason(
                key, income, expenses, assets, liabilities
            )

    return {
        "user_id": user_id,
        "period": {
            "months": months,
            "start": period_start.date().isoformat(),
            "end": period_end.date().isoformat(),
        },
        "metrics": metrics,
        "raw": {
            "income": income,
            "expenses": expenses,
            "assets": assets,
            "liabilities": liabilities,
        },
    }
