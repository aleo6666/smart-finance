import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from qdrant_client import AsyncQdrantClient
from sqlalchemy import text

from app.core.config import get_settings
from app.core.database import engine


@dataclass(frozen=True)
class ServiceStatus:
    ok: bool
    reason: str | None = None

    def to_dict(self) -> dict[str, object]:
        result: dict[str, object] = {"ok": self.ok}
        if self.reason is not None:
            result["reason"] = self.reason
        return result


ReadinessCheck = Callable[[], Awaitable[ServiceStatus]]


async def check_database() -> ServiceStatus:
    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
        return ServiceStatus(ok=True)
    except Exception:
        return ServiceStatus(ok=False, reason="database unavailable")


async def check_qdrant() -> ServiceStatus:
    settings = get_settings()
    client = AsyncQdrantClient(url=settings.qdrant_url)
    try:
        await client.get_collections()
        return ServiceStatus(ok=True)
    except Exception:
        return ServiceStatus(ok=False, reason="qdrant unavailable")
    finally:
        await client.close()


async def run_readiness_checks(
    checks: Mapping[str, ReadinessCheck],
) -> dict[str, object]:
    async def run_one(
        name: str,
        check: ReadinessCheck,
    ) -> tuple[str, ServiceStatus]:
        try:
            return name, await check()
        except Exception:
            return name, ServiceStatus(ok=False, reason="check failed")

    completed = await asyncio.gather(
        *(run_one(name, check) for name, check in checks.items())
    )
    services = {name: status.to_dict() for name, status in completed}
    ready = all(status["ok"] is True for status in services.values())
    return {
        "status": "ready" if ready else "degraded",
        "services": services,
    }
