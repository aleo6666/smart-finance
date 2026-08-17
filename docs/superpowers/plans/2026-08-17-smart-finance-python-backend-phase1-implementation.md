# Smart Finance Python Backend Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independently deployable FastAPI foundation in `backend-py/` with environment-only configuration, async SQLAlchemy/Alembic infrastructure, compatible health endpoints, and an isolated MySQL/Qdrant Compose stack.

**Architecture:** The Python backend is a separate package and Compose project; the legacy `server/` remains read-only. FastAPI is created through an application factory, infrastructure is isolated behind `core` and `services` modules, and host port `3000` preserves the existing Web proxy contract while the container listens on `8000`.

**Tech Stack:** Python 3.11, FastAPI, Pydantic Settings, SQLAlchemy 2.0 asyncio, Alembic, asyncmy, Qdrant client/server v1.11.3, pytest, HTTPX, Docker Compose.

---

## File map

- `backend-py/app/main.py`: FastAPI application factory, CORS, exception handlers, and router registration.
- `backend-py/app/core/config.py`: the only environment-settings definition.
- `backend-py/app/core/database.py`: async engine/session construction and request-scoped session dependency.
- `backend-py/app/core/errors.py`: uniform API exception responses.
- `backend-py/app/models/base.py`: shared SQLAlchemy declarative metadata for all future models.
- `backend-py/app/api/health.py`: liveness and readiness HTTP contracts.
- `backend-py/app/services/health.py`: dependency checks without HTTP concerns.
- `backend-py/alembic/`: asynchronous migration runtime.
- `backend-py/tests/`: phase 1 behavior and deployment-contract tests.
- `backend-py/Dockerfile`, `backend-py/docker-compose.yml`, `backend-py/.env.example`: portable runtime and local stack.
- `.gitignore`: Python virtual environment, cache, local database, and secret exclusions.

All implementation and test commands below run from `F:\projects\smart-finance\backend-py`. Git commands use `git -C ..` so their pathspecs remain relative to the repository root.

### Task 1: Bootstrap the Python package and development environment

**Files:**
- Create: `backend-py/requirements.txt`
- Create: `backend-py/pytest.ini`
- Create: `backend-py/app/__init__.py`
- Create: `backend-py/app/api/__init__.py`
- Create: `backend-py/app/core/__init__.py`
- Create: `backend-py/app/models/__init__.py`
- Create: `backend-py/app/schemas/__init__.py`
- Create: `backend-py/app/services/__init__.py`
- Create: `backend-py/app/agents/__init__.py`
- Create: `backend-py/app/agents/tools/__init__.py`
- Create: `backend-py/app/tasks/__init__.py`
- Create: `backend-py/tests/conftest.py`

- [ ] **Step 1: Create the dependency manifest**

`backend-py/requirements.txt`:

```text
fastapi>=0.115.0,<1.0.0
uvicorn[standard]>=0.30.0,<1.0.0
sqlalchemy[asyncio]>=2.0.36,<3.0.0
alembic>=1.14.0,<2.0.0
pydantic-settings>=2.7.0,<3.0.0
python-jose[cryptography]>=3.3.0,<4.0.0
passlib[bcrypt]>=1.7.4,<2.0.0
python-multipart>=0.0.20,<1.0.0
qdrant-client==1.11.3
langgraph>=0.2.60,<2.0.0
langchain>=0.3.13,<2.0.0
litellm>=1.55.0,<2.0.0
apscheduler>=3.10.4,<4.0.0
asyncmy>=0.2.10,<1.0.0
asyncpg>=0.30.0,<1.0.0
aiosqlite>=0.20.0,<1.0.0
pytest>=8.3.0,<9.0.0
pytest-asyncio>=0.24.0,<2.0.0
httpx>=0.28.0,<1.0.0
```

- [ ] **Step 2: Create pytest configuration and deterministic test environment**

`backend-py/pytest.ini`:

