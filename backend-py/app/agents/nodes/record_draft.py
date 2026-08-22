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
from datetime import date, timedelta
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

_AMOUNT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:元|块|块钱|rmb|钱)?", re.IGNORECASE)

# ============ 确定性规则提取（零 LLM，2026-08-22 加速记账） ============

# 收入信号词（命中 → type=income）
_INCOME_KEYWORDS = (
    "工资", "奖金", "红包", "退款", "兼职", "收钱", "赚了", "报销",
    "收到", "进账", "薪水", "入账", "到账",
)

# 类别词表（按优先级排序，命中即归类）
_CATEGORY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("餐饮", ("早餐", "午餐", "晚餐", "午饭", "晚饭", "吃饭", "外卖", "奶茶", "咖啡",
              "夜宵", "食堂", "火锅", "烧烤", "零食", "水果", "买菜", "聚餐", "请客")),
    ("交通", ("地铁", "公交", "打车", "滴滴", "出租车", "高铁", "火车", "机票",
              "加油", "停车", "共享单车", "车费", "充电桩")),
    ("居住", ("房租", "水电", "物业", "房贷", "燃气", "水费", "电费", "话费",
              "宽带", "网费", "燃气费", "供暖")),
    ("日用品", ("超市", "日用品", "纸巾", "洗衣液", "洗发水", "牙膏", "日杂")),
    ("购物", ("衣服", "鞋", "裤子", "淘宝", "京东", "拼多多", "购物", "包包",
              "化妆品", "数码", "手机", "家电")),
    ("医疗", ("医院", "药", "看病", "挂号", "体检", "诊所", "药店")),
    ("娱乐", ("电影", "游戏", "ktv", "k歌", "演唱会", "门票", "娱乐", "网吧", "旅游")),
    ("教育", ("书", "课程", "学费", "培训", "报班", "文具", "教材")),
    ("转账", ("转账", "借出", "借给", "还钱", "还款", "礼金", "随礼", "红包给")),
]

# 记账动词（note 清理用）
_NOTE_STRIP_VERBS = (
    "花了", "用了", "买了", "付了", "吃了", "喝了", "缴了", "充了", "转了",
    "支出", "消费", "记账", "记一笔", "收入", "收到", "赚了", "到账",
)


def rule_extract_record(text: str) -> dict[str, Any] | None:
    """确定性记账提取：金额 RE + 收入词 + 类别词表，零 LLM。

    成功返回 draft（type/category/amount/note/occurred_at），
    失败返回 None → 调用方降级 LLM 提取。
    保守门槛：多金额（多笔）→ None；金额缺失 → None；无语义词 → None。
    """
    normalized = str(text).strip()
    if not normalized:
        return None

    # 金额：只接受单个金额（多金额 = 多笔拆分场景，交给 LLM）
    matches = list(_AMOUNT_RE.finditer(normalized))
    amounts = [Decimal(m.group(1)) for m in matches if m.group(1)]
    if len(amounts) != 1 or amounts[0] <= 0:
        return None
    amount = amounts[0].quantize(Decimal("0.01"))

    # 收入/支出
    is_income = any(kw in normalized for kw in _INCOME_KEYWORDS)

    # 类别
    category = "其他"
    for cat, keywords in _CATEGORY_KEYWORDS:
        if any(kw in normalized for kw in keywords):
            category = cat
            break

    # note：去金额 + 去记账动词 + 清理标点
    note = _AMOUNT_RE.sub("", normalized)
    for verb in _NOTE_STRIP_VERBS:
        note = note.replace(verb, "")
    note = note.strip(" ，,。.!！?？:：")

    # 保守门槛：类别未命中且 note 无实质内容 → 不硬猜，交给 LLM
    if category == "其他" and len(note) < 2:
        return None

    # 时间：今天/昨天/前天
    occurred_at = ""
    if "昨天" in normalized:
        occurred_at = (date.today() - timedelta(days=1)).isoformat()
    elif "前天" in normalized:
        occurred_at = (date.today() - timedelta(days=2)).isoformat()
    elif "今天" in normalized:
        occurred_at = date.today().isoformat()

    return {
        "type": "expense" if not is_income else "income",
        "category": category,
        "amount": amount,
        "note": note,
        "occurred_at": occurred_at,
    }


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

        # ① 确定性规则提取（零 LLM）：常见记账语句（午餐25元/地铁3块/工资8000）直通
        rule_draft = rule_extract_record(text)
        if rule_draft is not None:
            logger.info("record_draft method=rule text=%s draft=%s", text, rule_draft)
            return {"record_draft": rule_draft, "pending_write": None}

        # ② 降级 LLM 提取（多笔/歧义/新类别）
        logger.info("record_draft method=llm text=%s", text)

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
