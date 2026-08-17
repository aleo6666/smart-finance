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


def test_memory_auto_ingest_defaults_true_and_reads_environment(monkeypatch) -> None:
    base = {
        "_env_file": None,
        "database_url": "sqlite+aiosqlite:///:memory:",
        "qdrant_url": "http://qdrant:6333",
        "jwt_secret": "test-secret-that-is-long-enough",
    }

    assert Settings(**base).memory_auto_ingest is True
    monkeypatch.setenv("MEMORY_AUTO_INGEST", "false")
    assert Settings(**base).memory_auto_ingest is False
