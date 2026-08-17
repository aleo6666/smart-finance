import os

import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.database import get_db
from app.main import create_app
from app.models import Base


os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("QDRANT_URL", "http://127.0.0.1:6333")
os.environ.setdefault("JWT_SECRET", "test-only-jwt-secret-with-32-characters")


@pytest_asyncio.fixture
async def api_client():
    """FastAPI TestClient backed by a fresh in-memory SQLite database."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    application = create_app(chat_agent=object())

    async def override_get_db():
        async with sessions() as session:
            yield session

    application.dependency_overrides[get_db] = override_get_db
    with TestClient(application) as client:
        yield client
    await engine.dispose()
