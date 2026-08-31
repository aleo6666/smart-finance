"""任务 B/T8：Critic 反思闭环图级集成测试。

覆盖：create_agent_graph(..., critic_model=fake) 走 analysis 意图，
analyst_loop 触发 critic，最终 state 携带 critique_log。
"""
from __future__ import annotations

import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool

from app.agents.graph import create_agent_graph


class _AnalystFake:
    def __init__(self, responses: list[str]) -> None:
        self.responses = list(responses)
        self.calls: list[list[object]] = []

    def bind_tools(self, tools: list[object]):
        return self

    async def ainvoke(self, messages: list[object]) -> AIMessage:
        self.calls.append(messages)
        return AIMessage(content=self.responses.pop(0))


class _PassCritic:
    async def ainvoke(self, messages: list[object]) -> AIMessage:
        return AIMessage(content='{"pass": true, "issues": [], "suggestion": ""}')


@tool
async def get_savings(user_id: int) -> str:
    """Return a deterministic savings ratio ref."""
    return json.dumps(
        {
            "context": "储蓄率 20.00%",
            "dataset_refs": [{"source": "get_savings", "savings_rate": "20.00%"}],
        }
    )


@pytest.mark.asyncio
async def test_critic_integration_graph_carries_critique_log() -> None:
    model = _AnalystFake(
        [
            '{"final": false, "tool": "get_savings", "args": {}}',
            '{"final": true, "analysis": "你的储蓄率为 20.00%。"}',
        ]
    )
    graph = create_agent_graph(
        model=model,
        tools=[],
        analysis_tools=[get_savings],
        critic_model=_PassCritic(),
    )

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="分析我的财务状况")], "user_id": 7},
        config={"configurable": {"thread_id": "critic-integration"}},
    )

    assert result["intent"] == "analysis"
    assert result["analysis"] == "你的储蓄率为 20.00%。"
    assert result["messages"][-1].content == "你的储蓄率为 20.00%。"
    assert result["critique_log"] == [
        {"round": 1, "pass": True, "issues": [], "suggestion": ""}
    ]
