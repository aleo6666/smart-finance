"""混合意图识别测试：规则层零 LLM / LLM 层 / 置信度反问 / 日志。

覆盖：
- 规则层：高置信语句直接命中，不调 LLM（fake 模型断言 0 次调用）
- LLM 层：规则未命中时调用，粗分+细分+置信度
- 置信度阈值：低置信 → clarify=True（反问）
- 图级：clarify 路由到 END 并返回反问消息
"""
from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from app.agents.graph import create_agent_graph
from app.agents.nodes.intent_router import (
    CLARIFY_MESSAGE,
    CONFIDENCE_THRESHOLD,
    rule_route,
    route_intent_hybrid,
)
from app.agents.tools.create_record import create_create_record_tool
from app.agents.nodes.confirm_policy import confirm_required


class _CountingLLM:
    """记录调用次数，按配置返回意图 JSON。"""

    def __init__(self, intent_json: str) -> None:
        self.intent_json = intent_json
        self.calls = 0
        self.last_messages: list = []

    def bind_tools(self, tools: list[object]):
        return self

    async def ainvoke(self, messages: list[object]) -> AIMessage:
        self.calls += 1
        self.last_messages = messages
        return AIMessage(content=self.intent_json)


# ---------------- 规则层（零 LLM） ----------------

def test_rule_route_high_confidence_analysis() -> None:
    assert rule_route("我的财务状况怎么样") == "analysis"
    assert rule_route("分析一下负债率") == "analysis"
    assert rule_route("现金流趋势怎么样") == "analysis"


def test_rule_route_record_requires_amount_and_verb() -> None:
    assert rule_route("今天午餐花了25元") == "record"
    assert rule_route("交房租5000") == "record"
    assert rule_route("工资到账8000元") == "record"
    # 没金额不记账
    assert rule_route("我吃了个午餐") is None
    # 有金额无动词 → 不确定，交给 LLM
    assert rule_route("25块钱") is None


def test_rule_route_query_and_chat() -> None:
    assert rule_route("这个月花了多少") == "query"
    assert rule_route("预算还剩多少") == "query"
    assert rule_route("你好") == "chat"
    assert rule_route("谢谢") == "chat"
    # 模糊语句 → None（交给 LLM）
    assert rule_route("帮我看看") is None


# ---------------- 混合入口（规则优先，LLM 兜底） ----------------

@pytest.mark.asyncio
async def test_hybrid_rule_hit_does_not_call_llm() -> None:
    llm = _CountingLLM('{"category": "chat", "subtype": "other", "confidence": 1.0, "reason": "x"}')
    result = await route_intent_hybrid(llm, "今天午餐花了25元", tool_timeout=5)
    assert result["intent"] == "record"
    assert result["method"] == "rule"
    assert result["confidence"] == 1.0
    assert result["clarify"] is False
    assert llm.calls == 0, "规则命中不应调用 LLM"


@pytest.mark.asyncio
async def test_hybrid_llm_fallback_when_rule_uncertain() -> None:
    llm = _CountingLLM(
        '{"category": "query", "subtype": "transactions", "confidence": 0.9, "reason": "查询账单"}'
    )
    # "帮我看看" 无任何高置信关键词 → 规则层 None → LLM 层
    result = await route_intent_hybrid(llm, "帮我看看", tool_timeout=5)
    assert result["intent"] == "query"
    assert result["subtype"] == "transactions"
    assert result["method"] == "llm"
    assert result["clarify"] is False
    assert llm.calls == 1, "规则未命中应调用 1 次 LLM"


@pytest.mark.asyncio
async def test_hybrid_low_confidence_triggers_clarify() -> None:
    llm = _CountingLLM(
        '{"category": "chat", "subtype": "other", "confidence": 0.4, "reason": "意图模糊"}'
    )
    result = await route_intent_hybrid(llm, "那个东西怎么样了", tool_timeout=5)
    assert result["clarify"] is True, "低置信应触发反问"
    assert result["confidence"] == 0.4
    assert result["confidence"] < CONFIDENCE_THRESHOLD


@pytest.mark.asyncio
async def test_hybrid_llm_failure_degrades_to_chat() -> None:
    class _BrokenLLM:
        def bind_tools(self, tools):
            return self

        async def ainvoke(self, messages):
            raise RuntimeError("model down")

    result = await route_intent_hybrid(_BrokenLLM(), "随便聊聊", tool_timeout=5)
    assert result["intent"] == "chat"
    assert result["method"] == "llm"


# ---------------- 图级：clarify 路由到 END ----------------

@pytest.mark.asyncio
async def test_graph_clarify_returns_message_and_ends() -> None:
    llm = _CountingLLM(
        '{"category": "chat", "subtype": "other", "confidence": 0.3, "reason": "模糊"}'
    )
    graph = create_agent_graph(
        model=llm,
        tools=[create_create_record_tool(_FakeFactory(), _FakeSettings())],
        tool_timeout=5,
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="那个东西怎么样了")], "user_id": 7},
        config={"configurable": {"thread_id": "clarify-e2e"}},
    )
    # 低置信 → 反问消息，不进入任何执行路径
    assert result["intent_clarify"] is True
    assert CLARIFY_MESSAGE in result["messages"][-1].content
    assert result.get("__interrupt__") is None
    assert not result.get("used_tools"), "clarify 不应触发工具调用"


class _FakeFactory:
    def __call__(self):
        raise NotImplementedError("不应实际打开 DB session")


class _FakeSettings:
    record_confirm_threshold = 200
    confirm_fast_categories = ["餐饮", "交通", "日用品", "娱乐", "医疗"]
    confirm_ambiguous_words = ["报销", "分期", "借款", "预付", "押金"]
