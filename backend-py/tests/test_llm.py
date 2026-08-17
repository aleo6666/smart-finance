from typing import Any

import pytest
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from app.core.config import Settings
from app.core.llm import embed_text, get_chat_model, parse_json_object


def make_settings(**overrides: object) -> Settings:
    values = {
        "database_url": "sqlite+aiosqlite:///:memory:",
        "qdrant_url": "http://127.0.0.1:6333",
        "jwt_secret": "test-secret-that-is-long-enough",
        "llm_api_key": "llm-secret",
        "llm_base_url": "https://llm.example.com/v1",
        "llm_model": "deepseek/deepseek-chat",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def test_json_parser_accepts_objects_and_safely_degrades_invalid_values() -> None:
    assert parse_json_object({"query": "food"}) == {"query": "food"}
    assert parse_json_object("not-json") == {}
    assert parse_json_object(None) == {}


@pytest.mark.asyncio
async def test_litellm_adapter_uses_plain_completion_and_tolerant_tool_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class FakeLiteLLM:
        @staticmethod
        def supports_parallel_function_calling(*, model: str) -> bool:
            return False

        @staticmethod
        async def acompletion(**kwargs: Any) -> dict[str, object]:
            captured.update(kwargs)
            return {
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call-1",
                                    "function": {
                                        "name": "lookup",
                                        "arguments": "not-json",
                                    },
                                }
                            ],
                        }
                    }
                ]
            }

    monkeypatch.setattr(
        "app.core.llm.importlib.import_module", lambda name: FakeLiteLLM
    )

    @tool
    async def lookup(user_id: int, query: str) -> str:
        """Look up data."""
        return "unused"

    response = await get_chat_model(make_settings()).bind_tools([lookup]).ainvoke(
        [HumanMessage(content="hello")]
    )

    assert response.tool_calls[0]["args"] == {}
    assert captured["tool_choice"] == "auto"
    assert "parallel_tool_calls" not in captured
    assert "response_format" not in captured


@pytest.mark.asyncio
async def test_embedding_empty_specific_key_falls_back_to_llm_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class FakeLiteLLM:
        @staticmethod
        async def aembedding(**kwargs: Any) -> dict[str, object]:
            captured.update(kwargs)
            return {"data": [{"embedding": [0.1, 0.2]}]}

    monkeypatch.setattr(
        "app.core.llm.importlib.import_module", lambda name: FakeLiteLLM
    )
    settings = make_settings(embedding_api_key="")

    result = await embed_text("query", settings)

    assert result == [0.1, 0.2]
    assert captured["api_key"] == "llm-secret"
