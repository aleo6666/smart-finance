from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Transaction, UserProfile
from app.services.financial_overview import get_user_financial_overview


async def _income_by_source(
    db: AsyncSession, user_id: int, period_start: str
) -> dict[str, Decimal]:
    statement = (
        select(
            Transaction.income_source,
            func.sum(Transaction.amount).label("amount"),
        )
        .where(
            Transaction.user_id == user_id,
            Transaction.type == "income",
            Transaction.occurred_at >= datetime.fromisoformat(period_start),
        )
        .group_by(Transaction.income_source)
    )
    rows = (await db.execute(statement)).all()
    return {
        row.income_source or "other": row.amount
        for row in rows
    }


def _profile_data(profile: UserProfile | None) -> dict:
    fields = (
        "age",
        "occupation",
        "income_range",
        "marital_status",
        "children",
        "dependents",
        "risk_preference",
        "financial_goals",
    )
    if profile is None:
        return {field: None for field in fields}
    return {field: getattr(profile, field) for field in fields}


async def build_cfp_context(db: AsyncSession, user_id: int) -> dict:
    """Load user-isolated facts needed by the CFP agent without using an LLM."""
    overview = await get_user_financial_overview(db, user_id)
    income_by_source = await _income_by_source(
        db, user_id, overview["period"]["start"]
    )
    profile = await db.scalar(
        select(UserProfile).where(UserProfile.user_id == user_id)
    )
    profile_data = _profile_data(profile)

    assumptions: list[str] = []
    if overview["raw"]["assets"]["total"] is None:
        assumptions.append("基于以下假设：暂未提供资产数据")
    if overview["raw"]["liabilities"]["total"] is None:
        assumptions.append("基于以下假设：暂未提供负债数据")
    if not income_by_source:
        assumptions.append("基于以下假设：暂未提供收入来源明细")
    if profile is None:
        assumptions.append("基于以下假设：用户画像采用通用默认值")
    if profile_data["age"] is None:
        assumptions.append("基于以下假设：年龄信息缺省")
    if profile_data["risk_preference"] is None:
        assumptions.append("基于以下假设：风险偏好信息缺省")

    guiding_questions: list[str] = []
    if profile_data["age"] is None or profile_data["risk_preference"] is None:
        guiding_questions.append("请补充您的年龄/风险偏好，以便优化配置建议")

    return {
        "user_id": user_id,
        "financial_overview": overview,
        "income_by_source": income_by_source,
        "profile": profile_data,
        "assumptions": assumptions,
        "guiding_questions": guiding_questions,
    }
