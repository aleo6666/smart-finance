"""任务 A7：确认策略 + 超时保护测试。

覆盖：阈值边界(199/200/201)、白名单、歧义词、首类别、超时熔断。
"""
from __future__ import annotations

import asyncio
from decimal import Decimal

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool

from app.agents.graph import create_agent_graph
from app.agents.nodes.confirm_policy import confirm_required


class _Settings:
    record_confirm_threshold = Decimal("200")
    confirm_fast_categories = ["餐饮", "交通", "日用品", "娱乐", "医疗"]
    confirm_ambiguous_words = ["报销", "分期", "借款", "预付", "押金"]


def test_threshold_boundaries() -> None:
    s = _Settings()
    # 199 直通（白名单类别 + 非首次）
    assert (
        confirm_required(
            {"amount": Decimal("199.00"), "category": "餐饮", "note": "午餐"},
            s,
            is_first_category=False,
        )["confirm_required"]
        is False
    )
    # 200 确认
    assert (
        confirm_required(
            {"amount": Decimal("200.00"), "category": "餐饮", "note": "午餐"},
            s,
            is_first_category=False,
        )["confirm_required"]
        is True
    )
    # 201 确认
    assert (
        confirm_required(
            {"amount": Decimal("201.00"), "category": "餐饮", "note": "午餐"},
            s,
            is_first_category=False,
        )["confirm_required"]
        is True
    )


def test_fast_category_whitelist() -> None:
    s = _Settings()
    # 白名单小额直通
    assert (
        confirm_required(
            {"amount": Decimal("30.00"), "category": "交通", "note": "地铁"},
            s,
            is_first_category=False,
        )["confirm_required"]
        is False
    )
    # 非白名单小额确认
    assert (
        confirm_required(
            {"amount": Decimal("30.00"), "category": "宠物", "note": "猫粮"},
            s,
            is_first_category=False,
        )["confirm_required"]
        is True
    )


def test_ambiguous_words() -> None:
    s = _Settings()
    assert (
        confirm_required(
            {"amount": Decimal("50.00"), "category": "餐饮", "note": "团建报销"},
            s,
            is_first_category=False,
        )["confirm_required"]
        is True
    )


def test_first_category() -> None:
    s = _Settings()
    assert (
        confirm_required(
            {"amount": Decimal("30.00"), "category": "餐饮", "note": "午餐"},
            s,
            is_first_category=True,
        )["confirm_required"]
        is True
    )


@pytest.mark.asyncio
async def test_model_timeout_returns_safe_fallback() -> None:
    class SlowModel:
        async def ainvoke(self, messages: list[object]) -> AIMessage:
            await asyncio.sleep(10)
            return AIMessage(content="never")

        def bind_tools(self, tools: list[object]):
            return self

    graph = create_agent_graph(
        model=SlowModel(), tools=[], tool_timeout=0.2
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hi")], "user_id": 1},
        config={"configurable": {"thread_id": "timeout-test"}},
    )
    last = result["messages"][-1]
    assert "超时" in last.content


@pytest.mark.asyncio
async def test_tool_timeout_returns_error_message() -> None:
    @tool
    async def slow_tool(query: str, user_id: int) -> str:
        """A deliberately slow tool for timeout testing."""
        await asyncio.sleep(10)
        return "result"

    class ToolModel:
        async def ainvoke(self, messages: list[object]) -> AIMessage:
            from langchain_core.messages import SystemMessage
            if messages and any(
                isinstance(m, SystemMessage) and "意图识别器" in str(m.content)
                for m in messages
            ):
                return AIMessage(
                    content='{"category": "chat", "subtype": "other", "confidence": 1.0, "reason": "test"}'
                )
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "slow_tool",
                        "args": {"query": "x"},
                        "id": "call-1",
                    }
                ],
            )

        def bind_tools(self, tools: list[object]):
            return self

    graph = create_agent_graph(
        model=ToolModel(), tools=[slow_tool], tool_timeout=0.2
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="x")], "user_id": 1},
        config={"configurable": {"thread_id": "tool-timeout-test"}},
    )
    # 工具超时后 loop 无 tool_calls → 结束；最后的 AIMessage 是模型调用结果
    msgs = result["messages"]
    tool_msgs = [m for m in msgs if getattr(m, "name", None) == "slow_tool"]
    assert tool_msgs, "工具消息应存在"
    assert "超时" in tool_msgs[-1].content
