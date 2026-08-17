from collections.abc import AsyncIterator

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import get_settings


SUPPORTED_ASYNC_DRIVERS = {
    "mysql+asyncmy",
    "postgresql+asyncpg",
    "sqlite+aiosqlite",
}


def create_database_engine(database_url: str) -> AsyncEngine:
    driver_name = make_url(database_url).drivername
    if driver_name not in SUPPORTED_ASYNC_DRIVERS:
        supported = ", ".join(sorted(SUPPORTED_ASYNC_DRIVERS))
        raise ValueError(f"DATABASE_URL must use an async database driver: {supported}")
    return create_async_engine(database_url, pool_pre_ping=True)


def create_session_factory(
    database_engine: AsyncEngine,
) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(
        bind=database_engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )


settings = get_settings()
engine = create_database_engine(settings.database_url)
AsyncSessionLocal = create_session_factory(engine)


async def get_db() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        yield session
