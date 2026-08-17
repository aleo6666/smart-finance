from typing import Any

from fastapi import APIRouter, Request
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import BaseModel, Field


router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    user_id: int = Field(gt=0)
    ledger_id: int | None = Field(default=None, gt=0)


class ChatResponse(BaseModel):
    reply: str
    tools: list[str]
    sources: list[dict[str, Any]]


@router.post("/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, request: Request) -> ChatResponse:
    result = await request.app.state.chat_agent.ainvoke(
        {
            "messages": [HumanMessage(content=payload.message)],
            "user_id": payload.user_id,
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
    return ChatResponse(
        reply=str(final_message.content),
        tools=result.get("used_tools", []),
        sources=result.get("dataset_refs", []),
    )

