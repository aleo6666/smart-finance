from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agents.nodes.cfp_node import build_cfp_context
from app.agents.tools.financial_planning_tools import (
    DISCLAIMER,
    analyze_financial_health,
    create_financial_planning_tools,
    plan_financial_goal,
)
from app.models import (
    Asset,
    Base,
    Ledger,
    Liability,
    Transaction,
    User,
    UserProfile,
)


def test_analyze_financial_health_penalizes_low_liquidity() -> None:
    result = analyze_financial_health(
        {
            "metrics": {
                "liquidity_ratio": {"value": Decimal("1.5")},
                "savings_rate": {"value": Decimal("0.10")},
                "debt_to_income": {"value": Decimal("0.45")},
                "debt_ratio": {"value": Decimal("0.30")},
                "investment_ratio": {"value": Decimal("0")},
                "net_worth": {"value": Decimal("10000")},
            },
            "profile": {"age": 35, "children": 1, "risk_preference": "稳健"},
        }
    )

    dimensions = {item["name"]: item for item in result["dimensions"]}
    assert len(dimensions) == 7
    assert dimensions["现金管理"]["score"] < Decimal("60")
    assert any("3-6 个月应急金" in item for item in dimensions["现金管理"]["advice"])
    assert dimensions["投资组合"]["score"] < Decimal("60")
    assert Decimal("0") <= result["total_score"] <= Decimal("100")
    for dimension in result["dimensions"]:
        assert all(DISCLAIMER in advice for advice in dimension["advice"])
    assert all(DISCLAIMER in advice for advice in result["overall_advice"])


def test_plan_financial_goal_calculates_feasibility_with_decimal() -> None:
    result = plan_financial_goal(
        target_amount=Decimal("100000"),
        current_amount=Decimal("20000"),
        monthly_income=Decimal("10000"),
        monthly_expenses=Decimal("6000"),
        target_months=20,
    )

    assert result["required_monthly_saving"] == Decimal("4000.00")
    assert result["gap"] == Decimal("80000.00")
    assert result["feasible"] is True
    assert result["months_needed"] == 20
    assert DISCLAIMER in result["advice"]


@pytest.mark.asyncio
async def test_build_cfp_context_injects_real_data_and_missing_assumptions() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        session.add_all(
            [
                User(id=1, email="cfp@example.com", password_hash="hash"),
                User(id=2, email="other@example.com", password_hash="hash"),
                Ledger(id=1, user_id=1, name="CFP"),
                Ledger(id=2, user_id=2, name="Other"),
                Transaction(
                    user_id=1,
                    ledger_id=1,
                    type="income",
                    category="salary",
                    income_source="salary",
                    amount=Decimal("12000"),
                    occurred_at=datetime.now(),
                ),
                Transaction(
                    user_id=2,
                    ledger_id=2,
                    type="income",
                    category="salary",
                    income_source="salary",
                    amount=Decimal("999999"),
                    occurred_at=datetime.now(),
                ),
                Asset(user_id=1, type="cash", name="cash", amount=Decimal("30000")),
                Liability(
                    user_id=1,
                    type="loan",
                    name="loan",
                    amount=Decimal("5000"),
                    monthly_payment=Decimal("500"),
                ),
                UserProfile(user_id=1, age=32, occupation="工程师", children=0),
            ]
        )
        await session.commit()

        context = await build_cfp_context(session, user_id=1)

    assert context["financial_overview"]["raw"]["assets"]["total"] == Decimal("30000.00")
    assert context["financial_overview"]["raw"]["liabilities"]["total"] == Decimal("5000.00")
    assert context["income_by_source"] == {"salary": Decimal("12000.00")}
    assert context["profile"]["age"] == 32
    assert context["profile"]["risk_preference"] is None
    assert any("风险偏好" in assumption for assumption in context["assumptions"])
    assert "请补充您的年龄/风险偏好，以便优化配置建议" in context["guiding_questions"]

    tools = create_financial_planning_tools(sessions)
    assert {tool.name for tool in tools} == {
        "analyze_financial_health",
        "plan_financial_goal",
    }
    await engine.dispose()
