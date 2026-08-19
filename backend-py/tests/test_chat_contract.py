"""Chat 协议兼容测试：响应信封对齐旧 chat.js，user_id 从 Bearer 解析。"""

from httpx import ASGITransport, AsyncClient
from langchain_core.messages import AIMessage

from app.api.deps import create_access_token
from app.main import create_app


class FakeAgent:
    def __init__(self) -> None:
        self.last_state: dict = {}

    async def ainvoke(self, state: dict, config: dict | None = None) -> dict:
        self.last_state = state
        return {
            "messages": [AIMessage(content="协议兼容测试回复")],
            "used_tools": ["search_knowledge_base"],
            "dataset_refs": [{"dataset_id": "x"}],
        }


def _client(agent: FakeAgent) -> AsyncClient:
    app = create_app(chat_agent=agent)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")


async def test_chat_requires_bearer_token() -> None:
    agent = FakeAgent()
    async with _client(agent) as client:
        response = await client.post("/api/chat", json={"message": "你好"})

    assert response.status_code == 401
    assert response.json()["success"] is False


async def test_chat_ignores_legacy_body_user_id() -> None:
    """旧客户端把 user_id 放 body——现在必须走 Bearer，body 里的被忽略。"""
    agent = FakeAgent()
    async with _client(agent) as client:
        response = await client.post(
            "/api/chat", json={"message": "你好", "user_id": 999}
        )

    assert response.status_code == 401


async def test_chat_returns_langgraph_envelope() -> None:
    agent = FakeAgent()
    token = create_access_token(7)
    async with _client(agent) as client:
        response = await client.post(
            "/api/chat",
            json={"message": "你好"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert "reply" not in body
    data = body["data"]
    assert data["message"] == "协议兼容测试回复"
    assert data["source"] == "langgraph"
    assert data["tools"] == ["search_knowledge_base"]
    assert data["sources"] == [{"dataset_id": "x"}]


async def test_chat_resolves_user_id_from_token_not_body() -> None:
    agent = FakeAgent()
    token = create_access_token(42)
    async with _client(agent) as client:
        response = await client.post(
            "/api/chat",
            json={"message": "你好", "user_id": 999},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert agent.last_state["user_id"] == 42
