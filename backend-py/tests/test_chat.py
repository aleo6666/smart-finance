import json

from httpx import ASGITransport, AsyncClient
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool

from app.agents.graph import create_agent_graph
from app.api.deps import create_access_token
from app.main import create_app


class RoutingModel:
    def bind_tools(self, tools: list[object]):
        return self

    async def ainvoke(self, messages: list[object]) -> AIMessage:
        # 意图识别路由调用（intent_router LLM 层）：固定返回 chat 意图
        from langchain_core.messages import SystemMessage
        if messages and any(
            isinstance(m, SystemMessage) and "意图识别器" in str(m.content)
            for m in messages
        ):
            return AIMessage(
                content='{"category": "chat", "subtype": "other", "confidence": 1.0, "reason": "test"}'
            )
        tool_result = next(
            (message for message in reversed(messages) if isinstance(message, ToolMessage)),
            None,
        )
        if tool_result is not None:
            if tool_result.name == "query_transactions":
                return AIMessage(content="本月餐饮支出为 88.00 元。")
            return AIMessage(content="知识库暂无相关资料，无法给出有依据的答案。")

        question = next(
            message.content
            for message in reversed(messages)
            if isinstance(message, HumanMessage)
        )
        if "餐饮" in question:
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "query_transactions",
                        "args": {"user_id": 999},
                        "id": "sql-call",
                        "type": "tool_call",
                    }
                ],
            )
        return AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "search_knowledge_base",
                    "args": {"query": question, "user_id": 999},
                    "id": "kb-call",
                    "type": "tool_call",
                }
            ],
        )


@tool
async def query_transactions(user_id: int) -> str:
    """Query transaction totals."""
    assert user_id == 7
    return json.dumps({"count": 1, "total_amount": "88.00"})


@tool
async def search_knowledge_base(query: str, user_id: int) -> str:
    """Search financial knowledge."""
    assert user_id == 7
    return json.dumps({"context": "", "dataset_refs": []})


async def post_chat(message: str) -> dict[str, object]:
    agent = create_agent_graph(
        model=RoutingModel(), tools=[query_transactions, search_knowledge_base]
    )
    app = create_app(chat_agent=agent)
    token = create_access_token(7)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/api/chat",
            json={"message": message},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert response.status_code == 200
    return response.json()


async def test_chat_sql_question_reports_tool_and_answer() -> None:
    result = await post_chat("我这个月餐饮花了多少")

    assert result == {
        "success": True,
        "data": {
            "message": "本月餐饮支出为 88.00 元。",
            "source": "langgraph",
            "intent": "query",
            "tools": ["query_transactions"],
            "sources": [],
        },
    }


async def test_chat_knowledge_question_degrades_without_fabrication() -> None:
    result = await post_chat("什么是紧急备用金")

    assert result == {
        "success": True,
        "data": {
            "message": "知识库暂无相关资料，无法给出有依据的答案。",
            "source": "langgraph",
            "intent": "chat",
            "tools": ["search_knowledge_base"],
            "sources": [],
        },
    }
