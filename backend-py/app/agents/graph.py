from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.tools import BaseTool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from app.agents.prompts import build_agent_system_prompt
from app.agents.nodes.analyst_loop import create_analyst_loop_node
from app.agents.nodes.cfp_node import build_cfp_context
from app.agents.nodes.confirm_policy import confirm_required, is_first_category
from app.agents.nodes.memory_node import create_memory_node
from app.agents.nodes.record_draft import create_record_draft_node
from app.agents.state import AgentState, ValidatedToolCall
from app.agents.tools import (
    create_analysis_tools,
    create_create_record_tool,
    create_financial_planning_tools,
    create_query_transactions_tool,
    create_search_knowledge_base_tool,
    create_search_similar_records_tool,
)
from app.agents.tools.create_record import compute_idempotency_key, insert_record
from app.core.config import Settings, get_settings
from app.core.llm import get_chat_model, parse_json_object


MAX_ITERATIONS_FALLBACK = "需要更精确的信息，请补充条件"
logger = logging.getLogger(__name__)

# 分析类意图关键字（中文/英文），命中则走受约束 analyst_loop；否则走原记账 workflow
ANALYSIS_INTENT_KEYWORDS = (
    "health",
    "ratio",
    "trend",
    "breakdown",
    "scenario",
    "analysis",
    "健康",
    "比率",
    "负债率",
    "储蓄率",
    "流动性",
    "趋势",
    "结构",
    "占比",
    "情景",
    "推演",
    "分析",
    "现金流",
    "支出构成",
    "财务状况",
    "财务怎么样",
    "财务体检",
    "体检",
)


def classify_intent(text: str) -> str:
    """Deterministic intent routing (no LLM): analysis / record / chat."""
    normalized = str(text).lower()
    if any(keyword in normalized for keyword in ANALYSIS_INTENT_KEYWORDS):
        return "analysis"
    if _looks_like_record(normalized):
        return "record"
    return "chat"


_RECORD_VERBS = (
    "花了", "用了", "买了", "付了", "吃了", "喝了", "转了", "缴了",
    "支出", "消费", "记账", "记一笔", "收入", "收到", "工资", "赚了",
    "充值", "付款", "买了", "打车", "地铁", "外卖", "早餐", "午餐",
    "晚餐", "房租", "水电", "话费", "打车", "购物", "存了",
)
_RECORD_AMOUNT_RE = re.compile(r"\d+(?:\.\d+)?\s*(?:元|块|钱|rmb)?")


def _looks_like_record(text: str) -> bool:
    """记账语句特征：含金额（可无单位）+ 消费/收入动词。第一性约束：没金额不记账。"""
    has_money = bool(_RECORD_AMOUNT_RE.search(text))
    if not has_money:
        return False
    return any(verb in text for verb in _RECORD_VERBS)


def _latest_ai_message(messages: list[BaseMessage]) -> AIMessage | None:
    return next(
        (message for message in reversed(messages) if isinstance(message, AIMessage)),
        None,
    )


