from datetime import date, datetime, time
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Report, Transaction
from app.services.deep_analysis import DISCLAIMER
from app.services.metrics import compute_savings_rate


ZERO = Decimal("0")
MONEY = Decimal("0.01")
RATE = Decimal("0.0001")
TEXT_PERCENT = Decimal("0.01")


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def _next_month(value: date) -> date:
    if value.month == 12:
        return date(value.year + 1, 1, 1)
    return date(value.year, value.month + 1, 1)


async def _period_totals(
    db: AsyncSession, user_id: int, start: date, end: date
) -> dict:
    statement = (
        select(
            Transaction.type,
            Transaction.category,
            func.sum(Transaction.amount).label("amount"),
        )
        .where(
            Transaction.user_id == user_id,
            Transaction.occurred_at >= datetime.combine(start, time.min),
            Transaction.occurred_at < datetime.combine(end, time.min),
        )
        .group_by(Transaction.type, Transaction.category)
    )
    rows = (await db.execute(statement)).all()
    income = ZERO
    expenses = ZERO
    categories: dict[str, Decimal] = {}
    for row in rows:
        if row.type == "income":
            income += row.amount
        elif row.type == "expense":
            expenses += row.amount
            categories[row.category] = row.amount
    return {
        "income": income,
        "expenses": expenses,
        "categories": categories,
        "has_data": bool(rows),
    }


def _change(current: Decimal, previous: Decimal | None) -> dict:
    if previous is None:
        return {
            "current": f"{_money(current):.2f}",
            "previous": None,
            "amount_change": None,
            "change_rate": None,
            "reason": "对比期间无数据",
        }
    amount_change = current - previous
    if previous == ZERO:
        rate = None
        reason = "对比期间数值为 0，无法计算变化率"
    else:
        rate = (amount_change / previous).quantize(RATE, rounding=ROUND_HALF_UP)
        reason = None
    return {
        "current": f"{_money(current):.2f}",
        "previous": f"{_money(previous):.2f}",
        "amount_change": f"{_money(amount_change):.2f}",
        "change_rate": f"{rate:.4f}" if rate is not None else None,
        "reason": reason,
    }


def _comparison(current: dict, prior: dict) -> dict:
    prior_income = prior["income"] if prior["has_data"] else None
    prior_expenses = prior["expenses"] if prior["has_data"] else None
    categories = {
        category: _change(
            amount,
            prior["categories"].get(category) if prior["has_data"] else None,
        )
        for category, amount in sorted(current["categories"].items())
    }
    return {
        "income": _change(current["income"], prior_income),
        "expenses": _change(current["expenses"], prior_expenses),
        "categories": categories,
        "reason": None if prior["has_data"] else "对比期间无交易数据",
    }


def _narrative(
    category: str, current: Decimal, previous: Decimal | None
) -> str:
    current_text = f"{_money(current):.2f}"
    if previous is None or previous == ZERO:
        return (
            f"本月{category}支出 {current_text} 元，上月无同类支出，"
            "主要因为本月新增该分类消费。"
        )
    change = current - previous
    rate_percent = (abs(change) / previous * Decimal("100")).quantize(
        TEXT_PERCENT, rounding=ROUND_HALF_UP
    )
    if change > ZERO:
        direction = "上升"
        reason = f"较上月增加 {_money(change):.2f} 元"
    elif change < ZERO:
        direction = "下降"
        reason = f"较上月减少 {_money(abs(change)):.2f} 元"
    else:
        direction = "持平"
        reason = "与上月金额相同"
    return (
        f"本月{category}支出 {current_text} 元，环比{direction} {rate_percent:.2f}%，"
        f"主要因为{reason}。"
    )


def _report_dict(report: Report) -> dict:
    return {
        "id": report.id,
        "user_id": report.user_id,
        "report_type": report.report_type,
        "period": report.period,
        "content": report.content,
        "created_at": report.created_at.isoformat(),
    }


async def generate_monthly_report(
    db: AsyncSession, user_id: int, year: int, month: int
) -> dict:
    """Generate and persist a deterministic monthly report for one user."""
    try:
        start = date(year, month, 1)
    except ValueError as exc:
        raise ValueError("year and month must identify a valid month") from exc
    end = _next_month(start)
    previous_start = date(year - 1, 12, 1) if month == 1 else date(year, month - 1, 1)
    year_ago_start = date(year - 1, month, 1)

    current = await _period_totals(db, user_id, start, end)
    previous = await _period_totals(db, user_id, previous_start, start)
    year_ago = await _period_totals(
        db, user_id, year_ago_start, _next_month(year_ago_start)
    )
    savings = current["income"] - current["expenses"]
    savings_rate = compute_savings_rate(current["income"], current["expenses"])
    previous_categories = previous["categories"] if previous["has_data"] else {}
    narratives = [
        _narrative(category, amount, previous_categories.get(category))
        for category, amount in sorted(current["categories"].items())
    ]

    action_advice: list[str] = []
    if savings_rate is None:
        action_advice.append(
            f"补充稳定收入数据后再评估储蓄率。{DISCLAIMER}"
        )
    elif savings_rate < Decimal("0.20"):
        action_advice.append(
            f"建议将储蓄率提升至 20%，减少非必要支出。{DISCLAIMER}"
        )
    else:
        action_advice.append(
            f"当前储蓄率不低于 20%，建议保持并按月复核。{DISCLAIMER}"
        )

    content = {
        "summary": {
            "income": f"{_money(current['income']):.2f}",
            "expenses": f"{_money(current['expenses']):.2f}",
            "savings": f"{_money(savings):.2f}",
            "savings_rate": (
                f"{savings_rate.quantize(RATE, rounding=ROUND_HALF_UP):.4f}"
                if savings_rate is not None
                else None
            ),
        },
        "categories": {
            category: f"{_money(amount):.2f}"
            for category, amount in sorted(current["categories"].items())
        },
        "comparisons": {
            "month_over_month": _comparison(current, previous),
            "year_over_year": _comparison(current, year_ago),
        },
        "narratives": narratives,
        "action_advice": action_advice,
    }
    report = Report(
        user_id=user_id,
        report_type="monthly",
        period=f"{year:04d}-{month:02d}",
        content=content,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    return _report_dict(report)


async def list_reports(db: AsyncSession, user_id: int) -> list[dict]:
    reports = list(
        (
            await db.scalars(
                select(Report)
                .where(Report.user_id == user_id)
                .order_by(Report.created_at.desc(), Report.id.desc())
            )
        ).all()
    )
    return [_report_dict(report) for report in reports]


async def get_report(
    db: AsyncSession, report_id: int, user_id: int
) -> dict | None:
    report = await db.scalar(
        select(Report).where(
            Report.id == report_id,
            Report.user_id == user_id,
        )
    )
    return _report_dict(report) if report is not None else None
