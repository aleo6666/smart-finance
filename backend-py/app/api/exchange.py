"""汇率看板 API：最新汇率 / 单币种详情 / 异常告警 / 周报 / 上下文。

对齐旧 Node 后端 server/src/routes/exchange.js。汇率是全局公开数据，
与 Node 一致不要求登录（无需 user 维度）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.services import exchange_rate as service

router = APIRouter(prefix="/api/exchange", tags=["exchange"])


def _serialize_history(rows) -> list[dict]:
    return [
        {
            "fetched_at": row.fetched_at.isoformat(),
            "rate": float(row.rate),
        }
        for row in rows
    ]


@router.get("/latest")
async def latest_rates(db: AsyncSession = Depends(get_db)) -> dict:
    rates = await service.get_latest_rates(db)
    data: dict = {}
    for currency, row in rates.items():
        change = await service.get_24h_change(db, currency)
        data[currency] = {
            "rate": float(row.rate),
            "updatedAt": row.fetched_at.isoformat(),
            "change24h": round(change["change"], 2) if change else None,
        }
    return {"success": True, "data": data}


@router.get("/detail/{currency}")
async def detail_rate(currency: str, db: AsyncSession = Depends(get_db)) -> dict:
    upper = currency.upper()
    latest = await service.get_latest_rate(db, upper)
    history = await service.get_history(db, upper, 168)
    trend = await service.get_consecutive_trend(db, upper, 3)
    change = await service.get_24h_change(db, upper)
    advice = await service.get_rate_advice(db, upper)
    weekly = await service.generate_weekly_report(db)
    return {
        "success": True,
        "data": {
            "currency": upper,
            "current": float(latest.rate) if latest else None,
            "change24h": change,
            "history": _serialize_history(history[-48:]),
            "trend": trend,
            "advice": advice,
            "weeklyReport": weekly["currencies"].get(upper),
        },
    }


@router.get("/alerts")
async def alerts(db: AsyncSession = Depends(get_db)) -> dict:
    return {"success": True, "data": await service.detect_anomalies(db)}


@router.get("/weekly")
async def weekly(db: AsyncSession = Depends(get_db)) -> dict:
    return {"success": True, "data": await service.generate_weekly_report(db)}


@router.get("/context")
async def context(db: AsyncSession = Depends(get_db)) -> dict:
    return {"success": True, "data": await service.get_exchange_context(db)}
