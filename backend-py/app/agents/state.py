from __future__ import annotations

import operator
from typing import Annotated, Any, TypedDict

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages


class ValidatedToolCall(TypedDict):
    id: str
    name: str
    args: dict[str, Any]
    error: str | None


class AgentState(TypedDict, total=False):
    messages: Annotated[list[BaseMessage], add_messages]
    user_id: int
    ledger_id: int | None
    retrieved_context: str
    dataset_refs: Annotated[list[dict[str, Any]], operator.add]
    used_tools: Annotated[list[str], operator.add]
    iterations: int
    validated_tool_calls: list[ValidatedToolCall]
    continue_loop: bool
    needs_approval: bool  # 写操作待人工确认标记（loop → route_loop → human_approval）
    pending_write: dict[str, Any] | None  # 待人工确认的写操作 {tool, args, idempotency_key, reason}
    write_confirmed: bool | None  # interrupt 恢复后的人工决策
    intent: str  # 意图路由结果：analysis / chat
    analysis: str  # 分析路径外置输出字段（不进 messages，防上下文膨胀）
