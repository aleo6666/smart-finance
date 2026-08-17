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