```ini
[pytest]
testpaths = tests
asyncio_mode = auto
```

`backend-py/tests/conftest.py`:

```python
import os


os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("QDRANT_URL", "http://127.0.0.1:6333")
os.environ.setdefault("JWT_SECRET", "test-only-jwt-secret-with-32-characters")
```

- [ ] **Step 3: Create package markers**

Use these exact contents:

`backend-py/app/__init__.py`:

```python
"""Smart Finance Python backend."""
```

`backend-py/app/api/__init__.py`:

```python
"""HTTP API routes."""
```

`backend-py/app/core/__init__.py`:

```python
"""Application configuration and infrastructure."""
```

`backend-py/app/models/__init__.py`:

```python
"""SQLAlchemy models and shared metadata."""
```

`backend-py/app/schemas/__init__.py`:

```python
"""Pydantic request and response schemas."""
```

`backend-py/app/services/__init__.py`:

```python
"""Business and infrastructure services."""
```

`backend-py/app/agents/__init__.py`:

```python
"""LangGraph agent package."""
```

`backend-py/app/agents/tools/__init__.py`:

```python
"""LangGraph tools."""
```

`backend-py/app/tasks/__init__.py`:

```python
"""Scheduled task package."""
```

- [ ] **Step 4: Create a Python 3.11 virtual environment and install dependencies**

Run from `F:\projects\smart-finance\backend-py`:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Expected: all packages resolve successfully; `asyncmy` is installed and `aiomysql` is absent from `requirements.txt`.

- [ ] **Step 5: Commit the bootstrap**

```powershell
git -C .. add -- backend-py/requirements.txt backend-py/pytest.ini backend-py/app backend-py/tests/conftest.py
git -C .. commit -m "build: initialize Python backend package"
```

### Task 2: Implement environment-only settings

**Files:**
- Create: `backend-py/tests/test_config.py`
- Create: `backend-py/app/core/config.py`

- [ ] **Step 1: Write failing settings tests**

`backend-py/tests/test_config.py`:

```python
import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_settings_read_environment_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DATABASE_URL", "mysql+asyncmy://user:pass@mysql:3306/finance")
    monkeypatch.setenv("QDRANT_URL", "http://qdrant:6333")
    monkeypatch.setenv("JWT_SECRET", "production-secret-that-is-long-enough")
    monkeypatch.setenv("LLM_API_KEY", "llm-secret")
    monkeypatch.setenv("LLM_MODEL", "zhipu/glm-4-flash")
    monkeypatch.setenv("EMBEDDING_MODEL", "zhipu/embedding-3")
    monkeypatch.setenv("CORS_ORIGINS", '["https://finance.example.com"]')
    monkeypatch.setenv("RAG_TOP_K", "12")
    monkeypatch.setenv("RAG_RERANK_TOP_K", "6")

    settings = Settings(_env_file=None)

    assert settings.app_env == "production"
    assert settings.database_url.startswith("mysql+asyncmy://")
    assert settings.qdrant_url == "http://qdrant:6333"
    assert settings.jwt_secret.get_secret_value() == "production-secret-that-is-long-enough"
    assert settings.llm_api_key is not None
    assert settings.llm_api_key.get_secret_value() == "llm-secret"
    assert settings.cors_origins == ["https://finance.example.com"]
    assert settings.rag_top_k == 12
    assert settings.rag_rerank_top_k == 6


def test_settings_have_safe_phase_one_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    monkeypatch.setenv("QDRANT_URL", "http://127.0.0.1:6333")
    monkeypatch.setenv("JWT_SECRET", "test-secret-that-is-long-enough")
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)

    settings = Settings(_env_file=None)

    assert settings.redis_url is None
    assert settings.llm_api_key is None
    assert settings.embedding_api_key is None
    assert settings.rag_top_k == 10
    assert settings.rag_rerank_top_k == 5
    assert settings.rag_max_context_chars == 12000


def test_rerank_count_cannot_exceed_recall_count() -> None:
    with pytest.raises(ValidationError, match="cannot exceed"):
        Settings(
            _env_file=None,
            database_url="sqlite+aiosqlite:///:memory:",
            qdrant_url="http://127.0.0.1:6333",
            jwt_secret="test-secret-that-is-long-enough",
            rag_top_k=4,
            rag_rerank_top_k=5,
        )
```

