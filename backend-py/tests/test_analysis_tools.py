"""任务 B2：分析工具纯函数 + DB 取数测试。

覆盖：ratio/trend/breakdown/scenario 用种子数据断言 Decimal 精度；
工具返回真实数据 + dataset_refs，无数据时返回空+说明。
"""
from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agents.tools.analysis_tools import (
    ZERO,
    compute_cashflow_trend,
    compute_expense_breakdown,
    compute_ratio_analysis,
    compute_scenario,
    create_analysis_tools,
)
from app.models import Base, Ledger, Transaction, User


def test_compute_ratio_analysis_returns_decimal_ratios() -> None:
    metrics = {
        "debt_ratio": {"value": Decimal("0.30"), "reason": None},
        "savings_rate": {"value": Decimal("0.20"), "reason": None},
        "liquidity_ratio": {"value": Decimal("3.5"), "reason": None},
        "debt_to_income": {"value": Decimal("0.25"), "reason": None},
        "free_savings_rate": {"value": Decimal("0.40"), "reason": None},
    }
    result = compute_ratio_analysis(metrics)

    assert result["has_data"] is True
    by_key = {ratio["key"]: ratio for ratio in result["ratios"]}
    assert by_key["debt_ratio"]["value"] == Decimal("0.30")
    assert by_key["debt_ratio"]["display"] == "30.00%"
    assert by_key["savings_rate"]["display"] == "20.00%"
    assert by_key["liquidity_ratio"]["display"] == "3.50 月"
    assert by_key["debt_to_income"]["display"] == "25.00%"


def test_compute_ratio_analysis_returns_empty_when_no_data() -> None:
    result = compute_ratio_analysis(
        {"debt_ratio": {"value": None, "reason": "缺少负债数据"}}
    )

    assert result["has_data"] is False
    assert "无法计算比率" in result["message"]
    assert all(ratio["value"] is None for ratio in result["ratios"])


def test_compute_cashflow_trend_balances_with_decimal_precision() -> None:
    result = compute_cashflow_trend(
        {
            "2026-01": {"income": Decimal("10000.00"), "expense": Decimal("6000.00")},
            "2026-02": {"income": Decimal("12000.00"), "expense": Decimal("8000.00")},
        }
    )

    assert [item["month"] for item in result["trend"]] == ["2026-01", "2026-02"]
    assert result["trend"][0]["income"] == Decimal("10000.00")
    assert result["trend"][0]["balance"] == Decimal("4000.00")
    assert result["trend"][1]["balance"] == Decimal("4000.00")


def test_compute_expense_breakdown_computes_shares() -> None:
    result = compute_expense_breakdown(
        {"餐饮": Decimal("60.00"), "交通": Decimal("40.00")}
    )

    assert result["total"] == Decimal("100.00")
    categories = {item["category"]: item for item in result["categories"]}
    assert categories["餐饮"]["amount"] == Decimal("60.00")
    assert categories["餐饮"]["share"] == Decimal("0.6")
    assert categories["餐饮"]["share_percent"] == "60.00%"
    assert categories["交通"]["share"] == Decimal("0.4")
    # 按金额降序
    assert result["categories"][0]["category"] == "餐饮"


def test_compute_scenario_extra_saving_increases_balance() -> None:
    result = compute_scenario(
        Decimal("10000.00"),
        Decimal("6000.00"),
        ZERO,
        Decimal("-500.00"),
    )

    assert result["current_monthly_balance"] == Decimal("4000.00")
    assert result["adjusted_monthly_balance"] == Decimal("4500.00")
    assert result["balance_change"] == Decimal("500.00")
    assert "非承诺" in result["note"]
    assert "不提供投资建议" in result["note"]


@pytest.mark.asyncio
async def test_tools_return_real_data_and_refs_from_db() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    now = datetime.now()
    async with sessions() as session:
        session.add_all(
            [
                User(id=1, email="a@example.com", password_hash="hash"),
                Ledger(id=1, user_id=1, name="默认账本"),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="income",
                    category="工资",
                    amount=Decimal("12000.00"),
                    occurred_at=now,
                ),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="餐饮",
                    amount=Decimal("60.00"),
                    occurred_at=now,
                ),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="expense",
                    category="交通",
                    amount=Decimal("40.00"),
                    occurred_at=now,
                ),
            ]
        )
        await session.commit()

    tools = {tool.name: tool for tool in create_analysis_tools(sessions)}
    assert set(tools) == {
        "get_ratio_analysis",
        "get_cashflow_trend",
        "get_expense_breakdown",
        "simulate_scenario",
    }

    breakdown = json.loads(await tools["get_expense_breakdown"].ainvoke({"user_id": 1}))
    assert breakdown["data"]["total"] == "100.00"
    assert breakdown["dataset_refs"][0]["source"] == "get_expense_breakdown"

    trend = json.loads(
        await tools["get_cashflow_trend"].ainvoke({"user_id": 1, "months": 6})
    )
    current = trend["data"]["trend"][-1]
    assert current["income"] == "12000.00"
    assert current["balance"] == "11900.00"
    assert trend["data"]["months"] == 6

    # 有收支数据 → 储蓄率可计算；无资产负债 → 相关比率为空 + 说明，绝不编造
    ratio = json.loads(await tools["get_ratio_analysis"].ainvoke({"user_id": 1}))
    assert ratio["data"]["has_data"] is True
    by_key = {item["key"]: item for item in ratio["data"]["ratios"]}
    assert by_key["savings_rate"]["value"] is not None
    assert by_key["debt_ratio"]["value"] is None
    assert by_key["debt_ratio"]["reason"]

    # 无任何数据 → 空 + 说明
    empty = json.loads(await tools["get_ratio_analysis"].ainvoke({"user_id": 2}))
    assert empty["data"]["has_data"] is False
    assert "无法计算比率" in empty["data"]["message"]

    await engine.dispose()
