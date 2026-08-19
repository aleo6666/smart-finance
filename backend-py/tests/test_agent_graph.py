import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool

from app.agents.graph import create_agent_graph


class ScriptedModel:
    def __init__(self, responses: list[AIMessage]):
        self.responses = list(responses)
        self.calls: list[list[object]] = []
        self.bound_tools: list[object] = []

    def bind_tools(self, tools: list[object]):
        self.bound_tools = tools
        return self

    async def ainvoke(self, messages: list[object]) -> AIMessage:
        self.calls.append(messages)
        return self.responses.pop(0)


def tool_call(name: str, arguments: dict[str, object], call_id: str) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {"name": name, "args": arguments, "id": call_id, "type": "tool_call"}
        ],
    )


@pytest.mark.asyncio
async def test_routes_tool_call_and_forces_state_user_id() -> None:
    observed_user_ids: list[int] = []

    @tool
    async def lookup(user_id: int, query: str) -> str:
        """Look up records for one user."""
        observed_user_ids.append(user_id)
        return json.dumps({"context": "record", "dataset_refs": []})

    model = ScriptedModel(
        [tool_call("lookup", {"user_id": 999, "query": "food"}, "call-1"), AIMessage(content="done")]
    )
    graph = create_agent_graph(model=model, tools=[lookup])

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="food")], "user_id": 7}
    ,
        config={"configurable": {"thread_id": "test"}})

    assert observed_user_ids == [7]
    assert result["used_tools"] == ["lookup"]
    assert result["messages"][-1].content == "done"


@pytest.mark.asyncio
async def test_supports_multiple_tool_rounds() -> None:
    calls: list[str] = []

    @tool
    async def first(user_id: int) -> str:
        """First lookup."""
        calls.append("first")
        return "first result"

    @tool
    async def second(user_id: int) -> str:
        """Second lookup."""
        calls.append("second")
        return "second result"

    model = ScriptedModel(
        [
            tool_call("first", {}, "call-1"),
            tool_call("second", {}, "call-2"),
            AIMessage(content="final"),
        ]
    )
    graph = create_agent_graph(model=model, tools=[first, second])

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="question")], "user_id": 3}
    ,
        config={"configurable": {"thread_id": "test"}})

    assert calls == ["first", "second"]
    assert result["used_tools"] == ["first", "second"]
    assert len([message for message in result["messages"] if isinstance(message, ToolMessage)]) == 2


@pytest.mark.asyncio
async def test_max_iterations_returns_safe_fallback() -> None:
    @tool
    async def lookup(user_id: int) -> str:
        """Look up data."""
        return "result"

    model = ScriptedModel(
        [tool_call("lookup", {}, f"call-{index}") for index in range(8)]
    )
    graph = create_agent_graph(model=model, tools=[lookup], max_iterations=8)

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="question")], "user_id": 3}
    ,
        config={"configurable": {"thread_id": "test"}})

    assert len(model.calls) == 8
    assert result["messages"][-1].content == "需要更精确的信息，请补充条件"


@pytest.mark.asyncio
async def test_validate_tool_blocks_unknown_tool_name() -> None:
    @tool
    async def allowed(user_id: int) -> str:
        """Allowed lookup."""
        raise AssertionError("unknown tool must not execute")

    model = ScriptedModel(
        [tool_call("not_allowed", {}, "bad-call"), AIMessage(content="recovered")]
    )
    graph = create_agent_graph(model=model, tools=[allowed])

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="question")], "user_id": 3}
    ,
        config={"configurable": {"thread_id": "test"}})

    tool_messages = [
        message for message in result["messages"] if isinstance(message, ToolMessage)
    ]
    assert result["used_tools"] == []
    assert len(tool_messages) == 1
    assert "非法工具" in tool_messages[0].content
    assert result["messages"][-1].content == "recovered"


@pytest.mark.asyncio
async def test_combined_retrieval_context_respects_total_character_limit() -> None:
    @tool
    async def lookup(user_id: int, part: str) -> str:
        """Look up one context part."""
        return json.dumps({"context": part * 40, "dataset_refs": []})

    model = ScriptedModel(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "lookup",
                        "args": {"part": "A"},
                        "id": "call-a",
                        "type": "tool_call",
                    },
                    {
                        "name": "lookup",
                        "args": {"part": "B"},
                        "id": "call-b",
                        "type": "tool_call",
                    },
                ],
            ),
            AIMessage(content="final"),
        ]
    )
    graph = create_agent_graph(
        model=model,
        tools=[lookup],
        max_context_chars=60,
    )

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="question")], "user_id": 3}
    ,
        config={"configurable": {"thread_id": "test"}})

    assert len(result["retrieved_context"]) == 60


@pytest.mark.asyncio
async def test_injects_cfp_context_before_first_model_call() -> None:
    observed_user_ids: list[int] = []

    async def context_provider(user_id: int) -> dict:
        observed_user_ids.append(user_id)
        return {
            "income_by_source": {"salary": "10000.00"},
            "assumptions": ["基于以下假设：风险偏好信息缺省"],
        }

    model = ScriptedModel([AIMessage(content="done")])
    graph = create_agent_graph(
        model=model,
        tools=[],
        cfp_context_provider=context_provider,
    )

    await graph.ainvoke(
        {"messages": [HumanMessage(content="规划")], "user_id": 7}
    ,
        config={"configurable": {"thread_id": "test"}})

    assert observed_user_ids == [7]
    system_prompt = model.calls[0][0].content
    assert "CFP 真实财务数据" in system_prompt
    assert '"salary": "10000.00"' in system_prompt
    assert "基于以下假设：风险偏好信息缺省" in system_prompt