- [ ] **Step 2: Run the tests and verify the expected failure**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_config.py -v
```

Expected: collection fails with `ModuleNotFoundError: No module named 'app.core.config'`.

- [ ] **Step 3: Implement the settings model**

`backend-py/app/core/config.py`:

```python
from functools import lru_cache
from typing import Literal, Self

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "Smart Finance API"
    app_env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    cors_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173"]
    )

    database_url: str
    qdrant_url: str
    redis_url: str | None = None

    llm_api_key: SecretStr | None = None
    llm_base_url: str | None = None
    llm_model: str = "zhipu/glm-4-flash"
    embedding_api_key: SecretStr | None = None
    embedding_base_url: str | None = None
    embedding_model: str = "zhipu/embedding-3"
    rerank_api_key: SecretStr | None = None
    rerank_base_url: str | None = None
    rerank_model: str = "bge-reranker-v2-m3"

    jwt_secret: SecretStr
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = Field(default=10080, ge=1)

    rag_top_k: int = Field(default=10, ge=1, le=100)
    rag_rerank_top_k: int = Field(default=5, ge=1, le=100)
    rag_max_context_chars: int = Field(default=12000, ge=1000)

    @model_validator(mode="after")
    def validate_rerank_count(self) -> Self:
        if self.rag_rerank_top_k > self.rag_top_k:
            raise ValueError("RAG_RERANK_TOP_K cannot exceed RAG_TOP_K")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 4: Run settings tests and verify green**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_config.py -v
```

Expected: `3 passed`.

- [ ] **Step 5: Commit settings**

```powershell
git -C .. add -- backend-py/app/core/config.py backend-py/tests/test_config.py
git -C .. commit -m "feat: add environment-based Python settings"
```

### Task 3: Add async SQLAlchemy infrastructure

**Files:**
- Create: `backend-py/tests/test_database.py`
- Create: `backend-py/app/models/base.py`
- Modify: `backend-py/app/models/__init__.py`
- Create: `backend-py/app/core/database.py`

- [ ] **Step 1: Write failing database tests**

`backend-py/tests/test_database.py`:

```python
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
```

- [ ] **Step 2: Run tests and verify the expected failure**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_database.py -v
```

Expected: collection fails because `app.core.database` does not exist.

- [ ] **Step 3: Implement shared model metadata**

`backend-py/app/models/base.py`:

```python
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Declarative base shared by every Smart Finance model."""
```

`backend-py/app/models/__init__.py`:

```python
"""SQLAlchemy models and shared metadata."""

from app.models.base import Base

__all__ = ["Base"]
```

- [ ] **Step 4: Implement engine, session factory, and request dependency**

`backend-py/app/core/database.py`:

```python
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
```

- [ ] **Step 5: Run database tests and verify green**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_database.py -v
```

Expected: `5 passed`.

- [ ] **Step 6: Commit database infrastructure**

```powershell
git -C .. add -- backend-py/app/core/database.py backend-py/app/models backend-py/tests/test_database.py
git -C .. commit -m "feat: add async database infrastructure"
```

### Task 4: Configure asynchronous Alembic migrations

**Files:**
- Create: `backend-py/tests/test_alembic.py`
- Create: `backend-py/alembic.ini`
- Create: `backend-py/alembic/env.py`
- Create: `backend-py/alembic/script.py.mako`
- Create: `backend-py/alembic/versions/.gitkeep`

- [ ] **Step 1: Write a failing Alembic smoke test**

`backend-py/tests/test_alembic.py`:

```python
import os
from pathlib import Path
import subprocess
import sys


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def test_alembic_environment_runs_with_async_sqlite(tmp_path: Path) -> None:
    environment = os.environ.copy()
    database_path = (tmp_path / "alembic-smoke.db").as_posix()
    environment["DATABASE_URL"] = f"sqlite+aiosqlite:///{database_path}"
    environment["QDRANT_URL"] = "http://127.0.0.1:6333"
    environment["JWT_SECRET"] = "test-only-jwt-secret-with-32-characters"

    result = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", "current"],
        cwd=BACKEND_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
