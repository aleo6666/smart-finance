"""任务 B1/B3：受约束分析师循环 + 证据链校验 + 意图路由测试。

覆盖：多轮诊断（≥2 次工具调用 + 引用真实数字）、轮次上限熔断、
超时熔断、编造数字丢弃、分析意图路由。
"""
from __future__ import annotations

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool

from app.agents.graph import classify_intent, create_agent_graph
from app.agents.nodes.analyst_loop import (
    ANALYSIS_MAX_ITERATIONS_FALLBACK,
    ANALYSIS_TIMEOUT_FALLBACK,
    create_analyst_loop_node,
    validate_analysis_against_refs,
)


class ScriptedModel:
    def __init__(self, responses: list[str]) -> None:
        self.responses = list(responses)
        self.calls: list[list[object]] = []

    async def ainvoke(self, messages: list[object]) -> AIMessage:
        self.calls.append(messages)
        return AIMessage(content=self.responses.pop(0))


@tool
async def get_ratio_analysis(user_id: int) -> str:
    """Return deterministic ratios for testing."""
    return json.dumps(
        {
            "context": "储蓄率 20.00%，负债率 30.00%",
            "dataset_refs": [
                {"source": "get_ratio_analysis", "savings_rate": "20.00%",
                 "debt_ratio": "30.00%"}
            ],
        }
    )


@tool
async def get_cashflow_trend(user_id: int, months: int = 6) -> str:
    """Return deterministic cashflow trend for testing."""
    return json.dumps(
        {
            "context": "近 6 个月月均收入 12000.00 元",
            "dataset_refs": [
                {"source": "get_cashflow_trend", "income": "12000.00", "months": 6}
            ],
        }
    )


@pytest.mark.asyncio
async def test_multi_round_diagnosis_calls_tools_and_quotes_real_numbers() -> None:
    model = ScriptedModel(
        [
            '{"final": false, "tool": "get_ratio_analysis", "args": {}}',
            '{"final": false, "tool": "get_cashflow_trend", "args": {"months": 6}}',
            '{"final": true, "analysis": "你的储蓄率为 20.00%，'
            '近 6 个月月均收入 12000.00 元。"}',
        ]
    )
    node = create_analyst_loop_node(
        model=model,
        analysis_tools=[get_ratio_analysis, get_cashflow_trend],
        tool_timeout=30.0,
        analyst_max_iterations=5,
    )

    result = await node(
        {
            "messages": [HumanMessage(content="分析我的财务状况")],
            "user_id": 7,
            "ledger_id": None,
        }
    )

    assert len(model.calls) == 3
    assert result["used_tools"] == ["get_ratio_analysis", "get_cashflow_trend"]
    assert len(result["dataset_refs"]) == 2
    assert result["analysis"] == (
        "你的储蓄率为 20.00%，近 6 个月月均收入 12000.00 元。"
    )
    assert result["intent"] == "analysis"
    assert result["messages"][-1].content == result["analysis"]


@pytest.mark.asyncio
async def test_round_limit_breaks_with_fallback() -> None:
    model = ScriptedModel(
        [
            '{"final": false, "tool": "get_ratio_analysis", "args": {}}'
            for _ in range(5)
        ]
    )
    node = create_analyst_loop_node(
        model=model,
        analysis_tools=[get_ratio_analysis],
        tool_timeout=30.0,
        analyst_max_iterations=5,
    )

    result = await node(
        {"messages": [HumanMessage(content="分析一下")], "user_id": 7, "ledger_id": None}
    )

    assert len(model.calls) == 5
    assert result["messages"][-1].content == ANALYSIS_MAX_ITERATIONS_FALLBACK
    assert result["used_tools"] == ["get_ratio_analysis"] * 5


@pytest.mark.asyncio
async def test_tool_timeout_returns_safe_fallback() -> None:
    @tool
    async def hanging_tool(user_id: int) -> str:
        """Hangs forever for timeout testing."""
        await asyncio.sleep(10)
        return "never"

    model = ScriptedModel(
        ['{"final": false, "tool": "hanging_tool", "args": {}}']
    )
    node = create_analyst_loop_node(
        model=model,
        analysis_tools=[hanging_tool],
        tool_timeout=0.2,
        analyst_max_iterations=5,
    )

    result = await node(
        {"messages": [HumanMessage(content="分析一下")], "user_id": 7, "ledger_id": None}
    )

    assert result["messages"][-1].content == ANALYSIS_TIMEOUT_FALLBACK


def test_fabricated_number_discards_that_sentence() -> None:
    refs = [{"source": "get_ratio_analysis", "savings_rate": "20.00%"}]
    analysis = "你的储蓄率为 20.00%。你的净资产为 999999.00 元。储蓄率健康。"

    validated = validate_analysis_against_refs(analysis, refs)

    assert "20.00" in validated
    assert "999999" not in validated
    assert "净资产" not in validated
    assert "储蓄率健康" in validated


def test_validate_analysis_falls_back_when_everything_is_fabricated() -> None:
    result = validate_analysis_against_refs(
        "你的净资产为 999999.00 元。", [{"source": "x", "savings_rate": "20.00%"}]
    )
    assert "未能形成有效结论" in result


def test_classify_intent_routes_analysis_keywords() -> None:
    assert classify_intent("帮我分析一下我的财务健康") == "analysis"
    assert classify_intent("查一下我的负债率") == "analysis"
    assert classify_intent("看现金流趋势") == "analysis"
    assert classify_intent("支出结构占比") == "analysis"
    assert classify_intent("情景推演一下") == "analysis"


def test_classify_intent_record_and_chat() -> None:
    # 记账意图（含金额+动词）→ record
    assert classify_intent("记一笔餐饮 25 元") == "record"
    assert classify_intent("今天午餐花了25元") == "record"
    assert classify_intent("交房租5000") == "record"
    # 普通对话 → chat
    assert classify_intent("你好") == "chat"
    assert classify_intent("这个月花了多少") == "chat"


@pytest.mark.asyncio
async def test_analysis_intent_routes_to_analyst_loop_in_graph() -> None:
    class FinalModel:
        def bind_tools(self, tools: list[object]):
            return self

        async def ainvoke(self, messages: list[object]) -> AIMessage:
            return AIMessage(
                content='{"final": true, "analysis": "请补充数据后再做详细分析。"}'
            )

    graph = create_agent_graph(model=FinalModel(), tools=[], analysis_tools=[])

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="分析我的财务状况")], "user_id": 7},
        config={"configurable": {"thread_id": "route-test"}},
    )

    assert result["intent"] == "analysis"
    assert result["analysis"] == "请补充数据后再做详细分析。"
    assert result["messages"][-1].content == "请补充数据后再做详细分析。"
