from collections.abc import Mapping

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.services.health import (
    ReadinessCheck,
    check_database,
    check_qdrant,
    run_readiness_checks,
)


router = APIRouter(prefix="/api/health", tags=["health"])


def get_readiness_checks() -> Mapping[str, ReadinessCheck]:
    return {
        "mysql": check_database,
        "qdrant": check_qdrant,
    }


@router.get("")
async def liveness() -> dict[str, object]:
    return {
        "success": True,
        "message": "智能财务记账助手服务运行中",
    }


@router.get("/ready")
async def readiness(
    checks: Mapping[str, ReadinessCheck] = Depends(get_readiness_checks),
) -> JSONResponse:
    result = await run_readiness_checks(checks)
    status_code = 200 if result["status"] == "ready" else 503
    return JSONResponse(status_code=status_code, content=result)
