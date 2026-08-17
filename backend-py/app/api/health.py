from fastapi import APIRouter


router = APIRouter(prefix="/api/health", tags=["health"])


@router.get("")
async def liveness() -> dict[str, object]:
    return {
        "success": True,
        "message": "智能财务记账助手服务运行中",
    }
