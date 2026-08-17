from decimal import Decimal

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient, Response
from pydantic import BaseModel

from app.core.errors import install_exception_handlers
from app.main import create_app


async def request(
    app: FastAPI,
    method: str,
    path: str,
    *,
    raise_app_exceptions: bool = True,
    **kwargs: object,
) -> Response:
    transport = ASGITransport(
        app=app,
        raise_app_exceptions=raise_app_exceptions,
    )
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.request(method, path, **kwargs)


async def test_health_matches_legacy_liveness_contract() -> None:
    response = await request(create_app(), "GET", "/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "message": "智能财务记账助手服务运行中",
    }


async def test_cors_allows_configured_web_origin() -> None:
    response = await request(
        create_app(),
        "OPTIONS",
        "/api/health",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


class AmountPayload(BaseModel):
    amount: Decimal


async def test_validation_errors_use_uniform_error_envelope() -> None:
    test_app = FastAPI()
    install_exception_handlers(test_app)

    @test_app.post("/_test/amount")
    async def accept_amount(payload: AmountPayload) -> dict[str, str]:
        return {"amount": str(payload.amount)}

    response = await request(
        test_app,
        "POST",
        "/_test/amount",
        json={"amount": "invalid"},
    )

    assert response.status_code == 422
    assert response.json() == {
        "success": False,
        "data": None,
        "error": "请求参数校验失败",
    }


async def test_unhandled_errors_do_not_expose_exception_details() -> None:
    test_app = FastAPI()
    install_exception_handlers(test_app)

    @test_app.get("/_test/failure")
    async def fail() -> None:
        raise RuntimeError("database password must stay private")

    response = await request(
        test_app,
        "GET",
        "/_test/failure",
        raise_app_exceptions=False,
    )

    assert response.status_code == 500
    assert response.json() == {
        "success": False,
        "data": None,
        "error": "服务器内部错误",
    }
    assert "password" not in response.text
