"""Deterministic financial-analysis tools for the constrained analyst loop.

Every function in this module is a pure Decimal computation over real DB facts;
none of them call an LLM (the LLM only appears at the analyst loop's decision
point). Each tool returns a JSON payload with ``context`` (the human-readable
summary the loop feeds back to the model), ``dataset_refs`` (the exact numbers
the model is allowed to quote) and ``data`` (the structured result).

金额使用 Decimal(18,2)（模型层 Numeric(12,2)），比率保留为未缩放小数。
"""

from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

from langchain_core.tools import BaseTool, tool
from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import Transaction
from app.services.financial_overview import get_user_financial_overview

ZERO = Decimal("0")
MONEY = Decimal("0.01")
HUNDRED = Decimal("100")
ROUND = ROUND_HALF_UP
DISCLAIMER = "不提供投资建议"
SCENARIO_NOTE = "基于历史均值估算，非承诺"

# 五个确定性比率：(metric key, 名称, 单位)。百分比单位的值按未缩放小数存储。
RATIO_DEFS = (
    ("debt_ratio", "负债率", "%"),
    ("savings_rate", "储蓄率", "%"),
    ("liquidity_ratio", "流动性比率", "月"),
    ("debt_to_income", "负债收入比", "%"),
    ("free_savings_rate", "自由储蓄率", "%"),
)


