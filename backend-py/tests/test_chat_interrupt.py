"""Chat API interrupt 集成测试：待确认提示 + resume 确认/取消。

覆盖：大额写触发 pending_confirm 提示；回复确认后落库；回复取消后不落库。
"""
from __future__ import annotations

from decimal import Decimal

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from langchain_core.messages import AIMessage
from langgraph.types import Interrupt

from app.api.deps import create_access_token
from app.main import create_app


class _InterruptAgent:
    """模拟 LangGraph 图的 interrupt 行为。"""

    def __init__(self) -> None:
        self.last_input: object = None

    async def ainvoke(self, state, config=None):
        self.last_input = state
        # 第一次调用（无 Command resume）→ 返回 interrupt
        if not hasattr(state, "resume") and isinstance(state, dict):
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
        # resume=True → 已确认
        if getattr(state, "resume", None) is True:
            return {
                "messages": [AIMessage(content="已确认记账：居住 5000.00 元")],
                "used_tools": ["create_record"],
                "dataset_refs": [{"record_id": 99}],
            }
        # resume=False → 已取消
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


@pytest.mark.asyncio
async def test_large_write_returns_pending_confirm_prompt(client_and_agent) -> None:
    client, token, _ = client_and_agent
    resp = await client.post(
        "/api/chat",
        json={"message": "交房租5000"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["pending_confirm"] is True
    assert "需人工确认" in data["message"]
    assert "金额 5000.00" in data["message"]


@pytest.mark.asyncio
async def test_confirm_word_resumes_with_true(client_and_agent) -> None:
    client, token, agent = client_and_agent
    # 先触发 interrupt
    await client.post(
        "/api/chat",
        json={"message": "交房租5000"},
        headers={"Authorization": f"Bearer {token}"},
    )
    # 回复"确认" → Command(resume=True)
    resp = await client.post(
        "/api/chat",
        json={"message": "确认"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["message"] == "已确认记账：居住 5000.00 元"


@pytest.mark.asyncio
async def test_cancel_word_resumes_with_false(client_and_agent) -> None:
    client, token, agent = client_and_agent
    await client.post(
        "/api/chat",
        json={"message": "交房租5000"},
        headers={"Authorization": f"Bearer {token}"},
    )
    resp = await client.post(
        "/api/chat",
        json={"message": "取消"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["message"] == "已取消该笔记账。"
