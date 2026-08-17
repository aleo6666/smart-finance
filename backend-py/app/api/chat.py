"""Chat API（对齐旧 Node chat.js 契约）。

响应信封 ``{success: true, data: {message, source, ...}}``，``source`` 标记为
``"langgraph"`` 与旧系统一致；``user_id`` 从 Bearer token 解析，不再从 body 传。
"""

from typing import Any

from fastapi import APIRouter, Depends, Request
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import BaseModel, Field

from app.api.deps import get_current_user

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    ledger_id: int | None = Field(default=None, gt=0)


@router.post("/chat")
async def chat(
    payload: ChatRequest,
    request: Request,
    user_id: int = Depends(get_current_user),
) -> dict[str, Any]:
    result = await request.app.state.chat_agent.ainvoke(
        {
            "messages": [HumanMessage(content=payload.message)],
            "user_id": user_id,
            "ledger_id": payload.ledger_id,
            "retrieved_context": "",
            "dataset_refs": [],
            "used_tools": [],
            "iterations": 0,
        }
    )
    final_message = next(
        (
            message
            for message in reversed(result.get("messages", []))
            if isinstance(message, AIMessage)
        ),
        AIMessage(content="需要更精确的信息，请补充条件"),
    )
    return {
        "success": True,
        "data": {
            "message": str(final_message.content),
            "source": "langgraph",
            "intent": "chat",
            "tools": result.get("used_tools", []),
            "sources": result.get("dataset_refs", []),
        },
    }
