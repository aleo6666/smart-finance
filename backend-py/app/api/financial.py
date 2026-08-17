from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.services.financial_overview import get_user_financial_overview


router = APIRouter(prefix="/api/financial", tags=["financial"])
DECIMAL_RESPONSE_NOTE = "所有 Decimal 值均序列化为字符串，以保持十进制精度。"


def _decimal_strings(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {key: _decimal_strings(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_decimal_strings(item) for item in value]
    return value


@router.get("/metrics", description=DECIMAL_RESPONSE_NOTE)
async def financial_metrics(
    user_id: int = Query(gt=0),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    overview = await get_user_financial_overview(db, user_id)
    return _decimal_strings(
        {
            "user_id": overview["user_id"],
            "period": overview["period"],
            "metrics": overview["metrics"],
        }
    )


@router.get("/overview", description=DECIMAL_RESPONSE_NOTE)
async def financial_overview(
    user_id: int = Query(gt=0),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return _decimal_strings(await get_user_financial_overview(db, user_id))