def _latest_user_text(messages: list[BaseMessage]) -> str:
    return next(
        (
            str(message.content)
            for message in reversed(messages)
            if isinstance(message, HumanMessage)
        ),
        "",
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
    tool_timeout: float = 30.0,
    analyst_max_iterations: int = 5,
    analysis_tools: list[BaseTool] | None = None,
    cfp_context_provider: Callable[[int], Awaitable[dict]] | None = None,
    memory_processor: Callable[[AgentState], Awaitable[dict[str, Any]]] | None = None,
    pending_write_executor: Callable[[dict[str, Any]], Awaitable[str]] | None = None,
    sessions_factory: Any | None = None,
):
    tools_by_name = {tool.name: tool for tool in tools}
    bound_model = model.bind_tools(tools)
    analysis_tools = list(analysis_tools or [])
    analyst_loop = create_analyst_loop_node(
        model=model,
        analysis_tools=analysis_tools,
        tool_timeout=tool_timeout,
        analyst_max_iterations=analyst_max_iterations,
    )
    record_draft = create_record_draft_node(model, tool_timeout)

    async def route_intent(state: AgentState) -> dict[str, Any]:
        return {"intent": classify_intent(_latest_user_text(state.get("messages", [])))}

    def route_from_intent(state: AgentState) -> str:
        intent = state.get("intent", "chat")
        if intent == "analysis":
            return "analyst_loop"
        if intent == "record":
            return "record_draft"
        return "inject_cfp_context"

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
        try:
            response = await asyncio.wait_for(
                bound_model.ainvoke(
                    [system_message, *state.get("messages", [])]
                ),
                timeout=tool_timeout,
            )
        except asyncio.TimeoutError:
            logger.warning("call_model timed out after %ss", tool_timeout)
            return {
                "messages": [AIMessage(content="处理超时，请重试或缩小问题范围")],
                "iterations": state.get("iterations", 0) + 1,
            }
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
            result = await asyncio.wait_for(
                tools_by_name[call["name"]].ainvoke(call["args"]),
                timeout=tool_timeout,
            )
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
        except asyncio.TimeoutError:
            return (
                ToolMessage(
                    content=f"工具 {call['name']} 执行超时",
                    tool_call_id=call["id"],
                    name=call["name"],
                    status="error",
                ),
                call["name"],
                "",
                [],
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
        # 检测写确认：create_record 返回 confirm_required=True → 挂起等待人工确认
        pending = state.get("pending_write")
        for call, (msg, name, _, _) in zip(calls, results):
            if name == "create_record" and msg.content:
                try:
                    parsed = json.loads(msg.content)
                    if isinstance(parsed, dict) and parsed.get("confirm_required"):
                        pending = {
                            "tool": name,
                            "id": call["id"],
                            "args": call["args"],
                            "idempotency_key": parsed.get("idempotency_key"),
                            "reason": parsed.get("reason", ""),
                        }
                except Exception:
                    pass
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
            "pending_write": pending,
        }

    async def human_approval(state: AgentState) -> dict[str, Any]:
        """interrupt 等待用户确认写操作；确认后通过确定性写入执行器落库（幂等）。"""
        pending = state.get("pending_write")
        if pending is None:
            return {"write_confirmed": False, "pending_write": None}
        decision = interrupt({"pending_write": pending})
        if decision is True and pending_write_executor is not None:
            try:
                content = await pending_write_executor(pending)
                return {
                    "messages": [AIMessage(content=content)],
                    "write_confirmed": True,
                    "pending_write": None,
                }
            except Exception as exc:
                return {
                    "messages": [
                        AIMessage(content=f"确认后写入失败，请重试：{exc}")
                    ],
                    "write_confirmed": False,
                    "pending_write": None,
                }
        return {
            "messages": [AIMessage(content="已取消该笔记账。")],
            "write_confirmed": False,
            "pending_write": None,
        }

    async def loop(state: AgentState) -> dict[str, Any]:
        message = _latest_ai_message(state.get("messages", []))
        has_tool_calls = bool(message and message.tool_calls)
        if has_tool_calls and state.get("iterations", 0) >= max_iterations:
            return {
                "messages": [AIMessage(content=MAX_ITERATIONS_FALLBACK)],
                "continue_loop": False,
            }
        # 写操作待确认 → 挂起等人工（优先于继续工具循环）
        if state.get("pending_write") is not None:
            return {"continue_loop": False, "needs_approval": True}
        return {"continue_loop": has_tool_calls, "needs_approval": False}

    def route_loop(state: AgentState) -> str:
        if state.get("needs_approval", False):
            return "human_approval"
        return "call_model" if state.get("continue_loop", False) else "end"

    async def persist_memory(state: AgentState) -> dict[str, Any]:
        if memory_processor is None:
            return {}
        try:
            return await memory_processor(state)
        except Exception:
            logger.warning("Agent memory step failed", exc_info=True)
            return {}

    async def execute_record_workflow(state: AgentState) -> dict[str, Any]:
        """记账确定性 workflow：draft → confirm_policy → 直通落库 or 挂起确认。

        全程零 ReAct 循环：LLM 只做了 record_draft 一次提取，这里全确定性。
        """
        draft = state.get("record_draft")
        if draft is None:
            return {}
        user_id = state["user_id"]
        settings_obj = get_settings()
        try:
            async with sessions_factory() as session:
                first = await is_first_category(session, user_id, draft["category"])
                decision = confirm_required(
                    {
                        "amount": draft["amount"],
                        "category": draft["category"],
                        "note": draft.get("note", ""),
                    },
                    settings_obj,
                    is_first_category=first,
                )
        except Exception as exc:
            logger.warning("confirm_policy failed: %s", exc)
            decision = {"confirm_required": False, "reason": None}

        if not decision["confirm_required"]:
            # 小额直通：确定性落库
            try:
                async with sessions_factory() as session:
                    key = compute_idempotency_key(
                        user_id,
                        draft["amount"],
                        draft["category"],
                        draft.get("note"),
                        draft.get("occurred_at") or None,
                    )
                    record = await insert_record(
                        session,
                        user_id=user_id,
                        type=draft["type"],
                        category=draft["category"],
                        amount=draft["amount"],
                        currency="CNY",
                        note=draft.get("note"),
                        occurred_at=draft.get("occurred_at") or None,
                        idempotency_key=key,
                    )
                message = f"已记账：{record.category} {record.amount} 元"
                return {
                    "messages": [AIMessage(content=message)],
                    "dataset_refs": [
                        {
                            "record_id": record.id,
                            "amount": str(record.amount),
                            "category": record.category,
                        }
                    ],
                }
            except Exception as exc:
                logger.warning("record write failed: %s", exc)
                return {
                    "messages": [
                        AIMessage(content="记账写入失败，请稍后重试或手动记录")
                    ]
                }
        # 大额/新类别/歧义 → 挂起人工确认
        key = compute_idempotency_key(
            user_id,
            draft["amount"],
            draft["category"],
            draft.get("note"),
            draft.get("occurred_at") or None,
        )
        return {
            "pending_write": {
                "tool": "create_record",
                "id": "record-workflow",
                "args": {
                    "user_id": user_id,
                    "type": draft["type"],
                    "category": draft["category"],
                    "amount": draft["amount"],
                    "currency": "CNY",
                    "note": draft.get("note"),
                    "occurred_at": draft.get("occurred_at") or None,
                },
                "idempotency_key": key,
                "reason": decision["reason"],
            },
            "record_draft": None,
        }

    workflow = StateGraph(AgentState)
    workflow.add_node("route_intent", route_intent)
    workflow.add_node("analyst_loop", analyst_loop)
    workflow.add_node("record_draft", record_draft)
    workflow.add_node("execute_record_workflow", execute_record_workflow)
    workflow.add_node("inject_cfp_context", inject_cfp_context)
    workflow.add_node("call_model", call_model)
    workflow.add_node("validate_tool", validate_tool)
    workflow.add_node("execute_tool", execute_tool)
    workflow.add_node("loop", loop)
    workflow.add_node("human_approval", human_approval)
    workflow.add_node("persist_memory", persist_memory)
    workflow.add_edge(START, "route_intent")
    workflow.add_conditional_edges(
        "route_intent",
        route_from_intent,
        {
            "analyst_loop": "analyst_loop",
            "record_draft": "record_draft",
            "inject_cfp_context": "inject_cfp_context",
        },
    )
    workflow.add_edge("analyst_loop", "persist_memory")
    workflow.add_edge("record_draft", "execute_record_workflow")
    workflow.add_conditional_edges(
        "execute_record_workflow",
        lambda state: (
            "human_approval" if state.get("pending_write") else "persist_memory"
        ),
        {"human_approval": "human_approval", "persist_memory": "persist_memory"},
    )
    workflow.add_edge("inject_cfp_context", "call_model")
    workflow.add_edge("call_model", "validate_tool")
    workflow.add_edge("validate_tool", "execute_tool")
    workflow.add_edge("execute_tool", "loop")
    workflow.add_conditional_edges(
        "loop",
        route_loop,
        {
            "call_model": "call_model",
            "human_approval": "human_approval",
            "end": "persist_memory",
        },
    )
    workflow.add_edge("human_approval", "persist_memory")
    workflow.add_edge("persist_memory", END)
    return workflow.compile(checkpointer=MemorySaver()).with_config(
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
        create_create_record_tool(sessions, app_settings),
        *create_financial_planning_tools(sessions),
    ]
    analysis_tools = create_analysis_tools(sessions)

    async def provide_cfp_context(user_id: int) -> dict:
        async with sessions() as session:
            return await build_cfp_context(session, user_id)

    from app.agents.tools.create_record import insert_record

    async def execute_pending_write(pending: dict[str, Any]) -> str:
        """人工确认后执行写操作（幂等键保证不重复落库）。"""
        args = pending.get("args", {})
        async with sessions() as session:
            record = await insert_record(
                session,
                user_id=args["user_id"],
                type=args.get("type", "expense"),
                category=args["category"],
                amount=args["amount"],
                currency=args.get("currency", "CNY"),
                ledger_id=args.get("ledger_id"),
                note=args.get("note"),
                occurred_at=args.get("occurred_at"),
                income_source=args.get("income_source"),
                idempotency_key=pending["idempotency_key"],
            )
        return f"已确认记账：{record.category} {record.amount} 元"

    agent_model = model or get_chat_model(app_settings)
    memory_processor = create_memory_node(
        model=agent_model,
        session_factory=sessions,
        qdrant=client,
        settings=app_settings,
    )
    return create_agent_graph(
        model=agent_model,
        tools=tools,
        max_iterations=app_settings.agent_max_iterations,
        max_context_chars=app_settings.rag_max_context_chars,
        tool_timeout=app_settings.tool_timeout,
        analyst_max_iterations=app_settings.analyst_max_iterations,
        analysis_tools=analysis_tools,
        cfp_context_provider=provide_cfp_context,
        memory_processor=memory_processor,
        pending_write_executor=execute_pending_write,
        sessions_factory=sessions,
    )
