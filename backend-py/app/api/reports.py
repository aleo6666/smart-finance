from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
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
