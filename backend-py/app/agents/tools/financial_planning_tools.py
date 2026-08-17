import json
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agents.nodes.cfp_node import build_cfp_context


ZERO = Decimal("0")
ONE_HUNDRED = Decimal("100")
MONEY = Decimal("0.01")
DISCLAIMER = "以上为通用财务建议，不构成投资建议，不推荐具体产品"


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return Decimal(value)
    if isinstance(value, str):
        return Decimal(value)
    raise TypeError("financial calculations require Decimal-compatible values")


def _metric_value(overview: dict, key: str) -> Decimal | None:
    metric = overview.get("metrics", overview).get(key)
    if isinstance(metric, dict):
        metric = metric.get("value")
    return _decimal(metric)


def _advice(message: str) -> str:
    return f"{message}。{DISCLAIMER}"


def _dimension(
    name: str,
    score: Decimal,
    issues: list[str],
    advice: list[str],
) -> dict:
    safe_score = min(ONE_HUNDRED, max(ZERO, score))
    safe_advice = advice or [f"保持{name}现有安排并定期复核"]
    return {
        "name": name,
        "score": safe_score,
        "issues": issues,
        "advice": [_advice(item) for item in safe_advice],
    }


def analyze_financial_health(overview: dict) -> dict:
    """Evaluate seven CFP dimensions using deterministic Decimal rules."""
    liquidity = _metric_value(overview, "liquidity_ratio")
    savings = _metric_value(overview, "savings_rate")
    debt_income = _metric_value(overview, "debt_to_income")
    debt_ratio = _metric_value(overview, "debt_ratio")
    investment = _metric_value(overview, "investment_ratio")
    net_worth = _metric_value(overview, "net_worth")
    profile = overview.get("profile") or {}

    cash_score = Decimal("100")
    cash_issues: list[str] = []
    cash_advice: list[str] = []
    if liquidity is None:
        cash_score -= Decimal("40")
        cash_issues.append("缺少流动资产或月支出数据")
        cash_advice.append("补充现金、存款及月支出数据后重新评估应急能力")
    elif liquidity < Decimal("3"):
        cash_score -= Decimal("60")
        cash_issues.append("流动性比率低于 3 个月")
        cash_advice.append("优先预留 3-6 个月应急金")
    elif liquidity < Decimal("6"):
        cash_score -= Decimal("15")
    if savings is not None and savings < Decimal("0.20"):
        cash_score -= Decimal("20")
        cash_issues.append("储蓄率低于 20%")
        cash_advice.append("逐步将储蓄率提升至 20%，减少非必要支出")

    debt_score = Decimal("100")
    debt_issues: list[str] = []
    debt_advice: list[str] = []
    if debt_income is None:
        debt_score -= Decimal("40")
        debt_issues.append("缺少月还款额或收入数据")
        debt_advice.append("补充月还款额与收入数据以评估偿债压力")
    elif debt_income > Decimal("0.40"):
        debt_score -= Decimal("55")
        debt_issues.append("负债收入比高于 40%")
        debt_advice.append("降低新增负债并优先安排高成本债务还款")
    elif debt_income > Decimal("0.30"):
        debt_score -= Decimal("20")
    if debt_ratio is not None and debt_ratio > Decimal("0.60"):
        debt_score -= Decimal("25")
        debt_issues.append("总负债占总资产比例偏高")

    investment_score = Decimal("100")
    investment_issues: list[str] = []
    investment_advice: list[str] = []
    if investment is None:
        investment_score -= Decimal("40")
        investment_issues.append("缺少投资资产数据")
        investment_advice.append("补充投资资产及风险偏好后再评估资产配置")
    elif investment == ZERO:
        investment_score -= Decimal("60")
        investment_issues.append("尚无投资类资产")
        investment_advice.append("在应急金充足后，按风险承受能力考虑分散配置")

    age = profile.get("age")
    children = profile.get("children")
    dependents = profile.get("dependents")
    risk_preference = profile.get("risk_preference")

    insurance_issues: list[str] = []
    insurance_advice: list[str] = []
    insurance_score = Decimal("70")
    if dependents is None:
        insurance_score -= Decimal("10")
        insurance_issues.append("缺少家庭赡养责任信息")
    insurance_advice.append("结合家庭责任核对基础保障缺口与保费承受能力")

    education_issues: list[str] = []
    education_advice: list[str] = []
    education_score = Decimal("80")
    if children is None:
        education_score -= Decimal("20")
        education_issues.append("缺少子女及教育目标信息")
        education_advice.append("补充子女年龄和教育目标金额以制定教育金计划")
    elif children > 0:
        education_advice.append("按教育目标日期分阶段测算并跟踪教育金进度")

    retirement_issues: list[str] = []
    retirement_advice: list[str] = []
    retirement_score = Decimal("80")
    if age is None:
        retirement_score -= Decimal("20")
        retirement_issues.append("缺少年龄信息")
        retirement_advice.append("补充年龄、退休时间与预期支出以估算养老缺口")
    else:
        retirement_advice.append("结合距退休年限定期复核养老储蓄进度")

    estate_issues: list[str] = []
    estate_advice: list[str] = []
    estate_score = Decimal("80")
    if net_worth is None:
        estate_score -= Decimal("20")
        estate_issues.append("缺少净资产数据")
    if risk_preference is None:
        estate_score -= Decimal("10")
        estate_issues.append("缺少风险偏好信息")
    estate_advice.append("梳理资产、负债、受益安排及重要凭证并定期更新")

    dimensions = [
        _dimension("现金管理", cash_score, cash_issues, cash_advice),
        _dimension("负债管理", debt_score, debt_issues, debt_advice),
        _dimension("保险配置", insurance_score, insurance_issues, insurance_advice),
        _dimension("投资组合", investment_score, investment_issues, investment_advice),
        _dimension("教育金", education_score, education_issues, education_advice),
        _dimension("养老规划", retirement_score, retirement_issues, retirement_advice),
        _dimension("财产分配", estate_score, estate_issues, estate_advice),
    ]
    total_score = (
        sum((item["score"] for item in dimensions), ZERO) / Decimal(len(dimensions))
    ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    priorities = sorted(dimensions, key=lambda item: item["score"])[:2]
    return {
        "dimensions": dimensions,
        "total_score": total_score,
        "overall_advice": [
            _advice(f"优先改善{item['name']}维度") for item in priorities
        ],
    }


def plan_financial_goal(
    target_amount: Decimal,
    current_amount: Decimal,
    monthly_income: Decimal,
    monthly_expenses: Decimal,
    target_months: int,
) -> dict:
    """Calculate goal feasibility without investment-return assumptions."""
    target = _decimal(target_amount)
    current = _decimal(current_amount)
    income = _decimal(monthly_income)
    expenses = _decimal(monthly_expenses)
    if None in {target, current, income, expenses}:
        raise ValueError("all goal inputs are required")
    assert target is not None and current is not None
    assert income is not None and expenses is not None
    if min(target, current, income, expenses) < ZERO:
        raise ValueError("goal amounts must be nonnegative")
    if target_months < 1:
        raise ValueError("target_months must be at least 1")

    gap = max(target - current, ZERO).quantize(MONEY, rounding=ROUND_HALF_UP)
    required = (gap / Decimal(target_months)).quantize(
        MONEY, rounding=ROUND_HALF_UP
    )
    available = income - expenses
    feasible = gap == ZERO or (available > ZERO and available >= required)
    if gap == ZERO:
        months_needed: int | None = 0
    elif available <= ZERO:
        months_needed = None
    else:
        months_needed = int(
            (gap / available).to_integral_value(rounding=ROUND_CEILING)
        )

    if gap == ZERO:
        message = "目标已达到，可转入定期复核"
    elif feasible:
        message = f"按当前每月可储蓄 {available.quantize(MONEY)} 元可在目标期内完成"
    else:
        message = "当前储蓄能力存在缺口，可延长目标期限、降低目标金额或减少非必要支出"
    return {
        "required_monthly_saving": required,
        "gap": gap,
        "feasible": feasible,
        "months_needed": months_needed,
        "advice": _advice(message),
    }


def create_financial_planning_tools(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[BaseTool]:
    async def health_tool(user_id: int) -> str:
        async with session_factory() as session:
            context = await build_cfp_context(session, user_id)
        analysis_input = dict(context["financial_overview"])
        analysis_input["profile"] = context["profile"]
        payload = {
            "analysis": analyze_financial_health(analysis_input),
            "assumptions": context["assumptions"],
            "guiding_questions": context["guiding_questions"],
        }
        return json.dumps(payload, ensure_ascii=False, default=str)

    async def goal_tool(
        user_id: int,
        target_amount: Decimal,
        current_amount: Decimal,
        monthly_income: Decimal,
        monthly_expenses: Decimal,
        target_months: int,
    ) -> str:
        del user_id
        return json.dumps(
            plan_financial_goal(
                target_amount,
                current_amount,
                monthly_income,
                monthly_expenses,
                target_months,
            ),
            ensure_ascii=False,
            default=str,
        )

    return [
        StructuredTool.from_function(
            coroutine=health_tool,
            name="analyze_financial_health",
            description="基于用户真实财务概览进行七维 CFP 健康评估。",
        ),
        StructuredTool.from_function(
            coroutine=goal_tool,
            name="plan_financial_goal",
            description="使用确定性计算评估财务目标的储蓄要求和可行性。",
        ),
    ]