```

- [ ] **Step 2: Run the smoke test and verify the expected failure**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_alembic.py -v
```

Expected: FAIL because `alembic.ini` does not exist.

- [ ] **Step 3: Add Alembic configuration**

`backend-py/alembic.ini`:

```ini
[alembic]
script_location = %(here)s/alembic
prepend_sys_path = .
path_separator = os
sqlalchemy.url = sqlite+aiosqlite:///./smart_finance.db

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARN
handlers = console
qualname =

[logger_sqlalchemy]
level = WARN
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
datefmt = %H:%M:%S
```

`backend-py/alembic/env.py`:

```python
from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.core.config import get_settings
from app.models import Base


config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.database_url.replace("%", "%%"))
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=settings.database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

`backend-py/alembic/script.py.mako`:

```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision: str = ${repr(up_revision)}
down_revision: str | Sequence[str] | None = ${repr(down_revision)}
branch_labels: str | Sequence[str] | None = ${repr(branch_labels)}
depends_on: str | Sequence[str] | None = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "return None"}


def downgrade() -> None:
    ${downgrades if downgrades else "return None"}
```

`backend-py/alembic/versions/.gitkeep` is an empty file.

- [ ] **Step 4: Run the Alembic smoke test and verify green**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_alembic.py -v
```

Expected: `1 passed` and no migration files are generated.

- [ ] **Step 5: Commit Alembic configuration**

```powershell
git -C .. add -- backend-py/alembic.ini backend-py/alembic backend-py/tests/test_alembic.py
git -C .. commit -m "feat: configure async Alembic migrations"
```

### Task 5: Add the application factory, uniform errors, and liveness endpoint

**Files:**
- Create: `backend-py/tests/test_app.py`
- Create: `backend-py/app/core/errors.py`
- Create: `backend-py/app/api/health.py`
- Create: `backend-py/app/main.py`

- [ ] **Step 1: Write failing application-contract tests**

`backend-py/tests/test_app.py`:

```python
from decimal import Decimal

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.core.errors import install_exception_handlers
from app.main import create_app


def test_health_matches_legacy_liveness_contract() -> None:
    response = TestClient(create_app()).get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "message": "智能财务记账助手服务运行中",
    }


def test_cors_allows_configured_web_origin() -> None:
    response = TestClient(create_app()).options(
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


def test_validation_errors_use_uniform_error_envelope() -> None:
    test_app = FastAPI()
    install_exception_handlers(test_app)

    @test_app.post("/_test/amount")
    async def accept_amount(payload: AmountPayload) -> dict[str, str]:
        return {"amount": str(payload.amount)}

    response = TestClient(test_app).post("/_test/amount", json={"amount": "invalid"})

    assert response.status_code == 422
    assert response.json() == {
        "success": False,
        "data": None,
        "error": "请求参数校验失败",
    }


def test_unhandled_errors_do_not_expose_exception_details() -> None:
    test_app = FastAPI()
    install_exception_handlers(test_app)

    @test_app.get("/_test/failure")
    async def fail() -> None:
        raise RuntimeError("database password must stay private")

    response = TestClient(test_app, raise_server_exceptions=False).get("/_test/failure")

    assert response.status_code == 500
    assert response.json() == {
        "success": False,
        "data": None,
        "error": "服务器内部错误",
    }
    assert "password" not in response.text
```

