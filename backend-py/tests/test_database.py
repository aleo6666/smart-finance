import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import create_database_engine, create_session_factory


@pytest.mark.parametrize(
    ("database_url", "driver_name"),
    [
        ("sqlite+aiosqlite:///:memory:", "sqlite+aiosqlite"),
        ("mysql+asyncmy://user:pass@localhost:3306/finance", "mysql+asyncmy"),
        ("postgresql+asyncpg://user:pass@localhost:5432/finance", "postgresql+asyncpg"),
    ],
)
async def test_create_database_engine_accepts_supported_async_drivers(
    database_url: str,
    driver_name: str,
) -> None:
    engine = create_database_engine(database_url)
    try:
        assert engine.url.drivername == driver_name
    finally:
        await engine.dispose()


def test_create_database_engine_rejects_sync_driver() -> None:
    with pytest.raises(ValueError, match="async database driver"):
        create_database_engine("mysql+pymysql://user:pass@localhost:3306/finance")


async def test_session_factory_creates_async_sessions() -> None:
    engine = create_database_engine("sqlite+aiosqlite:///:memory:")
    session_factory = create_session_factory(engine)
    try:
        async with session_factory() as session:
            assert isinstance(session, AsyncSession)
    finally:
        await engine.dispose()