def _decimal(value: Any) -> Decimal | None:
    """Lenient Decimal coercion; never raises on untrusted LLM input."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        try:
            return Decimal(value)
        except Exception:
            return None
    return None


def _money(value: Decimal) -> Decimal:
    return value.quantize(MONEY, rounding=ROUND)


def _display(value: Decimal | None, unit: str) -> str | None:
    if value is None:
        return None
    if unit == "%":
        return f"{_money(value * HUNDRED):.2f}%"
    return f"{_money(value):.2f} {unit}"


def compute_ratio_analysis(metrics: dict[str, Any]) -> dict:
    """Return the five requested ratios with real-data-only semantics."""
    ratios: list[dict[str, Any]] = []
    for key, name, unit in RATIO_DEFS:
        metric = metrics.get(key)
        if isinstance(metric, dict):
            value = _decimal(metric.get("value"))
            reason = metric.get("reason")
        else:
            value = _decimal(metric)
            reason = None
        ratios.append(
            {
                "key": key,
                "name": name,
                "unit": unit,
                "value": value,
                "display": _display(value, unit),
                "reason": reason,
            }
        )
    available = [ratio for ratio in ratios if ratio["value"] is not None]
    return {
        "ratios": ratios,
        "has_data": bool(available),
        "message": "" if available else "缺少真实数据，无法计算比率",
    }


def compute_cashflow_trend(monthly: dict[str, dict[str, Decimal]]) -> dict:
    """Aggregate monthly income/expense into a chronological balance trend."""
    trend: list[dict[str, Any]] = []
    for month in sorted(monthly):
        income = _decimal(monthly[month].get("income")) or ZERO
        expense = _decimal(monthly[month].get("expense")) or ZERO
        trend.append(
            {
                "month": month,
                "income": _money(income),
                "expense": _money(expense),
                "balance": _money(income - expense),
            }
        )
    return {
        "trend": trend,
        "has_data": bool(trend),
        "message": "" if trend else "该期间无交易记录",
    }


def compute_expense_breakdown(groups: dict[str, Decimal]) -> dict:
    """Aggregate expenses by category with Decimal shares."""
    total = sum(
        (_decimal(amount) or ZERO for amount in groups.values()), ZERO
    )
    categories: list[dict[str, Any]] = []
    for category, amount in sorted(
        groups.items(),
        key=lambda item: _decimal(item[1]) or ZERO,
        reverse=True,
    ):
        decimal_amount = _decimal(amount) or ZERO
        share = (decimal_amount / total) if total > ZERO else ZERO
        categories.append(
            {
                "category": category,
                "amount": _money(decimal_amount),
                "share": share,
                "share_percent": f"{_money(share * HUNDRED):.2f}%",
            }
        )
    return {
        "total": _money(total),
        "categories": categories,
        "has_data": bool(categories),
        "message": "" if categories else "该期间无支出记录",
    }


def compute_scenario(
    current_income: Decimal,
    current_expense: Decimal,
    income_delta: Decimal,
    expense_delta: Decimal,
) -> dict:
    """Project balance change from historical monthly averages (not a promise)."""
    current_balance = current_income - current_expense
    adjusted_income = current_income + income_delta
    adjusted_expense = current_expense + expense_delta
    adjusted_balance = adjusted_income - adjusted_expense
    return {
        "current_monthly_income": _money(current_income),
        "current_monthly_expense": _money(current_expense),
        "current_monthly_balance": _money(current_balance),
        "income_delta": _money(income_delta),
        "expense_delta": _money(expense_delta),
        "adjusted_monthly_income": _money(adjusted_income),
        "adjusted_monthly_expense": _money(adjusted_expense),
        "adjusted_monthly_balance": _money(adjusted_balance),
        "balance_change": _money(adjusted_balance - current_balance),
        "note": f"{SCENARIO_NOTE}；{DISCLAIMER}",
    }


def _payload(data: dict, context: str, refs: list[dict]) -> str:
    return json.dumps(
        {"data": data, "context": context, "dataset_refs": refs},
        ensure_ascii=False,
        default=str,
    )


def _shift_month(value: datetime, delta: int) -> datetime:
    index = value.year * 12 + value.month - 1 + delta
    year, month = divmod(index, 12)
    return datetime(year, month + 1, 1)


def _month_key(value: datetime) -> str:
    return f"{value.year:04d}-{value.month:02d}"


async def _query_monthly_cashflow(
    session: AsyncSession,
    user_id: int,
    months: int,
) -> dict[str, dict[str, Decimal]]:
    now = datetime.now()
    start = _shift_month(datetime(now.year, now.month, 1), -(months - 1))
    year = extract("year", Transaction.occurred_at)
    month = extract("month", Transaction.occurred_at)
    statement = (
        select(
            year.label("year"),
            month.label("month"),
            Transaction.type.label("txn_type"),
            func.sum(Transaction.amount).label("amount"),
        )
        .where(
            Transaction.user_id == user_id,
            Transaction.occurred_at >= start,
        )
        .group_by(year, month, Transaction.type)
    )
    rows = (await session.execute(statement)).all()
    monthly: dict[str, dict[str, Decimal]] = {}
    for row in rows:
        key = f"{int(row.year):04d}-{int(row.month):02d}"
        monthly.setdefault(key, {"income": ZERO, "expense": ZERO})
        if row.txn_type == "income":
            monthly[key]["income"] += row.amount
        elif row.txn_type == "expense":
            monthly[key]["expense"] += row.amount
    ordered = [
        _month_key(_shift_month(datetime(now.year, now.month, 1), i))
        for i in range(-(months - 1), 1)
    ]
    return {
        key: monthly.get(key, {"income": ZERO, "expense": ZERO})
        for key in ordered
    }


async def _query_expense_groups(
    session: AsyncSession,
    user_id: int,
    category: str | None,
) -> dict[str, Decimal]:
    filters = [Transaction.user_id == user_id, Transaction.type == "expense"]
    if category is not None:
        filters.append(Transaction.category == category)
    statement = (
        select(Transaction.category, func.sum(Transaction.amount).label("amount"))
        .where(*filters)
        .group_by(Transaction.category)
    )
    rows = (await session.execute(statement)).all()
    return {row.category: row.amount for row in rows}


def _adjustments_to_deltas(adjustments: dict[str, Any]) -> tuple[Decimal, Decimal]:
    income_delta = _decimal(adjustments.get("income_delta")) or ZERO
    expense_delta = _decimal(adjustments.get("expense_delta")) or ZERO
    extra_saving = _decimal(adjustments.get("monthly_extra_saving"))
    if extra_saving is not None:
        expense_delta -= extra_saving
    return income_delta, expense_delta


def create_analysis_tools(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[BaseTool]:
    @tool
    async def get_ratio_analysis(user_id: int, ledger_id: int | None = None) -> str:
        """计算用户五大财务比率（负债率/储蓄率/流动性/负债收入比/自由储蓄率）。

        用途：为财务健康诊断提供确定性比率取值，仅引用真实数据。
        边界：基于用户全量财务概览（账本级暂不拆分），有真实数据才返回，否则返回空+说明；
        不提供投资建议。
        输入约束：user_id 必填；ledger_id 可选。
        禁忌：数据缺失时绝不编造数值；比率仅作参考，不构成产品推荐。
        """
        del ledger_id
        async with session_factory() as session:
            overview = await get_user_financial_overview(session, user_id)
        result = compute_ratio_analysis(overview["metrics"])
        parts = []
        for ratio in result["ratios"]:
            if ratio["value"] is not None:
                parts.append(f"{ratio['name']}：{ratio['display']}")
            else:
                parts.append(f"{ratio['name']}：无数据（{ratio['reason']}）")
        context = "；".join(parts) or result["message"]
        return _payload(result, context, [{"source": "get_ratio_analysis", **result}])

    @tool
    async def get_cashflow_trend(user_id: int, months: int = 6) -> str:
        """汇总用户近 N 个月的月度收入/支出/结余趋势。

        用途：展示现金流时间序列，识别收入与支出的月度变化。
        边界：仅基于真实交易记录按月聚合，无记录月份补零；不提供投资建议。
        输入约束：user_id 必填；months 限 1-24 整数。
        禁忌：不含预测或承诺；不返回投资建议。
        """
        if months < 1 or months > 24:
            raise ValueError("months must be between 1 and 24")
        async with session_factory() as session:
            monthly = await _query_monthly_cashflow(session, user_id, months)
        result = compute_cashflow_trend(monthly)
        result["months"] = months
        parts = [
            f"{item['month']}：收入 {item['income']}，支出 {item['expense']}，"
            f"结余 {item['balance']}"
            for item in result["trend"]
        ]
        context = "；".join(parts) or result["message"]
        return _payload(result, context, [{"source": "get_cashflow_trend", **result}])

    @tool
    async def get_expense_breakdown(user_id: int, category: str | None = None) -> str:
        """按类别聚合用户支出并计算占比（可指定单个类别）。

        用途：看清支出结构，定位占比最高的消费类别。
        边界：仅聚合真实支出记录，占比为未缩放小数；不提供投资建议。
        输入约束：user_id 必填；category 可选（为空则全类别聚合）。
        禁忌：无支出记录时返回空+说明，绝不编造。
        """
        async with session_factory() as session:
            groups = await _query_expense_groups(session, user_id, category)
        result = compute_expense_breakdown(groups)
        parts = [
            f"{item['category']} {item['amount']}（占比 {item['share_percent']}）"
            for item in result["categories"]
        ]
        context = (
            f"总支出 {result['total']}；" + "；".join(parts)
            if parts
            else result["message"]
        )
        return _payload(result, context, [{"source": "get_expense_breakdown", **result}])

    @tool
    async def simulate_scenario(user_id: int, adjustments: dict) -> str:
        """基于历史月均收支推演收支调整后的结余变化。

        用途：回答"每月多存/多花 X 会怎样"一类情景问题。
        边界：纯函数基于真实历史月均值估算，明确标注"基于历史均值估算，非承诺"；
        不提供投资建议。
        输入约束：user_id 必填；adjustments 支持 income_delta / expense_delta /
        monthly_extra_saving（每月多存，等价减少支出）。
        禁忌：结果非承诺、非预测；不返回投资建议。
        """
        if not isinstance(adjustments, dict):
            raise ValueError("adjustments must be an object")
        async with session_factory() as session:
            overview = await get_user_financial_overview(session, user_id)
        raw = overview["raw"]
        current_income = _decimal(raw["income"]["monthly"])
        current_expense = _decimal(raw["expenses"]["monthly"])
        if current_income is None or current_expense is None:
            result = {
                "has_data": False,
                "message": "缺少历史收支数据，无法推演",
            }
            return _payload(
                result, result["message"], [{"source": "simulate_scenario", **result}]
            )
        income_delta, expense_delta = _adjustments_to_deltas(adjustments)
        result = compute_scenario(
            current_income, current_expense, income_delta, expense_delta
        )
        context = (
            f"当前月均收入 {result['current_monthly_income']}，"
            f"支出 {result['current_monthly_expense']}，"
            f"结余 {result['current_monthly_balance']}；"
            f"调整后结余 {result['adjusted_monthly_balance']}，"
            f"结余变化 {result['balance_change']}。{result['note']}"
        )
        return _payload(result, context, [{"source": "simulate_scenario", **result}])

    return [
        get_ratio_analysis,
        get_cashflow_trend,
        get_expense_breakdown,
        simulate_scenario,
    ]
