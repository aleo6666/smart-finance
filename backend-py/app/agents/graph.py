from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langgraph.graph import END, START, StateGraph

from app.agents.prompts import build_agent_system_prompt
from app.agents.nodes.cfp_node import build_cfp_context
from app.agents.state import AgentState, ValidatedToolCall
from app.agents.tools import (
    create_financial_planning_tools,
    create_query_transactions_tool,
    create_search_knowledge_base_tool,
    create_search_similar_records_tool,
)
from app.core.config import Settings, get_settings
from app.core.llm import get_chat_model, parse_json_object


MAX_ITERATIONS_FALLBACK = "需要更精确的信息，请补充条件"


def _latest_ai_message(messages: list[BaseMessage]) -> AIMessage | None:
    return next(
        (message for message in reversed(messages) if isinstance(message, AIMessage)),
        None,
    )


def _validate_calls(
    calls: list[dict[str, Any]],
    tools_by_name: dict[str, BaseTool],
    user_id: int,
) -> list[ValidatedToolCall]:
    validated: list[ValidatedToolCall] = []
    for call in calls:
        name = str(call.get("name", ""))
        call_id = str(call.get("id", ""))
        tool = tools_by_name.get(name)
        if tool is None:
            validated.append(
                {
                    "id": call_id,
                    "name": name,
                    "args": {},
                    "error": f"非法工具: {name}",
                }
            )
            continue

        raw_args = call.get("args", {})
        if not isinstance(raw_args, dict):
            validated.append(
                {
                    "id": call_id,
                    "name": name,
                    "args": {},
                    "error": "工具参数必须是 JSON 对象",
                }
            )
            continue

        args = dict(raw_args)
        schema = tool.get_input_schema()
        if "user_id" not in schema.model_fields:
            validated.append(
                {
                    "id": call_id,
                    "name": name,
                    "args": {},
                    "error": f"工具 {name} 缺少 user_id 隔离参数",
                }
            )
            continue
        args["user_id"] = user_id
        try:
            args = schema.model_validate(args).model_dump()
        except Exception as exc:
            validated.append(
                {
                    "id": call_id,
                    "name": name,
                    "args": {},
                    "error": f"工具参数不合法: {exc}",
                }
            )
            continue
        validated.append(
            {
                "id": call_id,
                "name": name,
                "args": args,
                "error": None,
            }
        )
    return validated


def _tool_payload(value: Any) -> tuple[str, str, list[dict[str, Any]]]:
    if isinstance(value, str):
        content = value
        parsed = parse_json_object(value)
    else:
        content = json.dumps(value, ensure_ascii=False, default=str)
        parsed = value if isinstance(value, dict) else {}
    context = parsed.get("context", "")
    refs = parsed.get("dataset_refs", [])
    return (
        content,
        context if isinstance(context, str) else "",
        refs if isinstance(refs, list) else [],
    )


