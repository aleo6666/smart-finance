from collections.abc import Awaitable, Callable

from httpx import ASGITransport, AsyncClient

from app.api.health import get_readiness_checks
from app.main import create_app
from app.services.health import ServiceStatus


ReadinessCheck = Callable[[], Awaitable[ServiceStatus]]


async def test_readiness_returns_200_when_required_services_are_healthy() -> None:
    async def healthy() -> ServiceStatus:
        return ServiceStatus(ok=True)

    app = create_app()
    app.dependency_overrides[get_readiness_checks] = lambda: {
        "mysql": healthy,
        "qdrant": healthy,
    }
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/health/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "services": {
            "mysql": {"ok": True},
            "qdrant": {"ok": True},
        },
    }


async def test_readiness_returns_503_without_leaking_dependency_exception() -> None:
    async def healthy() -> ServiceStatus:
        return ServiceStatus(ok=True)

    async def failing() -> ServiceStatus:
        raise RuntimeError("qdrant-api-key-must-not-leak")

    app = create_app()
    checks: dict[str, ReadinessCheck] = {
        "mysql": healthy,
        "qdrant": failing,
    }
    app.dependency_overrides[get_readiness_checks] = lambda: checks
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/health/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "degraded",
        "services": {
            "mysql": {"ok": True},
            "qdrant": {"ok": False, "reason": "check failed"},
        },
    }
    assert "api-key" not in response.text
