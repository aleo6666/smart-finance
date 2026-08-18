"""Chat API（对齐旧 Node chat.js 契约）。

响应信封 ``{success: true, data: {message, source, ...}}``，``source`` 标记为
``"langgraph"`` 与旧系统一致；``user_id`` 从 Bearer token 解析，不再从 body 传。
"""

from typing import Any

from fastapi import APIRouter, Depends, Request
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import Settings, get_settings
from app.core.database import get_db
from app.core.llm import get_chat_model
from app.services.conversation_memory import (
    load_conversation_context,
    maybe_roll_summary,
    save_conversation_messages,
)

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    ledger_id: int | None = Field(default=None, gt=0)


@router.post("/chat")
async def chat(
    payload: ChatRequest,
    request: Request,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    # 1. 注入会话记忆上下文（L3 滚动摘要 + L1 滑动窗口历史），失败降级为空
    summary, history = await load_conversation_context(
        db, user_id, limit=settings.session_history_limit
    )
    messages: list[BaseMessage] = []
    if summary:
        messages.append(SystemMessage(content=summary))
    messages.extend(history)
    messages.append(HumanMessage(content=payload.message))

    # 2. 其余字段与现状一致，仅 messages 变为注入后的完整上下文
    result = await request.app.state.chat_agent.ainvoke(
        {
            "messages": messages,
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

    # 3. 落库 + 滚动摘要（容错，不阻塞响应；失败仅记日志）
    await save_conversation_messages(
        db,
        user_id,
        user_text=payload.message,
        assistant_text=str(final_message.content),
    )
    await maybe_roll_summary(
        db,
        user_id,
        get_chat_model(settings),
        threshold=settings.summary_threshold,
        max_history=settings.history_retention,
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