def create_agent_graph(
    *,
    model: Any,
    tools: list[BaseTool],
    max_iterations: int = 8,
    max_context_chars: int = 12000,
    cfp_context_provider: Callable[[int], Awaitable[dict]] | None = None,
):
    tools_by_name = {tool.name: tool for tool in tools}
    bound_model = model.bind_tools(tools)

    async def inject_cfp_context(state: AgentState) -> dict[str, Any]:
        if cfp_context_provider is None:
            return {}
        context = await cfp_context_provider(state["user_id"])
        serialized = json.dumps(context, ensure_ascii=False, default=str)
        existing = state.get("retrieved_context", "")
        combined = "\n\n".join(
            part
            for part in [f"CFP 真实财务数据：\n{serialized}", existing]
            if part
        )
        return {"retrieved_context": combined[:max_context_chars]}

    async def call_model(state: AgentState) -> dict[str, Any]:
        system_message = SystemMessage(
            content=build_agent_system_prompt(state.get("retrieved_context", ""))
        )
        response = await bound_model.ainvoke(
            [system_message, *state.get("messages", [])]
        )
        if not isinstance(response, AIMessage):
            response = AIMessage(content=str(response))
        return {
            "messages": [response],
            "iterations": state.get("iterations", 0) + 1,
        }

    async def validate_tool(state: AgentState) -> dict[str, Any]:
        message = _latest_ai_message(state.get("messages", []))
        calls = message.tool_calls if message is not None else []
        return {
            "validated_tool_calls": _validate_calls(
                calls, tools_by_name, state["user_id"]
            )
        }

    async def run_one_tool(
        call: ValidatedToolCall,
    ) -> tuple[ToolMessage, str | None, str, list[dict[str, Any]]]:
        if call["error"] is not None:
            return (
                ToolMessage(
                    content=call["error"],
                    tool_call_id=call["id"],
                    name=call["name"],
                    status="error",
                ),
                None,
                "",
                [],
            )
        try:
            result = await tools_by_name[call["name"]].ainvoke(call["args"])
            content, context, refs = _tool_payload(result)
            return (
                ToolMessage(
                    content=content,
                    tool_call_id=call["id"],
                    name=call["name"],
                ),
                call["name"],
                context,
                refs,
            )
        except Exception as exc:
            return (
                ToolMessage(
                    content=f"工具执行失败: {exc}",
                    tool_call_id=call["id"],
                    name=call["name"],
                    status="error",
                ),
                call["name"],
                "",
                [],
            )

    async def execute_tool(state: AgentState) -> dict[str, Any]:
        calls = state.get("validated_tool_calls", [])
        if not calls:
            return {}
        results = await asyncio.gather(*(run_one_tool(call) for call in calls))
        contexts = [context for _, _, context, _ in results if context]
        current_context = state.get("retrieved_context", "")
        combined_context = "\n\n".join(
            part for part in [current_context, *contexts] if part
        )[:max_context_chars]
        return {
            "messages": [message for message, _, _, _ in results],
            "used_tools": [name for _, name, _, _ in results if name is not None],
            "retrieved_context": combined_context,
            "dataset_refs": [
                ref for _, _, _, refs in results for ref in refs if isinstance(ref, dict)
            ],
        }

    async def loop(state: AgentState) -> dict[str, Any]:
        message = _latest_ai_message(state.get("messages", []))
        has_tool_calls = bool(message and message.tool_calls)
        if has_tool_calls and state.get("iterations", 0) >= max_iterations:
            return {
                "messages": [AIMessage(content=MAX_ITERATIONS_FALLBACK)],
                "continue_loop": False,
            }
        return {"continue_loop": has_tool_calls}

    def route_loop(state: AgentState) -> str:
        return "call_model" if state.get("continue_loop", False) else "end"

    workflow = StateGraph(AgentState)
    workflow.add_node("inject_cfp_context", inject_cfp_context)
    workflow.add_node("call_model", call_model)
    workflow.add_node("validate_tool", validate_tool)
    workflow.add_node("execute_tool", execute_tool)
    workflow.add_node("loop", loop)
    workflow.add_edge(START, "inject_cfp_context")
    workflow.add_edge("inject_cfp_context", "call_model")
    workflow.add_edge("call_model", "validate_tool")
    workflow.add_edge("validate_tool", "execute_tool")
    workflow.add_edge("execute_tool", "loop")
    workflow.add_conditional_edges(
        "loop",
        route_loop,
        {"call_model": "call_model", "end": END},
    )
    return workflow.compile().with_config(
        {"recursion_limit": max_iterations * 4 + 4}
    )


def create_default_agent(
    settings: Settings | None = None,
    *,
    model: Any | None = None,
    session_factory: Any | None = None,
    qdrant_client: Any | None = None,
):
    from qdrant_client import AsyncQdrantClient

    from app.core.database import AsyncSessionLocal

    app_settings = settings or get_settings()
    sessions = session_factory or AsyncSessionLocal
    client = qdrant_client or AsyncQdrantClient(url=app_settings.qdrant_url)
    tools = [
        create_query_transactions_tool(sessions),
        create_search_similar_records_tool(client, app_settings),
        create_search_knowledge_base_tool(client, app_settings),
        *create_financial_planning_tools(sessions),
    ]

    async def provide_cfp_context(user_id: int) -> dict:
        async with sessions() as session:
            return await build_cfp_context(session, user_id)

    return create_agent_graph(
        model=model or get_chat_model(app_settings),
        tools=tools,
        max_iterations=app_settings.agent_max_iterations,
        max_context_chars=app_settings.rag_max_context_chars,
        cfp_context_provider=provide_cfp_context,
    )
