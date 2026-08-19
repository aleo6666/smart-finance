import os
from decimal import Decimal
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
    embedding_dimension: int = Field(default=1024, ge=1)
    rerank_api_key: SecretStr | None = None
    rerank_base_url: str | None = None
    rerank_model: str = "bge-reranker-v2-m3"

    jwt_secret: SecretStr
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = Field(default=10080, ge=1)

    rag_top_k: int = Field(default=10, ge=1, le=100)
    rag_rerank_top_k: int = Field(default=5, ge=1, le=100)
    rag_max_context_chars: int = Field(default=12000, ge=1000)
    agent_max_iterations: int = Field(default=8, ge=1, le=32)
    analyst_max_iterations: int = Field(default=5, ge=1, le=10)
    memory_auto_ingest: bool = True
    session_history_limit: int = Field(default=20, ge=1)  # 滑动窗口注入条数
    summary_threshold: int = Field(default=20, ge=1)  # 触发滚动摘要的消息数阈值
    history_retention: int = Field(default=500, ge=1)  # 每用户历史保留上限
    anomaly_standard_deviations: Decimal = Field(
        default=Decimal("2"), gt=Decimal("0")
    )

    record_confirm_threshold: Decimal = Field(
        default=Decimal("200"), gt=Decimal("0")
    )  # 大额确认阈值
    confirm_fast_categories: list[str] = Field(
        default_factory=lambda: ["餐饮", "交通", "日用品", "娱乐", "医疗"]
    )  # 小额直通白名单
    confirm_ambiguous_words: list[str] = Field(
        default_factory=lambda: ["报销", "分期", "借款", "预付", "押金"]
    )  # 歧义词触发确认
    tool_timeout: float = Field(default=30.0)  # 单次 LLM/工具调用超时秒数

    xfyun_app_id: str | None = None
    xfyun_api_key: str | None = None
    xfyun_api_secret: str | None = None

    schedule_enabled: bool = False

    upload_dir: str = "./uploads"

    backup_dir: str = "./backups"
    backup_retention: int = Field(default=7, ge=1)

    s3_endpoint_url: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_bucket: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_xfyun_appid(cls, values):
        # 旧 Node .env 用 XFYUN_APPID（无下划线）；兼容两种拼写
        if isinstance(values, dict) and not values.get("xfyun_app_id"):
            legacy = os.environ.get("XFYUN_APPID")
            if legacy:
                values["xfyun_app_id"] = legacy
        return values

    @model_validator(mode="after")
    def validate_rerank_count(self) -> Self:
        if self.rag_rerank_top_k > self.rag_top_k:
            raise ValueError("RAG_RERANK_TOP_K cannot exceed RAG_TOP_K")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