- [ ] **Step 2: Run tests and verify the expected failure**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_app.py -v
```

Expected: collection fails because `app.core.errors` and `app.main` do not exist.

- [ ] **Step 3: Implement uniform exception handlers**

`backend-py/app/core/errors.py`:

```python
import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


logger = logging.getLogger(__name__)


def error_payload(message: str) -> dict[str, object]:
    return {"success": False, "data": None, "error": message}


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _request: Request,
        _exc: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=error_payload("请求参数校验失败"),
        )

    @app.exception_handler(HTTPException)
    async def handle_http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=error_payload(str(exc.detail)),
            headers=exc.headers,
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled API error on %s", request.url.path, exc_info=exc)
        return JSONResponse(
            status_code=500,
            content=error_payload("服务器内部错误"),
        )
```

- [ ] **Step 4: Implement liveness route and application factory**

`backend-py/app/api/health.py`:

```python
from fastapi import APIRouter


router = APIRouter(prefix="/api/health", tags=["health"])


@router.get("")
async def liveness() -> dict[str, object]:
    return {
        "success": True,
        "message": "智能财务记账助手服务运行中",
    }
```

`backend-py/app/main.py`:

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.health import router as health_router
from app.core.config import Settings, get_settings
from app.core.errors import install_exception_handlers


def create_app(settings: Settings | None = None) -> FastAPI:
    app_settings = settings or get_settings()
    application = FastAPI(title=app_settings.app_name)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    install_exception_handlers(application)
    application.include_router(health_router)
    return application


app = create_app()
```

- [ ] **Step 5: Run application tests and verify green**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_app.py -v
```

Expected: `4 passed`.

- [ ] **Step 6: Commit the FastAPI foundation**

```powershell
git -C .. add -- backend-py/app/api/health.py backend-py/app/core/errors.py backend-py/app/main.py backend-py/tests/test_app.py
git -C .. commit -m "feat: add FastAPI liveness foundation"
```

### Task 6: Add MySQL and Qdrant readiness checks

**Files:**
- Create: `backend-py/tests/test_readiness.py`
- Create: `backend-py/app/services/health.py`
- Modify: `backend-py/app/api/health.py`

- [ ] **Step 1: Write failing readiness tests**

`backend-py/tests/test_readiness.py`:

```python
from collections.abc import Awaitable, Callable

from fastapi.testclient import TestClient

from app.api.health import get_readiness_checks
from app.main import create_app
from app.services.health import ServiceStatus


ReadinessCheck = Callable[[], Awaitable[ServiceStatus]]


def test_readiness_returns_200_when_required_services_are_healthy() -> None:
    async def healthy() -> ServiceStatus:
        return ServiceStatus(ok=True)

    app = create_app()
    app.dependency_overrides[get_readiness_checks] = lambda: {
        "mysql": healthy,
        "qdrant": healthy,
    }

    response = TestClient(app).get("/api/health/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "services": {
            "mysql": {"ok": True},
            "qdrant": {"ok": True},
        },
    }


def test_readiness_returns_503_without_leaking_dependency_exception() -> None:
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

    response = TestClient(app).get("/api/health/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "degraded",
        "services": {
            "mysql": {"ok": True},
            "qdrant": {"ok": False, "reason": "check failed"},
        },
    }
    assert "api-key" not in response.text
```

- [ ] **Step 2: Run readiness tests and verify the expected failure**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_readiness.py -v
```

Expected: collection fails because `get_readiness_checks` and `app.services.health` do not exist.

- [ ] **Step 3: Implement dependency checks**

`backend-py/app/services/health.py`:

```python
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
```

- [ ] **Step 4: Add the readiness route**

Replace `backend-py/app/api/health.py` with:

```python
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
```

