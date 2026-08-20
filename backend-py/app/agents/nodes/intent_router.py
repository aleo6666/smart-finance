"""混合意图识别：规则层（零 LLM）→ LLM 分层层 → 置信度阈值 + 反问。

三层设计（2026-08-20 用户方案落地）：
  ① 规则层：高置信关键词/金额+动词直接定意图，不调模型（快、免费、可测）
  ② LLM 层：仅规则未命中时调用一次，粗分(category) + 细分(subtype) + confidence
  ③ 置信度层：confidence < threshold 不硬猜，返回反问提示让用户澄清
  日志：每次识别输出结构化日志（text/method/intent/confidence/latency_ms），上线可查
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from app.core.llm import parse_json_object

logger = logging.getLogger(__name__)

# ---------------- 第一层：规则层 ----------------

# 高置信分析关键词（命中即 analysis，100% 确定才进此表）
ANALYSIS_KEYWORDS = (
    "财务状况", "财务怎么样", "财务体检", "体检", "健康评分", "健康分析",
    "负债率", "储蓄率", "流动性", "现金流", "支出结构", "支出构成", "占比",
    "趋势", "情景", "推演", "分析一下", "深度分析", "财务分析",
    "health", "ratio", "trend", "breakdown", "scenario", "analysis",
)

# 高置信记账动词（需与金额同现才算 record）
RECORD_VERBS = (
    "花了", "用了", "买了", "付了", "吃了", "喝了", "转了", "缴了", "充了",
    "支出", "消费", "记账", "记一笔", "收入", "收到", "工资", "赚了",
    "充值", "付款", "打车", "地铁", "外卖", "早餐", "午餐", "晚餐",
    "房租", "水电", "话费", "购物", "存了",
)
AMOUNT_RE = re.compile(r"\d+(?:\.\d+)?\s*(?:元|块|钱|rmb)?")

# 高置信查询动词（含"多少/几条/记录/账单/花了多少"类，100% 确定才进此表）
QUERY_KEYWORDS = (
    "花了多少", "用了多少", "记录", "账单", "明细", "查询", "查一下",
    "预算", "目标", "结余", "余额", "本月", "上月", "这个月", "上个月",
)

# 高置信闲聊词（100% 确定）
CHAT_KEYWORDS = (
    "你好", "您好", "谢谢", "再见", "拜拜", "你是谁", "你能做什么",
    "hello", "hi", "thanks",
)


def rule_route(text: str) -> str | None:
    """规则层：100% 确定才返回意图，否则返回 None 交给 LLM 层。

    Returns: "analysis" | "record" | "query" | "chat" | None
    """
    normalized = str(text).lower().strip()
    if not normalized:
        return "chat"

    # 1. 高置信分析
    if any(kw in normalized for kw in ANALYSIS_KEYWORDS):
        return "analysis"

    # 2. 记账：金额 + 动词（第一性约束：没金额不记账）
    if AMOUNT_RE.search(normalized) and any(v in normalized for v in RECORD_VERBS):
        return "record"

    # 3. 高置信查询
    if any(kw in normalized for kw in QUERY_KEYWORDS):
        return "query"

    # 4. 高置信闲聊
    if any(kw in normalized for kw in CHAT_KEYWORDS):
        return "chat"

    return None


# ---------------- 第二层：LLM 分层层 ----------------

INTENT_SYSTEM_PROMPT = (
    "你是意图识别器。判断用户消息的意图，只返回 JSON，不要 Markdown，不要多余文字。\n"
    '格式：{"category": "record|query|analysis|chat", "subtype": "细分", "confidence": 0.0-1.0, "reason": "一句话理由"}\n'
    "category 含义：\n"
    "- record: 记账（含金额的消费/收入，如「午餐25元」「工资到账8000」）\n"
    "- query: 查询（查账/预算/目标/余额，如「这个月花了多少」「预算还剩多少」）\n"
    "- analysis: 财务分析（健康/趋势/结构/推演，如「我财务状况怎么样」「现金流趋势」）\n"
    "- chat: 闲聊或其他（问候/感谢/无关话题）\n"
    "subtype 细分：\n"
    "- record: expense（支出）/ income（收入）\n"
    "- query: transactions（账单）/ budget（预算）/ goal（目标）/ balance（余额）\n"
    "- analysis: health（健康）/ trend（趋势）/ breakdown（结构）/ scenario（推演）\n"
    "- chat: greeting（问候）/ other（其他）\n"
    "confidence: 0-1 的确定程度；不确定（如意图模糊、多意图混合、信息不足）给低于 0.7 的值，不要硬猜。\n"
    "reason: 一句话说明判断依据。"
)

CONFIDENCE_THRESHOLD = 0.7

# ---------------- 第三层：反问 ----------------

CLARIFY_MESSAGE = (
    "我没太确定你想做什么 🤔 你是想：\n"
    "1️⃣ **记账**：例如「午餐花了25元」「交房租5000」\n"
    "2️⃣ **查账**：例如「这个月花了多少」「预算还剩多少」\n"
    "3️⃣ **财务分析**：例如「我的财务状况怎么样」「现金流趋势」\n"
    "回复数字或直接说需求都可以～"
)


async def llm_route(model: Any, text: str, tool_timeout: float = 30.0) -> dict[str, Any]:
    """LLM 层：一次调用，返回 {category, subtype, confidence, reason}。失败降级 chat。"""
    try:
        response = await asyncio.wait_for(
            model.ainvoke(
                [
                    SystemMessage(content=INTENT_SYSTEM_PROMPT),
                    HumanMessage(content=text),
                ]
            ),
            timeout=tool_timeout,
        )
        content = response.content if hasattr(response, "content") else str(response)
        parsed = parse_json_object(content) or {}
    except asyncio.TimeoutError:
        logger.warning("intent_router llm timeout after %ss", tool_timeout)
        parsed = {}
    except Exception as exc:
        logger.warning("intent_router llm failed: %s", exc)
        parsed = {}

    category = str(parsed.get("category", "chat"))
    if category not in ("record", "query", "analysis", "chat"):
        category = "chat"
    try:
        confidence = float(parsed.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    return {
        "category": category,
        "subtype": str(parsed.get("subtype", "")),
        "confidence": confidence,
        "reason": str(parsed.get("reason", "")),
    }


async def route_intent_hybrid(model: Any, text: str, tool_timeout: float = 30.0) -> dict[str, Any]:
    """混合意图识别入口：规则 → LLM → 置信度。

    Returns:
      {"intent": str, "subtype": str, "confidence": float, "method": "rule"|"llm",
       "clarify": bool, "latency_ms": int, "reason": str}
    """
    t0 = time.monotonic()

    # ① 规则层
    rule_intent = rule_route(text)
    if rule_intent is not None:
        latency_ms = int((time.monotonic() - t0) * 1000)
        logger.info(
            "intent_router method=rule text=%r intent=%s confidence=1.0 latency_ms=%d",
            text[:80], rule_intent, latency_ms,
        )
        return {
            "intent": rule_intent,
            "subtype": "",
            "confidence": 1.0,
            "method": "rule",
            "clarify": False,
            "latency_ms": latency_ms,
            "reason": "规则层命中",
        }

    # ② LLM 层
    llm_result = await llm_route(model, text, tool_timeout)
    latency_ms = int((time.monotonic() - t0) * 1000)

    # ③ 置信度阈值
    if llm_result["confidence"] < CONFIDENCE_THRESHOLD:
        logger.info(
            "intent_router method=llm text=%r intent=clarify confidence=%.2f latency_ms=%d reason=%r",
            text[:80], llm_result["confidence"], latency_ms, llm_result["reason"],
        )
        return {
            "intent": "chat",
            "subtype": "",
            "confidence": llm_result["confidence"],
            "method": "llm",
            "clarify": True,
            "latency_ms": latency_ms,
            "reason": llm_result["reason"],
        }

    logger.info(
        "intent_router method=llm text=%r intent=%s subtype=%s confidence=%.2f latency_ms=%d reason=%r",
        text[:80], llm_result["category"], llm_result["subtype"],
        llm_result["confidence"], latency_ms, llm_result["reason"],
    )
    return {
        "intent": llm_result["category"],
        "subtype": llm_result["subtype"],
        "confidence": llm_result["confidence"],
        "method": "llm",
        "clarify": False,
        "latency_ms": latency_ms,
        "reason": llm_result["reason"],
    }
