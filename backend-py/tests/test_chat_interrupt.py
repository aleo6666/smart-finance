"""Chat API interrupt 集成测试：待确认提示 + resume 确认/取消。

覆盖：大额写触发 pending_confirm 提示；回复"确认/确定"后落库；回复"取消"后不落库；
无未决 interrupt 时确认词按普通消息处理（不误触 resume）。
"""
from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from langchain_core.messages import AIMessage
from langgraph.types import Interrupt

from app.api.deps import create_access_token
from app.main import create_app


class _InterruptAgent:
    """模拟 LangGraph 图的 interrupt 行为（含 aget_state，贴近真实 checkpointer）。"""

    def __init__(self) -> None:
        self.last_input: object = None
        self.pending = False

    async def aget_state(self, config=None):
        if self.pending:
            return SimpleNamespace(
                interrupts=[
                    Interrupt(
                        value={
                            "pending_write": {
                                "tool": "create_record",
                                "id": "c1",
                                "args": {},
                                "idempotency_key": "k1",
                                "reason": "金额 5000.00 达到确认阈值 200",
                            }
                        }
                    )
                ],
                next=("execute_record_workflow",),
            )
        return SimpleNamespace(interrupts=[], next=())

    async def ainvoke(self, state, config=None):
        self.last_input = state
        if isinstance(state, dict):  # 普通消息（无 Command resume）
            text = ""
            for m in state.get("messages", []):
                if m.__class__.__name__ == "HumanMessage":
                    text = str(m.content)
            # 含数字金额 → 触发一次大额确认；无金额 → 普通回复
            if text and any(ch.isdigit() for ch in text):
                self.pending = True
                return {
                    "messages": [AIMessage(content="")],
                    "used_tools": ["create_record"],
                    "dataset_refs": [],
                    "__interrupt__": [
                        Interrupt(
                            value={
                                "pending_write": {
                                    "tool": "create_record",
                                    "id": "c1",
                                    "args": {},
                                    "idempotency_key": "k1",
                                    "reason": "金额 5000.00 达到确认阈值 200",
                                }
                            }
                        )
                    ],
                }
            return {
                "messages": [AIMessage(content="普通回复")],
                "used_tools": [],
                "dataset_refs": [],
            }
        # resume=True → 已确认
        if getattr(state, "resume", None) is True:
            self.pending = False
            return {
                "messages": [AIMessage(content="已确认记账：居住 5000.00 元")],
                "used_tools": ["create_record"],
                "dataset_refs": [{"record_id": 99}],
            }
        # resume=False → 已取消
        self.pending = False
        return {
            "messages": [AIMessage(content="已取消该笔记账。")],
            "used_tools": [],
            "dataset_refs": [],
        }


@pytest_asyncio.fixture
async def client_and_agent():
    agent = _InterruptAgent()
    app = create_app(chat_agent=agent)
    token = create_access_token(7)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client, token, agent


async def _trigger_interrupt(client, token):
    return await client.post(
        "/api/chat",
        json={"message": "交房租5000"},
        headers={"Authorization": f"Bearer {token}"},
    )


@pytest.mark.asyncio
async def test_large_write_returns_pending_confirm_prompt(client_and_agent) -> None:
    client, token, _ = client_and_agent
    resp = await _trigger_interrupt(client, token)
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["pending_confirm"] is True
    assert "需人工确认" in data["message"]
    assert "金额 5000.00" in data["message"]


@pytest.mark.asyncio
async def test_confirm_word_resumes_with_true(client_and_agent) -> None:
    client, token, agent = client_and_agent
    await _trigger_interrupt(client, token)
    # 回复"确认" → Command(resume=True)
    resp = await client.post(
        "/api/chat",
        json={"message": "确认"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["message"] == "已确认记账：居住 5000.00 元"
    assert agent.last_input.resume is True


@pytest.mark.asyncio
async def test_queding_word_resumes_with_true(client_and_agent) -> None:
    """用户回复「确定」（高频口语）→ Command(resume=True)（2026-08-29 生产反馈）。"""
    client, token, agent = client_and_agent
    await _trigger_interrupt(client, token)
    resp = await client.post(
        "/api/chat",
        json={"message": "确定"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["message"] == "已确认记账：居住 5000.00 元"
    assert agent.last_input.resume is True


@pytest.mark.asyncio
async def test_cancel_word_resumes_with_false(client_and_agent) -> None:
    client, token, agent = client_and_agent
    await _trigger_interrupt(client, token)
    resp = await client.post(
        "/api/chat",
        json={"message": "取消"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["message"] == "已取消该笔记账。"
    assert agent.last_input.resume is False


@pytest.mark.asyncio
async def test_confirm_word_without_pending_is_plain_message(client_and_agent) -> None:
    """无未决 interrupt 时，确认词按普通消息处理，不触发 Command(resume)。"""
    client, token, agent = client_and_agent
    resp = await client.post(
        "/api/chat",
        json={"message": "确认"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["message"] == "普通回复"
    assert isinstance(agent.last_input, dict)  # 非 Command，未误触 resume


@pytest.mark.asyncio
async def test_topic_switch_cancels_pending_then_processes_new(client_and_agent) -> None:
    """有未决确认时转移话题：先取消旧确认，再正常处理新消息（防旧确认重放）。"""
    client, token, agent = client_and_agent
    await _trigger_interrupt(client, token)
    resp = await client.post(
        "/api/chat",
        json={"message": "今天吃什么"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["message"] == "普通回复"
    # 最后一次输入是 dict（新消息已进图），且期间发生过 cancel
    assert isinstance(agent.last_input, dict)
