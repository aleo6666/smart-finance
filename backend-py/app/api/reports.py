from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Report, Transaction
from app.services.report_generator import (
    generate_monthly_report,
    get_report,
    list_reports,
)

router = APIRouter(prefix="/api/reports", tags=["reports"])


class GenerateReportRequest(BaseModel):
    user_id: int = Field(gt=0)
    year: int = Field(ge=2000, le=9999)
    month: int = Field(ge=1, le=12)


@router.post("/generate")
async def generate_report(
    payload: GenerateReportRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await generate_monthly_report(
        db, payload.user_id, payload.year, payload.month
    )


@router.get("")
async def report_history(
    user_id: int = Query(gt=0),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await list_reports(db, user_id)


# ---------------------------------------------------------------------------
# Legacy frontend-facing report endpoints (aligned with server/src/routes/reports.js).
# Static paths are registered before the trailing "/{report_id}" route so they
# are not swallowed by it.
# ---------------------------------------------------------------------------


def _month_bounds(month: str) -> tuple[date, date]:
    year, month_number = (int(part) for part in month.split("-"))
    start = date(year, month_number, 1)
    if month_number == 12:
        end = date(year + 1, 1, 1)
    else:
        end = date(year, month_number + 1, 1)
    return start, end


def _conditionals(
    user_id: int, start: date, end: date, ledger_id: int | None
) -> list:
    filters = [
        Transaction.user_id == user_id,
        Transaction.occurred_at >= datetime.combine(start, time.min),
        Transaction.occurred_at < datetime.combine(end, time.min),
    ]
    if ledger_id is not None:
        filters.append(Transaction.ledger_id == ledger_id)
    return filters


async def _type_totals(
    db: AsyncSession,
    user_id: int,
    start: date,
    end: date,
    ledger_id: int | None,
) -> dict:
    rows = (
        await db.execute(
            select(
                Transaction.type,
                func.sum(Transaction.amount),
                func.count(Transaction.id),
            )
            .where(*_conditionals(user_id, start, end, ledger_id))
            .group_by(Transaction.type)
        )
    ).all()
    income = 0.0
    expense = 0.0
    count = 0
    for record_type, amount, record_count in rows:
        value = float(amount or 0)
        count += int(record_count or 0)
        if record_type == "income":
            income += value
        else:
            expense += value
    return {"income": income, "expense": expense, "recordCount": count}


@router.get("/monthly")
async def monthly_report(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    month: str | None = Query(default=None),
    ledger_id: int | None = Query(default=None, alias="ledgerId"),
) -> dict:
    month = month or datetime.now().strftime("%Y-%m")
    start, end = _month_bounds(month)
    totals = await _type_totals(db, user_id, start, end, ledger_id)
    income = totals["income"]
    expense = totals["expense"]
    savings_rate = round((income - expense) / income * 100, 1) if income > 0 else 0
    return {
        "success": True,
        "data": {
            "month": month,
            "income": income,
            "expense": expense,
            "recordCount": totals["recordCount"],
            "balance": income - expense,
            "change": 0,
            "savingsRate": savings_rate,
        },
    }


@router.get("/category")
async def category_report(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    month: str | None = Query(default=None),
    ledger_id: int | None = Query(default=None, alias="ledgerId"),
) -> dict:
    month = month or datetime.now().strftime("%Y-%m")
    start, end = _month_bounds(month)
    rows = (
        await db.execute(
            select(
                Transaction.category,
                func.sum(Transaction.amount),
                func.count(Transaction.id),
            )
            .where(
                Transaction.user_id == user_id,
                Transaction.type == "expense",
                Transaction.occurred_at >= datetime.combine(start, time.min),
                Transaction.occurred_at < datetime.combine(end, time.min),
            )
            .group_by(Transaction.category)
            .order_by(func.sum(Transaction.amount).desc())
        )
    ).all()
    data = [
        {"category": category, "total": float(amount or 0), "count": int(count or 0)}
        for category, amount, count in rows
    ]
    return {"success": True, "data": data}


@router.get("/trend")
async def trend_report(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    months: int = Query(default=6, ge=1),
    ledger_id: int | None = Query(default=None, alias="ledgerId"),
) -> dict:
    start = date(date.today().year, date.today().month, 1)
    for _ in range(months - 1):
        start = (start - timedelta(days=1)).replace(day=1)
    end = date.today() + timedelta(days=1)

    rows = (
        await db.execute(
            select(Transaction.type, Transaction.occurred_at, Transaction.amount)
            .where(*_conditionals(user_id, start, end, ledger_id))
            .order_by(Transaction.occurred_at)
        )
    ).all()

    buckets: dict[str, dict] = {}
    for record_type, occurred_at, amount in rows:
        label = occurred_at.strftime("%Y-%m")
        bucket = buckets.setdefault(
            label, {"month": label, "income": 0.0, "expense": 0.0}
        )
        bucket[record_type] += float(amount or 0)
    return {"success": True, "data": list(buckets.values())}


@router.get("/today")
async def today_report(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    ledger_id: int | None = Query(default=None, alias="ledgerId"),
) -> dict:
    today = date.today()
    filters = [
        Transaction.user_id == user_id,
        Transaction.type == "expense",
        Transaction.occurred_at >= datetime.combine(today, time.min),
        Transaction.occurred_at < datetime.combine(today, time.max),
    ]
    if ledger_id is not None:
        filters.append(Transaction.ledger_id == ledger_id)
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(Transaction.amount), 0),
                func.count(Transaction.id),
            ).where(*filters)
        )
    ).one()
    total, count = row
    return {
        "success": True,
        "data": {
            "date": today.isoformat(),
            "total": float(total or 0),
            "count": int(count or 0),
        },
    }