- [ ] **Step 5: Run readiness and application tests**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_readiness.py tests/test_app.py -v
```

Expected: `6 passed`.

- [ ] **Step 6: Commit readiness checks**

```powershell
git -C .. add -- backend-py/app/api/health.py backend-py/app/services/health.py backend-py/tests/test_readiness.py
git -C .. commit -m "feat: add database and Qdrant readiness checks"
```

### Task 7: Add portable Docker and environment configuration

**Files:**
- Create: `backend-py/tests/test_deployment_contract.py`
- Create: `backend-py/.env.example`
- Create: `backend-py/.dockerignore`
- Create: `backend-py/Dockerfile`
- Create: `backend-py/docker-compose.yml`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing deployment-contract tests**

`backend-py/tests/test_deployment_contract.py`:

```python
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def read_file(name: str) -> str:
    return (BACKEND_ROOT / name).read_text(encoding="utf-8")


def test_compose_pins_qdrant_and_preserves_host_port_contract() -> None:
    compose = read_file("docker-compose.yml")

    assert "qdrant/qdrant:v1.11.3" in compose
    assert "qdrant/qdrant:latest" not in compose
    assert '"127.0.0.1:${BACKEND_PORT:-3000}:8000"' in compose
    assert "mysql:8.4" in compose


def test_python_dependencies_use_asyncmy_not_aiomysql() -> None:
    requirements = read_file("requirements.txt")

    assert "asyncmy" in requirements
    assert "aiomysql" not in requirements


def test_python_qdrant_client_matches_pinned_server() -> None:
    requirements = read_file("requirements.txt").splitlines()

    assert "qdrant-client==1.11.3" in requirements


def test_dockerfile_runs_as_non_root_python_311_user() -> None:
    dockerfile = read_file("Dockerfile")

    assert dockerfile.startswith("FROM python:3.11-slim")
    assert "USER app" in dockerfile
    assert "uvicorn app.main:app" in dockerfile


def test_environment_example_lists_required_phase_one_settings() -> None:
    keys = {
        line.split("=", 1)[0]
        for line in read_file(".env.example").splitlines()
        if line and not line.startswith("#") and "=" in line
    }

    assert {
        "DATABASE_URL",
        "QDRANT_URL",
        "REDIS_URL",
        "LLM_API_KEY",
        "EMBEDDING_API_KEY",
        "RERANK_API_KEY",
        "JWT_SECRET",
        "RAG_TOP_K",
        "RAG_RERANK_TOP_K",
        "RAG_MAX_CONTEXT_CHARS",
    } <= keys
```

- [ ] **Step 2: Run deployment tests and verify the expected failure**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_deployment_contract.py -v
```

Expected: tests fail because `Dockerfile`, `docker-compose.yml`, and `.env.example` do not exist.

- [ ] **Step 3: Add the environment template**

`backend-py/.env.example`:

```dotenv
APP_NAME=Smart Finance API
APP_ENV=development
LOG_LEVEL=INFO
CORS_ORIGINS=["http://localhost:5173"]
BACKEND_PORT=3000

MYSQL_DATABASE=smart_finance
MYSQL_USER=finance
MYSQL_PASSWORD=change-me-db-password
MYSQL_ROOT_PASSWORD=change-me-root-password
DATABASE_URL=mysql+asyncmy://finance:change-me-db-password@mysql:3306/smart_finance

QDRANT_URL=http://qdrant:6333
REDIS_URL=

LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=zhipu/glm-4-flash
EMBEDDING_API_KEY=
EMBEDDING_BASE_URL=
EMBEDDING_MODEL=zhipu/embedding-3
RERANK_API_KEY=
RERANK_BASE_URL=
RERANK_MODEL=bge-reranker-v2-m3

JWT_SECRET=replace-with-at-least-32-random-characters
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=10080

RAG_TOP_K=10
RAG_RERANK_TOP_K=5
RAG_MAX_CONTEXT_CHARS=12000
```

