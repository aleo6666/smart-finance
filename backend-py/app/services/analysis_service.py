from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Budget, Goal, Transaction, UserProfile
from app.services.deep_analysis import (
    analyze_budget,
    analyze_goals,
    compare_benchmarks,
    detect_anomalies,
    forecast_cashflow,
)
from app.services.financial_overview import get_user_financial_overview


ZERO = Decimal("0")


def _month_start(month: str) -> date:
    try:
        parsed = datetime.strptime(month, "%Y-%m").date()
    except ValueError as exc:
        raise ValueError("month must use YYYY-MM format") from exc
    return parsed.replace(day=1)


def _shift_month(value: date, delta: int) -> date:
    index = value.year * 12 + value.month - 1 + delta
    return date(index // 12, index % 12 + 1, 1)


def _transaction_dict(transaction: Transaction) -> dict:
    return {
        "id": transaction.id,
        "type": transaction.type,
        "category": transaction.category,
        "amount": transaction.amount,
        "merchant": transaction.note or transaction.category,
        "note": transaction.note,
        "occurred_at": transaction.occurred_at,
    }


async def _expense_totals(
    db: AsyncSession,
    user_id: int,
    start: date,
    end: date,
    ledger_id: int | None,
) -> dict[str, Decimal]:
    filters = [
        Transaction.user_id == user_id,
        Transaction.type == "expense",
        Transaction.occurred_at >= datetime.combine(start, time.min),
        Transaction.occurred_at < datetime.combine(end, time.min),
    ]
    if ledger_id is not None:
        filters.append(Transaction.ledger_id == ledger_id)
    statement = (
        select(Transaction.category, func.sum(Transaction.amount).label("amount"))
        .where(*filters)
        .group_by(Transaction.category)
    )
    return {row.category: row.amount for row in (await db.execute(statement)).all()}


async def get_budget_analysis(
    db: AsyncSession,
    user_id: int,
    month: str,
    ledger_id: int | None = None,
) -> dict:
    start = _month_start(month)
    end = _shift_month(start, 1)
    filters = [
        Budget.user_id == user_id,
        Budget.period_start < end,
        Budget.period_end >= start,
    ]
    if ledger_id is not None:
        filters.append(Budget.ledger_id == ledger_id)
    budget_statement = (
        select(Budget.category, func.sum(Budget.amount).label("amount"))
        .where(*filters)
        .group_by(Budget.category)
    )
    budgets = {
        row.category: row.amount
        for row in (await db.execute(budget_statement)).all()
    }
    actual = await _expense_totals(db, user_id, start, end, ledger_id)
    previous_start = _shift_month(start, -1)
    previous = await _expense_totals(
        db, user_id, previous_start, start, ledger_id
    )

    historical_start = _shift_month(start, -3)
    history_filters = [
        Transaction.user_id == user_id,
        Transaction.type == "expense",
        Transaction.occurred_at >= datetime.combine(historical_start, time.min),
        Transaction.occurred_at < datetime.combine(start, time.min),
    ]
    if ledger_id is not None:
        history_filters.append(Transaction.ledger_id == ledger_id)
    historical_transactions = list(
        (await db.scalars(select(Transaction).where(*history_filters))).all()
    )
    monthly_history: dict[str, dict[str, Decimal]] = defaultdict(
        lambda: defaultdict(lambda: ZERO)
    )
    for transaction in historical_transactions:
        key = transaction.occurred_at.strftime("%Y-%m")
        monthly_history[key][transaction.category] += transaction.amount

    previous_counts: dict[str, int] = {}
    for category, budget in budgets.items():
        count = 0
        for offset in range(1, 4):
            key = _shift_month(start, -offset).strftime("%Y-%m")
            if monthly_history[key].get(category, ZERO) > budget:
                count += 1
            else:
                break
        previous_counts[category] = count
    return analyze_budget(budgets, actual, previous, previous_counts)


async def get_cashflow_forecast(
    db: AsyncSession, user_id: int, as_of: date | None = None
) -> dict:
    anchor = as_of or date.today()
    start = _shift_month(anchor.replace(day=1), -5)
    statement = select(Transaction).where(
        Transaction.user_id == user_id,
        Transaction.occurred_at >= datetime.combine(start, time.min),
        Transaction.occurred_at
        < datetime.combine(_shift_month(anchor.replace(day=1), 1), time.min),
    )
    transactions = list((await db.scalars(statement)).all())
    return forecast_cashflow(
        [_transaction_dict(transaction) for transaction in transactions],
        as_of=anchor,
    )


async def get_anomaly_analysis(
    db: AsyncSession,
    user_id: int,
    days: int = 30,
    standard_deviations: Decimal = Decimal("2"),
) -> dict:
    start = datetime.now() - timedelta(days=days)
    statement = select(Transaction).where(
        Transaction.user_id == user_id,
        Transaction.type == "expense",
        Transaction.occurred_at >= start,
    )
    transactions = list((await db.scalars(statement)).all())
    return detect_anomalies(
        [_transaction_dict(transaction) for transaction in transactions],
        standard_deviations=standard_deviations,
    )


async def get_goal_analysis(db: AsyncSession, user_id: int) -> dict:
    goals = list(
        (
            await db.scalars(
                select(Goal)
                .where(Goal.user_id == user_id)
                .order_by(Goal.target_date, Goal.id)
            )
        ).all()
    )
    overview = await get_user_financial_overview(db, user_id)
    raw = overview["raw"]
    return analyze_goals(
        [
            {
                "id": goal.id,
                "name": goal.name,
                "target_amount": goal.target_amount,
                "current_amount": goal.current_amount,
                "target_date": goal.target_date,
            }
            for goal in goals
        ],
        monthly_income=raw["income"]["monthly"],
        monthly_expenses=raw["expenses"]["monthly"],
        free_savings_rate=overview["metrics"]["free_savings_rate"]["value"],
    )


async def get_benchmark_comparison(db: AsyncSession, user_id: int) -> dict:
    profile = await db.scalar(
        select(UserProfile).where(UserProfile.user_id == user_id)
    )
    overview = await get_user_financial_overview(db, user_id)
    metrics = overview["metrics"]
    return compare_benchmarks(
        monthly_income=overview["raw"]["income"]["monthly"],
        age=profile.age if profile is not None else None,
        savings_rate=metrics["savings_rate"]["value"],
        engel_coefficient=metrics["engel_coefficient"]["value"],
        debt_ratio=metrics["debt_ratio"]["value"],
    )


async def get_all_analyses(
    db: AsyncSession,
    user_id: int,
    standard_deviations: Decimal = Decimal("2"),
) -> dict:
    month = date.today().strftime("%Y-%m")
    return {
        "budget": await get_budget_analysis(db, user_id, month),
        "forecast": await get_cashflow_forecast(db, user_id),
        "anomalies": await get_anomaly_analysis(
            db, user_id, standard_deviations=standard_deviations
        ),
        "goals": await get_goal_analysis(db, user_id),
        "benchmark": await get_benchmark_comparison(db, user_id),
    }