@router.get("/timerange")
async def timerange_report(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    period: str = Query(default="month"),
    ledger_id: int | None = Query(default=None, alias="ledgerId"),
) -> dict:
    days = 6 if period == "week" else 90 if period == "quarter" else 29
    to_date = date.today()
    from_date = to_date - timedelta(days=days)
    end_exclusive = to_date + timedelta(days=1)

    filters = _conditionals(user_id, from_date, end_exclusive, ledger_id)
    rows = (
        await db.execute(
            select(
                Transaction.type,
                Transaction.category,
                Transaction.occurred_at,
                Transaction.amount,
            ).where(*filters)
        )
    ).all()

    trends: dict[str, dict] = {}
    category_totals: dict[str, float] = {}
    income = 0.0
    expense = 0.0
    count = 0
    for record_type, category, occurred_at, amount in rows:
        value = float(amount or 0)
        count += 1
        if record_type == "income":
            income += value
        else:
            expense += value
            category_totals[category] = category_totals.get(category, 0.0) + value
        label = occurred_at.strftime("%Y-%m-%d")
        trend = trends.setdefault(label, {"label": label, "income": 0.0, "expense": 0.0})
        trend[record_type] += value

    categories = [
        {"category": category, "total": total}
        for category, total in sorted(
            category_totals.items(), key=lambda item: item[1], reverse=True
        )
    ]
    savings_rate = round((income - expense) / income * 100, 1) if income > 0 else 0
    return {
        "success": True,
        "data": {
            "period": period,
            "fromDate": from_date.isoformat(),
            "toDate": to_date.isoformat(),
            "income": income,
            "expense": expense,
            "balance": income - expense,
            "count": count,
            "savingsRate": savings_rate,
            "trends": list(trends.values()),
            "categories": categories,
        },
    }


@router.get("/summary")
async def summary_report(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    period_type: str = Query(default="month", alias="periodType"),
    period_value: str | None = Query(default=None, alias="periodValue"),
    ledger_id: int | None = Query(default=None, alias="ledgerId"),
) -> dict:
    period_value = period_value or datetime.now().strftime("%Y-%m")
    start, end = _month_bounds(period_value)
    totals = await _type_totals(db, user_id, start, end, ledger_id)
    return {
        "success": True,
        "data": {
            "periodType": period_type,
            "periodValue": period_value,
            "income": totals["income"],
            "expense": totals["expense"],
            "recordCount": totals["recordCount"],
        },
    }


@router.get("/history")
async def legacy_report_history(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    reports = list(
        (
            await db.scalars(
                select(Report)
                .where(Report.user_id == user_id)
                .order_by(Report.created_at.desc(), Report.id.desc())
                .limit(50)
            )
        ).all()
    )
    data = [
        {
            "id": report.id,
            "period_type": report.report_type,
            "period_value": report.period,
            "source": "manual",
            "generated_at": report.created_at.isoformat()
            if report.created_at
            else None,
        }
        for report in reports
    ]
    return {"success": True, "data": data}


@router.get("/{report_id}")
async def report_detail(
    report_id: int,
    user_id: int = Query(gt=0),
    db: AsyncSession = Depends(get_db),
) -> dict:
    report = await get_report(db, report_id, user_id)
    if report is None:
        raise HTTPException(status_code=404, detail="report not found")
    return report