- [ ] **Step 4: Add Docker build files**

`backend-py/.dockerignore`:

```text
.env
.venv/
__pycache__/
.pytest_cache/
*.py[cod]
*.db
tests/
```

`backend-py/Dockerfile`:

```dockerfile
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY --chown=app:app app ./app
COPY --chown=app:app alembic ./alembic
COPY --chown=app:app alembic.ini ./alembic.ini

USER app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 5: Add the isolated Compose stack**

`backend-py/docker-compose.yml`:

```yaml
name: smart-finance-py

services:
  mysql:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: ${MYSQL_DATABASE:-smart_finance}
      MYSQL_USER: ${MYSQL_USER:-finance}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD:-change-me-db-password}
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-change-me-root-password}
    volumes:
      - mysql_data:/var/lib/mysql
    healthcheck:
      test: ["CMD-SHELL", "MYSQL_PWD=$$MYSQL_PASSWORD mysqladmin ping -h 127.0.0.1 -u$$MYSQL_USER --silent"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s

  qdrant:
    image: qdrant/qdrant:v1.11.3
    restart: unless-stopped
    volumes:
      - qdrant_data:/qdrant/storage
    healthcheck:
      test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/127.0.0.1/6333'"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 10s

  backend:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    init: true
    depends_on:
      mysql:
        condition: service_healthy
      qdrant:
        condition: service_healthy
    ports:
      - "127.0.0.1:${BACKEND_PORT:-3000}:8000"
    environment:
      APP_NAME: ${APP_NAME:-Smart Finance API}
      APP_ENV: ${APP_ENV:-development}
      LOG_LEVEL: ${LOG_LEVEL:-INFO}
      CORS_ORIGINS: '${CORS_ORIGINS:-["http://localhost:5173"]}'
      DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL in .env}
      QDRANT_URL: ${QDRANT_URL:-http://qdrant:6333}
      REDIS_URL: '${REDIS_URL:-}'
      LLM_API_KEY: '${LLM_API_KEY:-}'
      LLM_BASE_URL: '${LLM_BASE_URL:-}'
      LLM_MODEL: ${LLM_MODEL:-zhipu/glm-4-flash}
      EMBEDDING_API_KEY: '${EMBEDDING_API_KEY:-}'
      EMBEDDING_BASE_URL: '${EMBEDDING_BASE_URL:-}'
      EMBEDDING_MODEL: ${EMBEDDING_MODEL:-zhipu/embedding-3}
      RERANK_API_KEY: '${RERANK_API_KEY:-}'
      RERANK_BASE_URL: '${RERANK_BASE_URL:-}'
      RERANK_MODEL: ${RERANK_MODEL:-bge-reranker-v2-m3}
      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET in .env}
      JWT_ALGORITHM: ${JWT_ALGORITHM:-HS256}
      JWT_EXPIRE_MINUTES: ${JWT_EXPIRE_MINUTES:-10080}
      RAG_TOP_K: ${RAG_TOP_K:-10}
      RAG_RERANK_TOP_K: ${RAG_RERANK_TOP_K:-5}
      RAG_MAX_CONTEXT_CHARS: ${RAG_MAX_CONTEXT_CHARS:-12000}
    healthcheck:
      test:
        - CMD
        - python
        - -c
        - import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 10s

volumes:
  mysql_data:
  qdrant_data:
