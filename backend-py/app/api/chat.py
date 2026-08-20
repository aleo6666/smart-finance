"""Chat API（对齐旧 Node chat.js 契约）。

响应信封 ``{success: true, data: {message, source, ...}}``，``source`` 标记为
``"langgraph"`` 与旧系统一致；``user_id`` 从 Bearer token 解析，不再从 body 传。
"""

from typing import Any

from fastapi import APIRouter, Depends, Request
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langgraph.types import Command
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
    #    thread_id=user_id：为 interrupt 人工确认提供 checkpoint 上下文
    #    用户确认/取消上一笔待确认记账 → Command(resume=True/False) 恢复
    text = (payload.message or "").strip()
    resume_value: bool | None = None
    if any(kw in text for kw in ("确认", "确认记账", "继续", "同意", "好的", "可以")):
        resume_value = True
    elif any(kw in text for kw in ("取消", "放弃", "不用了", "不要", "不记")):
        resume_value = False

    invoke_input: dict[str, Any] | Command = {
        "messages": messages,
        "user_id": user_id,
        "ledger_id": payload.ledger_id,
        "retrieved_context": "",
        "dataset_refs": [],
        "used_tools": [],
        "iterations": 0,
    }
    if resume_value is not None:
        invoke_input = Command(resume=resume_value)
    else:
        # 非确认/取消词的新消息：若该 thread 有未决 interrupt（上一笔待确认记账），
        # 先自动取消旧确认（用户转移话题 = 放弃），再正常处理新消息，避免旧状态重放
        try:
            snapshot = await request.app.state.chat_agent.aget_state(
                config={"configurable": {"thread_id": str(user_id)}}
            )
            if snapshot is not None and (snapshot.interrupts or (snapshot.next and tuple(snapshot.next))):
                await request.app.state.chat_agent.ainvoke(
                    Command(resume=False),
                    config={"configurable": {"thread_id": str(user_id)}},
                )
        except Exception:
            # 状态检查失败不阻塞主流程
            pass
    result = await request.app.state.chat_agent.ainvoke(
        invoke_input,
        config={"configurable": {"thread_id": str(user_id)}},
    )
    # 写操作待人工确认（interrupt）：返回确认提示，不取空 AIMessage
    interrupts = result.get("__interrupt__")
    if interrupts:
        pending = None
        try:
            pending = interrupts[0].value.get("pending_write") if hasattr(interrupts[0], "value") else None
        except Exception:
            pending = None
        reason = (pending or {}).get("reason", "该操作需要人工确认")
        return {
            "success": True,
            "data": {
                "message": f"该记账需人工确认：{reason}。回复「确认」继续，回复「取消」放弃。",
                "source": "langgraph",
                "intent": result.get("intent", "chat"),
                "tools": result.get("used_tools", []),
                "sources": result.get("dataset_refs", []),
                "pending_confirm": True,
            },
        }

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
            "intent": result.get("intent", "chat"),
            "tools": result.get("used_tools", []),
            "sources": result.get("dataset_refs", []),
        },
    }
