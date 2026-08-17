from datetime import date, datetime, time, timedelta
from decimal import Decimal
import json

from langchain_core.tools import BaseTool, tool
from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import Transaction


EMPTY_RESULT = {"count": 0, "message": "该条件下无交易记录"}
TWO_DECIMAL_PLACES = Decimal("0.01")


def _filters(
    user_id: int,
    start_date: str | None,
    end_date: str | None,
    category: str | None,
    txn_type: str | None,
) -> list:
    filters = [Transaction.user_id == user_id]
    if start_date is not None:
        start = datetime.combine(date.fromisoformat(start_date), time.min)
        filters.append(Transaction.occurred_at >= start)
    if end_date is not None:
        end = datetime.combine(date.fromisoformat(end_date) + timedelta(days=1), time.min)
        filters.append(Transaction.occurred_at < end)
    if category is not None:
        filters.append(Transaction.category == category)
    if txn_type is not None:
        filters.append(Transaction.type == txn_type)
    return filters


def _format_amount(value: Decimal) -> str:
    return format(value.quantize(TWO_DECIMAL_PLACES), ".2f")


async def _query_rows(
    session: AsyncSession, filters: list, limit: int
) -> dict:
    statement = (
        select(Transaction)
        .where(*filters)
        .order_by(Transaction.occurred_at.desc(), Transaction.id.desc())
        .limit(limit)
    )
    transactions = list((await session.scalars(statement)).all())
    if not transactions:
        return EMPTY_RESULT

    return {
        "count": len(transactions),
        "transactions": [
            {
                "id": transaction.id,
                "user_id": transaction.user_id,
                "ledger_id": transaction.ledger_id,
                "type": transaction.type,
                "category": transaction.category,
                "amount": _format_amount(transaction.amount),
                "currency": transaction.currency,
                "note": transaction.note,
                "occurred_at": transaction.occurred_at.isoformat(),
                "created_at": transaction.created_at.isoformat(),
            }
            for transaction in transactions
        ],
    }


async def _query_by_category(
    session: AsyncSession, filters: list, limit: int
) -> dict:
    statement = (
        select(
            Transaction.category,
            func.count(Transaction.id).label("count"),
            func.sum(Transaction.amount).label("total_amount"),
        )
        .where(*filters)
        .group_by(Transaction.category)
        .order_by(Transaction.category)
        .limit(limit)
    )
    rows = (await session.execute(statement)).all()
    if not rows:
        return EMPTY_RESULT

    return {
        "count": len(rows),
        "groups": [
            {
                "category": row.category,
                "count": row.count,
                "total_amount": _format_amount(row.total_amount),
            }
            for row in rows
        ],
    }


async def _query_by_month(
    session: AsyncSession, filters: list, limit: int
) -> dict:
    year = extract("year", Transaction.occurred_at)
    month = extract("month", Transaction.occurred_at)
    statement = (
        select(
            year.label("year"),
            month.label("month"),
            func.count(Transaction.id).label("count"),
            func.sum(Transaction.amount).label("total_amount"),
        )
        .where(*filters)
        .group_by(year, month)
        .order_by(year, month)
        .limit(limit)
    )
    rows = (await session.execute(statement)).all()
    if not rows:
        return EMPTY_RESULT

    return {
        "count": len(rows),
        "groups": [
            {
                "month": f"{int(row.year):04d}-{int(row.month):02d}",
                "count": row.count,
                "total_amount": _format_amount(row.total_amount),
            }
            for row in rows
        ],
    }


def create_query_transactions_tool(
    session_factory: async_sessionmaker[AsyncSession],
) -> BaseTool:
    @tool
    async def query_transactions(
        user_id: int,
        start_date: str | None = None,
        end_date: str | None = None,
        category: str | None = None,
        txn_type: str | None = None,
        group_by: str | None = None,
        limit: int = 20,
    ) -> str:
        """Query one user's transactions with filters or grouped totals."""
        query_filters = _filters(
            user_id, start_date, end_date, category, txn_type
        )
        async with session_factory() as session:
            if group_by == "category":
                result = await _query_by_category(session, query_filters, limit)
            elif group_by == "month":
                result = await _query_by_month(session, query_filters, limit)
            elif group_by is None:
                result = await _query_rows(session, query_filters, limit)
            else:
                raise ValueError("group_by must be 'category', 'month', or null")

        return json.dumps(result, ensure_ascii=False)

    return query_transactions
