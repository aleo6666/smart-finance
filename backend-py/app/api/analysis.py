from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.serialization import decimal_strings
from app.core.config import Settings, get_settings
from app.core.database import get_db
from app.services.analysis_service import (
    get_all_analyses,
    get_anomaly_analysis,
    get_benchmark_comparison,
    get_budget_analysis,
    get_cashflow_forecast,
    get_goal_analysis,
)


router = APIRouter(prefix="/api/analysis", tags=["analysis"])


class UserAnalysisRequest(BaseModel):
    user_id: int = Field(gt=0)


class BudgetAnalysisRequest(UserAnalysisRequest):
    ledger_id: int | None = Field(default=None, gt=0)
    month: str

    @field_validator("month")
    @classmethod
    def validate_month(cls, value: str) -> str:
        try:
            datetime.strptime(value, "%Y-%m")
        except ValueError as exc:
            raise ValueError("month must use YYYY-MM format") from exc
        return value


class AnomalyAnalysisRequest(UserAnalysisRequest):
    days: int = Field(default=30, ge=1, le=365)


@router.post("/budget")
async def budget_analysis(
    payload: BudgetAnalysisRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    result = await get_budget_analysis(
        db, payload.user_id, payload.month, payload.ledger_id
    )
    return decimal_strings(result)


@router.post("/forecast")
async def cashflow_forecast(
    payload: UserAnalysisRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    return decimal_strings(await get_cashflow_forecast(db, payload.user_id))


@router.post("/anomalies")
async def anomaly_analysis(
    payload: AnomalyAnalysisRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict:
    return decimal_strings(
        await get_anomaly_analysis(
            db,
            payload.user_id,
            payload.days,
            settings.anomaly_standard_deviations,
        )
    )


@router.post("/goals")
async def goal_analysis(
    payload: UserAnalysisRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    return decimal_strings(await get_goal_analysis(db, payload.user_id))


@router.post("/benchmark")
async def benchmark_analysis(
    payload: UserAnalysisRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    return decimal_strings(await get_benchmark_comparison(db, payload.user_id))


@router.get("/all")
async def all_analyses(
    user_id: int = Query(gt=0),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict:
    return decimal_strings(
        await get_all_analyses(
            db, user_id, settings.anomaly_standard_deviations
        )
    )
