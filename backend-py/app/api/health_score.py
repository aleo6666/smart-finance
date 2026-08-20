"""Financial health score API (``/api/health-score``).

Exposes the same seven-dimension CFP scoring used by the agent
(``analyze_financial_health``) as a standalone REST endpoint so the
frontend can render a dedicated health page without a chat round-trip.
"""

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.nodes.cfp_node import build_cfp_context
from app.agents.tools.financial_planning_tools import analyze_financial_health
from app.api.deps import get_current_user
from app.api.serialization import decimal_strings
from app.core.database import get_db

router = APIRouter(prefix="/api/health-score", tags=["health-score"])


@router.get("")
async def get_health_score(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    context = await build_cfp_context(db, user_id)
    analysis_input = dict(context["financial_overview"])
    analysis_input["profile"] = context["profile"]
    return {
        "success": True,
        "data": decimal_strings(
            {
                "analysis": analyze_financial_health(analysis_input),
                "assumptions": context["assumptions"],
                "guiding_questions": context["guiding_questions"],
            }
        ),
    }
