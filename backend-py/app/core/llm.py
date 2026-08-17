from __future__ import annotations

from copy import copy
import importlib
import json
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool

from app.core.config import Settings, get_settings


def parse_json_object(value: Any) -> dict[str, Any]:
    """Parse model JSON without allowing malformed output to break the agent."""
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    text = value.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(lines[1:-1]) if len(lines) > 2 else ""
    try:
        parsed = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _message_to_dict(message: BaseMessage) -> dict[str, Any]:
    role_by_type = {
        "system": "system",
        "human": "user",
        "ai": "assistant",
        "tool": "tool",
    }
    result: dict[str, Any] = {
        "role": role_by_type.get(message.type, message.type),
        "content": message.content,
    }
    if message.type == "ai" and getattr(message, "tool_calls", None):
        result["tool_calls"] = [
            {
                "id": call["id"],
                "type": "function",
                "function": {
                    "name": call["name"],
                    "arguments": json.dumps(call.get("args", {}), ensure_ascii=False),
                },
            }
            for call in message.tool_calls
        ]
    if message.type == "tool":
        result["tool_call_id"] = message.tool_call_id
        if message.name:
            result["name"] = message.name
    return result


def _value(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


class LiteLLMChatModel:
    """Small LangChain-shaped adapter around LiteLLM's async completion API."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.tools: list[BaseTool] = []

    def bind_tools(self, tools: list[BaseTool]) -> LiteLLMChatModel:
        bound = copy(self)
        bound.tools = list(tools)
        return bound

    async def ainvoke(self, messages: list[BaseMessage]) -> AIMessage:
        litellm = importlib.import_module("litellm")
        kwargs: dict[str, Any] = {
            "model": self.settings.llm_model,
            "messages": [_message_to_dict(message) for message in messages],
        }
        if self.settings.llm_api_key is not None:
            kwargs["api_key"] = self.settings.llm_api_key.get_secret_value()
        if self.settings.llm_base_url:
            kwargs["api_base"] = self.settings.llm_base_url
        if self.tools:
            kwargs["tools"] = [convert_to_openai_tool(tool) for tool in self.tools]
            kwargs["tool_choice"] = "auto"
            supports_parallel = getattr(
                litellm, "supports_parallel_function_calling", None
            )
            if supports_parallel is not None:
                try:
                    if supports_parallel(model=self.settings.llm_model):
                        kwargs["parallel_tool_calls"] = True
                except Exception:
                    pass

        response = await litellm.acompletion(**kwargs)
        message = _value(_value(response, "choices")[0], "message")
        tool_calls = []
        for call in _value(message, "tool_calls", []) or []:
            function = _value(call, "function", {})
            arguments = _value(function, "arguments", "{}")
            tool_calls.append(
                {
                    "name": _value(function, "name", ""),
                    "args": parse_json_object(arguments),
                    "id": _value(call, "id", ""),
                    "type": "tool_call",
                }
            )
        return AIMessage(
            content=_value(message, "content", "") or "",
            tool_calls=tool_calls,
        )


def get_chat_model(settings: Settings | None = None) -> LiteLLMChatModel:
    return LiteLLMChatModel(settings or get_settings())


async def embed_text(text: str, settings: Settings | None = None) -> list[float]:
    app_settings = settings or get_settings()
    litellm = importlib.import_module("litellm")
    kwargs: dict[str, Any] = {
        "model": app_settings.embedding_model,
        "input": [text],
    }
    api_key = app_settings.embedding_api_key or app_settings.llm_api_key
    if api_key is not None:
        kwargs["api_key"] = api_key.get_secret_value()
    api_base = app_settings.embedding_base_url or app_settings.llm_base_url
    if api_base:
        kwargs["api_base"] = api_base

    response = await litellm.aembedding(**kwargs)
    data = _value(response, "data", [])
    embedding = _value(data[0], "embedding", []) if data else []
    return list(embedding)