```

- [ ] **Step 6: Extend repository ignores**

Append to `.gitignore`:

```gitignore
backend-py/.venv/
backend-py/.pytest_cache/
backend-py/.env
backend-py/*.db
backend-py/.coverage
backend-py/htmlcov/
```

- [ ] **Step 7: Run deployment-contract tests and Compose parsing**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_deployment_contract.py -v
docker compose --env-file .env.example config --quiet
```

Expected: `4 passed`; Compose exits with code 0 and prints no error.

- [ ] **Step 8: Commit deployment configuration**

```powershell
git -C .. add -- .gitignore backend-py/.env.example backend-py/.dockerignore backend-py/Dockerfile backend-py/docker-compose.yml backend-py/tests/test_deployment_contract.py
git -C .. commit -m "build: add isolated Python backend Compose stack"
```

### Task 8: Verify phase 1 end to end

**Files:**
- Verify only; no production files are created in this task.

- [ ] **Step 1: Run the complete Python test suite**

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

Expected: all phase 1 tests pass with no failures or collection warnings.

- [ ] **Step 2: Compile every application module**

```powershell
.\.venv\Scripts\python.exe -m compileall -q app
```

Expected: exit code 0 and no syntax errors.

- [ ] **Step 3: Verify Alembic and Compose configuration**

```powershell
$env:DATABASE_URL = 'sqlite+aiosqlite:///./alembic-verify.db'
$env:QDRANT_URL = 'http://127.0.0.1:6333'
$env:JWT_SECRET = 'verification-only-jwt-secret-32-chars'
.\.venv\Scripts\python.exe -m alembic -c alembic.ini current
Remove-Item Env:DATABASE_URL,Env:QDRANT_URL,Env:JWT_SECRET
docker compose --env-file .env.example config --quiet
```

Expected: both commands exit 0. Remove `backend-py/alembic-verify.db` after confirming it is the exact temporary file created by this command.

```powershell
$expectedTemporaryDb = Join-Path (Get-Location) 'alembic-verify.db'
$resolvedTemporaryDb = (Resolve-Path -LiteralPath '.\alembic-verify.db').Path
if ($resolvedTemporaryDb -ne $expectedTemporaryDb) {
    throw "Refusing to remove unexpected path: $resolvedTemporaryDb"
}
Remove-Item -LiteralPath $resolvedTemporaryDb
```

- [ ] **Step 4: Confirm host port 3000 is free before Docker startup**

```powershell
$listeners = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
    $listeners | Select-Object LocalAddress, LocalPort, OwningProcess
    throw 'Port 3000 is occupied; stop the owning process before starting Smart Finance Python.'
}
Write-Output 'Port 3000 is free.'
```

Expected: `Port 3000 is free.` No unrelated process is terminated automatically.

- [ ] **Step 5: Ensure Docker Desktop is available**

```powershell
docker info
```

If the daemon is unavailable, start the installed Docker Desktop application without opening an extra interactive window, then check readiness in five-second intervals for at most one minute:

```powershell
$dockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
if (-not (Test-Path -LiteralPath $dockerDesktop)) {
    throw "Docker Desktop executable not found at $dockerDesktop"
}
Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
for ($attempt = 0; $attempt -lt 12; $attempt++) {
    Start-Sleep -Seconds 5
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { break }
}
docker info
```

Expected: Docker reports server information. If it remains unavailable, record container verification as environment-blocked and retain the successful local test evidence.

- [ ] **Step 6: Build and start the isolated stack**

Copy the non-secret development template, then start the stack:

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
docker compose up -d --build
docker compose ps
```

Expected: `mysql`, `qdrant`, and `backend` reach `healthy`. `.env` remains ignored by Git.

- [ ] **Step 7: Verify both health contracts through host port 3000**

```powershell
$live = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health'
$ready = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health/ready'
$live | ConvertTo-Json -Compress
$ready | ConvertTo-Json -Depth 4 -Compress
```

Expected liveness:

```json
{"success":true,"message":"智能财务记账助手服务运行中"}
```

Expected readiness has `status: ready`, with `mysql.ok` and `qdrant.ok` both true.

- [ ] **Step 8: Confirm repository cleanliness and retained runtime**

```powershell
git -C .. status --short --branch
docker compose ps
```

Expected: no uncommitted tracked changes; the new Python stack stays running for continued development. The old Node `server/` has no modifications.
