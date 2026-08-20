"""记账确定性 workflow 节点：LLM 单次提取 → 确定性确认策略 → 落库。

与通用 ReAct 循环不同，记账走固定路径：
  用户文本 → record_draft(LLM 提取结构化 JSON，无工具) → confirm_policy(确定性)
    ├─ 小额直通 → insert_record 落库 → "已记账：xx 元"
    └─ 大额/新类别/歧义 → interrupt 人工确认 → 确认后落库

全程 1 次 LLM 调用 + 确定性逻辑，目标 2-5 秒完成。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from decimal import Decimal
from typing import Any

from langchain_core.messages import AIMessage
from langchain_core.prompts import ChatPromptTemplate

from app.core.llm import parse_json_object

logger = logging.getLogger(__name__)

RECORD_DRAFT_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "你是记账解析器。把用户的记账语句解析为一条结构化记录，只返回 JSON，不要 Markdown，不要多余文字。\n"
            "JSON 格式：\n"
            '{"type": "expense" 或 "income", "category": "类别", "amount": 数字, "note": "备注", "occurred_at": "YYYY-MM-DD 或空"}\n'
            "规则：\n"
            "- type：支出默认 expense；收入（工资/奖金/红包/退款/兼职/收钱）为 income\n"
            "- category 从用户语义推断：餐饮/交通/日用品/娱乐/医疗/居住/购物/教育/转账/其他\n"
            "- amount 必须是正数数字，不要带货币符号\n"
            "- note 简短概括（如 午餐、房租、地铁）\n"
            "- occurred_at：用户给了日期才填（今天→今天日期），否则空字符串\n"
            "- 金额信息缺失或无法解析时返回 type=expense, category=其他, amount=0, note=空（amount=0 表示解析失败）\n",
        ),
        ("human", "{text}"),
    ]
)

_AMOUNT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:元|块|块钱|rmb)")


def _latest_user_text(messages: list[Any]) -> str:
    for message in reversed(messages):
        if message.__class__.__name__ == "HumanMessage":
            return str(message.content)
    return ""


def has_amount(text: str) -> bool:
    """记账语句必须含金额（第一性约束：没金额无法记账）。"""
    return bool(_AMOUNT_RE.search(text))


def create_record_draft_node(model: Any, tool_timeout: float = 30.0):
    """返回 record_draft 节点：LLM 单次提取结构化草稿（无工具，无 ReAct 循环）。"""

    async def record_draft(state: AgentState) -> dict[str, Any]:
        text = _latest_user_text(state.get("messages", []))
        from langchain_core.messages import HumanMessage, SystemMessage

        system = SystemMessage(
            content=(
                "你是记账解析器。把用户的记账语句解析为一条结构化记录，只返回 JSON，不要 Markdown，不要多余文字。\n"
                "JSON 格式：\n"
                '{"type": "expense" 或 "income", "category": "类别", "amount": 数字, "note": "备注", "occurred_at": "YYYY-MM-DD 或空"}\n'
                "规则：\n"
                "- type：支出默认 expense；收入（工资/奖金/红包/退款/兼职/收钱）为 income\n"
                "- category 从用户语义推断：餐饮/交通/日用品/娱乐/医疗/居住/购物/教育/转账/其他\n"
                "- amount 必须是正数数字，不要带货币符号\n"
                "- note 简短概括（如 午餐、房租、地铁）\n"
                "- occurred_at：用户给了日期才填（今天→今天日期），否则空字符串\n"
                "- 金额信息缺失或无法解析时返回 type=expense, category=其他, amount=0, note=空（amount=0 表示解析失败）\n"
            )
        )
        try:
            response = await asyncio.wait_for(
                model.ainvoke([system, HumanMessage(content=text)]),
                timeout=tool_timeout,
            )
            content = response.content if hasattr(response, "content") else str(response)
            parsed = parse_json_object(content) or {}
        except asyncio.TimeoutError:
            parsed = {}
        except Exception as exc:
            logger.warning("record_draft LLM failed: %s", exc)
            parsed = {}

        draft: dict[str, Any] = {
            "type": str(parsed.get("type", "expense")),
            "category": str(parsed.get("category", "其他")),
            "amount": _to_decimal(parsed.get("amount")),
            "note": str(parsed.get("note", "") or ""),
            "occurred_at": str(parsed.get("occurred_at", "") or ""),
        }
        # 解析失败（金额 0 或无金额）→ 提示用户补充
        if draft["amount"] <= 0:
            return {
                "messages": [
                    AIMessage(
                        content="我没听懂金额，请告诉我具体多少钱，例如「午餐花了 25 元」。"
                    )
                ],
                "record_draft": None,
            }
        return {"record_draft": draft, "pending_write": None}

    return record_draft


def _to_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value)).quantize(Decimal("0.01"))
    except Exception:
        return Decimal("0")
