#!/usr/bin/env python3
"""Smart Finance value-proof benchmark.

Measures four things that can be quoted in interviews:
  1. rule-layer coverage/accuracy on messy Chinese bookkeeping input
  2. deterministic safety gates (confirmation / evidence chain / user scope)
  3. bare LLM vs deterministic-tool-augmented LLM on the same ledger
  4. the existing pytest suite

Run:
  APP_ENV=test DATABASE_URL="sqlite+aiosqlite:///:memory:" \
  .venv-bench/Scripts/python.exe scripts/value_proof.py

Outputs:
  docs/eval/value_proof_<date>.json
  docs/eval/value_proof_<date>.md
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("JWT_SECRET", "test-only-jwt-secret-with-32-characters")

# Make `app` importable when the script is launched from scripts/.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agents.graph import _validate_calls
from app.agents.nodes.analyst_loop import FALLBACK_ANALYSIS, validate_analysis_against_refs
from app.agents.nodes.confirm_policy import confirm_required
from app.agents.nodes.intent_router import rule_route, route_intent_hybrid
from app.agents.nodes.record_draft import RECORD_LLM_SYSTEM, rule_extract_record
from app.agents.tools.analysis_tools import (
    compute_cashflow_trend,
    compute_expense_breakdown,
    compute_ratio_analysis,
    compute_scenario,
)
from app.agents.tools.create_record import compute_idempotency_key, insert_record
from app.agents.tools.query_transactions import create_query_transactions_tool
from app.core.llm import LiteLLMChatModel, parse_json_object
from app.models import Base, Ledger, Transaction, User

MONEY = Decimal("0.01")
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT_DIR = ROOT / "docs" / "eval"
TODAY = date.today().isoformat()


def money(value) -> Decimal:
    return Decimal(str(value)).quantize(MONEY)


def ok_money(left, right) -> bool:
    return money(left) == money(right)


def pct(correct: int, total: int) -> float:
    return round(correct / total * 100, 1) if total else 0.0


# ---------------------------------------------------------------------------
# 1. record extraction corpus
# ---------------------------------------------------------------------------

RECORD_CASES = [
    # common, single amount, clear category
    ("午餐25元", "common", {"type": "expense", "category": "餐饮", "amount": "25.00"}),
    ("早餐花了8块", "common", {"type": "expense", "category": "餐饮", "amount": "8.00"}),
    ("地铁3元", "common", {"type": "expense", "category": "交通", "amount": "3.00"}),
    ("打车38", "common", {"type": "expense", "category": "交通", "amount": "38.00"}),
    ("房租5000", "common", {"type": "expense", "category": "居住", "amount": "5000.00"}),
    ("超市买纸巾36.5", "common", {"type": "expense", "category": "日用品", "amount": "36.50"}),
    ("电影票45元", "common", {"type": "expense", "category": "娱乐", "amount": "45.00"}),
    ("药店买药28", "common", {"type": "expense", "category": "医疗", "amount": "28.00"}),
    ("买书59元", "common", {"type": "expense", "category": "教育", "amount": "59.00"}),
    ("奶茶18", "common", {"type": "expense", "category": "餐饮", "amount": "18.00"}),
    ("水费120", "common", {"type": "expense", "category": "居住", "amount": "120.00"}),
    ("话费50", "common", {"type": "expense", "category": "居住", "amount": "50.00"}),
    ("淘宝买衣服299", "common", {"type": "expense", "category": "购物", "amount": "299.00"}),
    ("工资到账12000", "common", {"type": "income", "category": "其他", "amount": "12000.00", "score_category": False}),
    ("收到红包200", "common", {"type": "income", "category": "其他", "amount": "200.00", "score_category": False}),
    # long tail: brand names, split bills, multi-amount
    ("昨天和朋友吃饭人均80，两个人", "hard", {"type": "expense", "category": "餐饮", "amount": "160.00"}),
    ("AA 制，我付了 240，三个人", "hard", {"type": "expense", "category": "餐饮", "amount": "80.00"}),
    ("星巴克 32", "hard", {"type": "expense", "category": "餐饮", "amount": "32.00"}),
    ("盒马 168.5", "hard", {"type": "expense", "category": "日用品", "amount": "168.50"}),
    ("给老婆转了5200", "hard", {"type": "expense", "category": "转账", "amount": "5200.00"}),
    ("充了100块饭卡", "hard", {"type": "expense", "category": "餐饮", "amount": "100.00"}),
    ("公司报销打车费120", "ambiguous", {"type": "expense", "category": "交通", "amount": "120.00"}),
    ("买了个iPhone 6999，分12期", "hard", {"type": "expense", "category": "购物", "amount": "6999.00"}),
    ("上周五请客户吃饭花了860，回头报销", "ambiguous", {"type": "expense", "category": "餐饮", "amount": "860.00"}),
]


def needs_llm(text: str, draft: dict | None) -> bool:
    """Proposed confidence gate: rule draft is only accepted when unambiguous."""
    if draft is None:
        return True
    if draft.get("type") == "expense" and draft.get("category") == "其他":
        return True
    if any(word in text for word in ("人均", "AA", "各付", "分摊", "一共", "总共", "每")):
        return True
    return False


async def llm_record_draft(model, text: str) -> dict:
    response = await model.ainvoke(
        [SystemMessage(content=RECORD_LLM_SYSTEM), HumanMessage(content=text)]
    )
    data = parse_json_object(getattr(response, "content", response)) or {}
    return {
        "type": str(data.get("type", "expense")),
        "category": str(data.get("category", "其他")),
        "amount": money(data.get("amount", 0) or 0),
    }


def score_record(draft: dict | None, expected: dict) -> dict:
    if draft is None:
        return {"abstained": True, "correct": False, "type_ok": False, "category_ok": False, "amount_ok": False}
    type_ok = draft.get("type") == expected["type"]
    category_ok = (not expected.get("score_category", True)) or draft.get("category") == expected["category"]
    amount_ok = ok_money(draft.get("amount", 0), expected["amount"])
    return {
        "abstained": False,
        "correct": type_ok and category_ok and amount_ok,
        "type_ok": type_ok,
        "category_ok": category_ok,
        "amount_ok": amount_ok,
    }


async def eval_records(model) -> dict:
    rows = []
    for text, subset, expected in RECORD_CASES:
        start = time.perf_counter()
        draft = rule_extract_record(text)
        latency = (time.perf_counter() - start) * 1000
        result = score_record(draft, expected)
        rows.append(
            {
                "text": text,
                "subset": subset,
                "expected": expected,
                "rule": {**(draft or {}), "amount": str(draft["amount"]) if draft else None},
                **result,
                "rule_latency_ms": round(latency, 4),
                "escalate": needs_llm(text, draft),
            }
        )

    hybrid_rows = []
    llm_calls = 0
    for row in rows:
        if not row["escalate"]:
            hybrid_rows.append({**row, "used": "rule", "hybrid_correct": row["correct"]})
            continue
        start = time.perf_counter()
        try:
            draft = await llm_record_draft(model, row["text"])
            hybrid = score_record(draft, row["expected"])
            latency = (time.perf_counter() - start) * 1000
            llm_calls += 1
            hybrid_rows.append(
                {
                    **row,
                    "used": "llm",
                    "llm": {**draft, "amount": str(draft["amount"])},
                    "hybrid_correct": hybrid["correct"],
                    "hybrid_type_ok": hybrid["type_ok"],
                    "hybrid_category_ok": hybrid["category_ok"],
                    "hybrid_amount_ok": hybrid["amount_ok"],
                    "llm_latency_ms": round(latency, 1),
                }
            )
        except Exception as exc:
            hybrid_rows.append({**row, "used": "llm", "hybrid_correct": False, "error": str(exc)})

    def agg(items, key="correct"):
        return {
            "total": len(items),
            "correct": sum(1 for item in items if item[key]),
            "accuracy_pct": pct(sum(1 for item in items if item[key]), len(items)),
        }

    scored_rows = [row for row in rows if row["subset"] != "ambiguous"]
    scored_hybrid = [row for row in hybrid_rows if row["subset"] != "ambiguous"]
    return {
        "cases": rows,
        "rule_common": agg([row for row in rows if row["subset"] == "common"]),
        "rule_hard": agg([row for row in rows if row["subset"] == "hard"]),
        "rule_all": agg(scored_rows),
        "hybrid_all": agg(scored_hybrid, "hybrid_correct"),
        "hybrid_common": agg([row for row in hybrid_rows if row["subset"] == "common"], "hybrid_correct"),
        "hybrid_hard": agg([row for row in hybrid_rows if row["subset"] == "hard"], "hybrid_correct"),
        "ambiguous_count": len(rows) - len(scored_rows),
        "llm_calls": llm_calls,
        "escalation_pct": pct(llm_calls, len(scored_rows)),
        "hybrid_rows": hybrid_rows,
    }


# ---------------------------------------------------------------------------
# 2. intent routing corpus
# ---------------------------------------------------------------------------

INTENT_CASES = [
    ("午餐25", "record"),
    ("打车38", "record"),
    ("工资到账12000", "record"),
    ("买菜花了56", "record"),
    ("交房租5000", "record"),
    ("奶茶18块", "record"),
    ("超市消费120", "record"),
    ("收到红包200", "record"),
    ("这个月花了多少", "query"),
    ("预算还剩多少", "query"),
    ("上个月餐饮明细", "query"),
    ("查一下上周的账单", "query"),
    ("我这个月交通花了多少", "query"),
    ("还能花多少钱", "query"),
    ("最近三个月的记录", "query"),
    ("余额还有多少", "query"),
    ("我的财务状况怎么样", "analysis"),
    ("现金流趋势", "analysis"),
    ("支出结构分析", "analysis"),
    ("我最近花钱有点多", "analysis"),
    ("帮我看看负债率", "analysis"),
    ("储蓄率怎么样", "analysis"),
    ("如果每月多存500会怎样", "analysis"),
    ("财务体检", "analysis"),
    ("你好", "chat"),
    ("你是谁", "chat"),
    ("谢谢", "chat"),
    ("今天天气不错", "chat"),
    ("讲个笑话", "chat"),
    ("我有点焦虑", "chat"),
    ("你能做什么", "chat"),
    ("在吗", "chat"),
]


async def eval_intent(model) -> dict:
    rows = []
    for text, expected in INTENT_CASES:
        rule = rule_route(text)
        start = time.perf_counter()
        hybrid = await route_intent_hybrid(model, text, tool_timeout=30)
        latency = (time.perf_counter() - start) * 1000
        rows.append(
            {
                "text": text,
                "expected": expected,
                "rule": rule,
                "rule_hit": rule is not None,
                "rule_correct": rule == expected,
                "hybrid": hybrid.get("intent"),
                "hybrid_method": hybrid.get("method"),
                "hybrid_correct": hybrid.get("intent") == expected,
                "hybrid_confidence": hybrid.get("confidence"),
                "hybrid_latency_ms": round(latency, 1),
            }
        )

    rule_hits = [row for row in rows if row["rule_hit"]]
    return {
        "cases": rows,
        "total": len(rows),
        "rule_hit_count": len(rule_hits),
        "rule_hit_pct": pct(len(rule_hits), len(rows)),
        "rule_accuracy_pct": pct(sum(1 for row in rule_hits if row["rule_correct"]), len(rule_hits)),
        "hybrid_accuracy_pct": pct(sum(1 for row in rows if row["hybrid_correct"]), len(rows)),
        "llm_calls": sum(1 for row in rows if row["hybrid_method"] != "rule"),
        "errors": [row for row in rows if not row["hybrid_correct"]],
    }


# ---------------------------------------------------------------------------
# 3. confirmation policy
# ---------------------------------------------------------------------------

CONFIRM_CASES = [
    ({"amount": "250", "category": "餐饮", "note": "午餐"}, True, "金额>=200"),
    ({"amount": "25", "category": "餐饮", "note": "午餐"}, False, "小额白名单"),
    ({"amount": "25", "category": "购物", "note": "衣服"}, True, "类别不在白名单"),
    ({"amount": "25", "category": "餐饮", "note": "报销"}, True, "歧义词"),
    ({"amount": "120", "category": "交通", "note": "报销"}, True, "真实语料：公司报销打车费"),
    ({"amount": "860", "category": "餐饮", "note": "报销"}, True, "真实语料：请客户吃饭回头报销"),
    ({"amount": "25", "category": "餐饮", "note": "午餐", "is_first": True}, True, "首次类别"),
    ({"amount": "199.99", "category": "餐饮", "note": "午餐"}, False, "阈值以下"),
    ({"amount": "200", "category": "餐饮", "note": "午餐"}, True, "阈值等于"),
    ({"amount": "25", "category": "交通", "note": "地铁"}, False, "白名单"),
    ({"amount": "25", "category": "娱乐", "note": "电影"}, False, "白名单"),
    ({"amount": "25", "category": "医疗", "note": "药"}, False, "白名单"),
    ({"amount": "25", "category": "居住", "note": "水费"}, True, "不在白名单"),
    ({"amount": "25", "category": "教育", "note": "书"}, True, "不在白名单"),
    ({"amount": "25", "category": "餐饮", "note": "分期"}, True, "歧义词"),
    ({"amount": "25", "category": "餐饮", "note": "借款"}, True, "歧义词"),
    ({"amount": "25", "category": "餐饮", "note": "押金"}, True, "歧义词"),
    ({"amount": "25", "category": "餐饮", "note": "预付"}, True, "歧义词"),
    ({"amount": "25", "category": "餐饮", "note": "请客"}, False, "无歧义"),
    ({"amount": "25", "category": "餐饮", "note": "夜宵"}, False, "白名单"),
]


def eval_confirm() -> dict:
    settings = SimpleNamespace(
        record_confirm_threshold=Decimal("200"),
        confirm_fast_categories=["餐饮", "交通", "日用品", "娱乐", "医疗"],
        confirm_ambiguous_words=["报销", "分期", "借款", "预付", "押金"],
    )
    rows = []
    for draft, expected, reason in CONFIRM_CASES:
        is_first = bool(draft.get("is_first"))
        draft = {k: v for k, v in draft.items() if k != "is_first"}
        result = confirm_required(draft, settings, is_first_category=is_first)
        rows.append(
            {
                "draft": draft,
                "expected": expected,
                "actual": result["confirm_required"],
                "reason": result["reason"],
                "expected_reason": reason,
                "correct": result["confirm_required"] == expected,
            }
        )
    return {
        "cases": rows,
        "total": len(rows),
        "correct": sum(1 for row in rows if row["correct"]),
        "accuracy_pct": pct(sum(1 for row in rows if row["correct"]), len(rows)),
    }


# ---------------------------------------------------------------------------
# 4. evidence-chain validator
# ---------------------------------------------------------------------------

REFS = [
    {
        "month": "2026-08",
        "income": 13000.0,
        "expense": 6700.0,
        "balance": 6300.0,
        "count": 4,
        "categories": [
            {"category": "居住", "amount": 5000.0, "share_percent": "74.63%"},
            {"category": "餐饮", "amount": 1000.0, "share_percent": "14.93%"},
            {"category": "交通", "amount": 400.0, "share_percent": "5.97%"},
            {"category": "医疗", "amount": 300.0, "share_percent": "4.48%"},
        ],
    }
]

EVIDENCE_CASES = [
    ("8月总支出 6700.00 元，结余 6300.00 元。", True, "grounded"),
    ("餐饮占支出 14.93%。", True, "grounded"),
    ("8月收入 13000.00 元，支出 6700.00 元，结余 6300.00 元。", True, "grounded"),
    ("8月共 4 笔支出。", True, "grounded"),
    ("8月总支出 9999.00 元。", False, "fabricated"),
    ("餐饮占比 48.62%。", False, "fabricated"),
    ("交通支出 500.00 元。", False, "fabricated"),
    ("8月共 9 笔支出。", False, "fabricated"),
    ("8月总支出 6700.00 元，比上月多 999.99 元。", True, "mixed-fabricated"),
    ("建议每月存 3000 元。", False, "advice-number"),
]


def eval_evidence() -> dict:
    rows = []
    for text, should_keep, kind in EVIDENCE_CASES:
        result = validate_analysis_against_refs(text, REFS)
        kept = result != FALLBACK_ANALYSIS and bool(result.strip())
        if kind == "mixed-fabricated":
            # 子句级过滤：真实数字所在分句保留，编造数字所在分句删除。
            removed = "999.99" not in result
            correct = kept and removed and "6700.00" in result
        else:
            removed = not kept
            correct = kept == should_keep
        rows.append(
            {
                "text": text,
                "kind": kind,
                "expected_keep": should_keep,
                "kept": kept,
                "fabricated_removed": removed,
                "result": result,
                "correct": correct,
            }
        )
    fabricated = [row for row in rows if row["kind"] in ("fabricated", "mixed-fabricated", "advice-number")]
    grounded = [row for row in rows if row["kind"] == "grounded"]
    return {
        "cases": rows,
        "grounded_kept_pct": pct(sum(1 for row in grounded if row["kept"]), len(grounded)),
        "fabricated_removed_pct": pct(sum(1 for row in fabricated if row["fabricated_removed"]), len(fabricated)),
        "overall_accuracy_pct": pct(sum(1 for row in rows if row["correct"]), len(rows)),
        "mixed_sentence_note": "已改子句级过滤：真实分句保留，编造分句删除，不再整句回退。",
    }


# ---------------------------------------------------------------------------
# 5. graph-level validation
# ---------------------------------------------------------------------------

@tool
async def safe_lookup(user_id: int, query: str) -> str:
    """A safe lookup tool."""
    return "ok"


@tool
async def no_user_tool(query: str) -> str:
    """A tool without user_id scope."""
    return "bad"


def eval_graph() -> dict:
    tools = {tool_obj.name: tool_obj for tool_obj in (safe_lookup, no_user_tool)}
    cases = [
        ("user_id spoof", [{"name": "safe_lookup", "args": {"user_id": 999, "query": "x"}, "id": "1"}], "args_user_id", 7),
        ("unknown tool", [{"name": "drop_table", "args": {}, "id": "2"}], "error", "非法工具"),
        ("missing user_id schema", [{"name": "no_user_tool", "args": {"query": "x"}, "id": "3"}], "error", "缺少 user_id"),
        ("bad args object", [{"name": "safe_lookup", "args": ["not", "a", "dict"], "id": "4"}], "error", "JSON 对象"),
        ("valid call", [{"name": "safe_lookup", "args": {"user_id": 1, "query": "x"}, "id": "5"}], "args_user_id", 7),
    ]
    rows = []
    for name, calls, field, expected in cases:
        result = _validate_calls(calls, tools, user_id=7)
        item = result[0]
        if field == "args_user_id":
            actual = item["args"].get("user_id")
            correct = actual == expected
        else:
            actual = item.get("error") or ""
            correct = expected in actual
        rows.append({"case": name, "expected": expected, "actual": actual, "correct": correct})
    return {
        "cases": rows,
        "total": len(rows),
        "correct": sum(1 for row in rows if row["correct"]),
        "accuracy_pct": pct(sum(1 for row in rows if row["correct"]), len(rows)),
    }


# ---------------------------------------------------------------------------
# 6. DB isolation + idempotency
# ---------------------------------------------------------------------------

async def eval_db() -> dict:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with sessions() as session:
        session.add_all(
            [
                User(id=1, email="u1@example.com", password_hash="h"),
                User(id=2, email="u2@example.com", password_hash="h"),
                Ledger(id=1, user_id=1, name="u1"),
                Ledger(id=2, user_id=2, name="u2"),
                Transaction(user_id=1, ledger_id=1, type="expense", category="餐饮", amount=Decimal("100.00"), occurred_at=datetime(2026, 8, 1)),
                Transaction(user_id=1, ledger_id=1, type="expense", category="交通", amount=Decimal("50.00"), occurred_at=datetime(2026, 8, 2)),
                Transaction(user_id=2, ledger_id=2, type="expense", category="餐饮", amount=Decimal("999.00"), occurred_at=datetime(2026, 8, 3)),
            ]
        )
        await session.commit()

    query_tool = create_query_transactions_tool(sessions)
    u1 = json.loads(await query_tool.ainvoke({"user_id": 1}))
    u2 = json.loads(await query_tool.ainvoke({"user_id": 2}))
    isolation_ok = (
        u1.get("count") == 2
        and u2.get("count") == 1
        and all(row["user_id"] == 1 for row in u1.get("transactions", []))
        and all(row["user_id"] == 2 for row in u2.get("transactions", []))
    )

    key = compute_idempotency_key(1, Decimal("88.00"), "餐饮", "幂等测试", "2026-08-15")
    async with sessions() as session:
        await insert_record(session, user_id=1, type="expense", category="餐饮", amount=Decimal("88.00"), note="幂等测试", occurred_at="2026-08-15", idempotency_key=key)
    async with sessions() as session:
        await insert_record(session, user_id=1, type="expense", category="餐饮", amount=Decimal("88.00"), note="幂等测试", occurred_at="2026-08-15", idempotency_key=key)
    async with sessions() as session:
        count = await session.scalar(
            select(func.count()).select_from(Transaction).where(Transaction.user_id == 1, Transaction.note == "幂等测试")
        )

    key2 = compute_idempotency_key(1, Decimal("89.00"), "餐饮", "幂等测试", "2026-08-15")
    await engine.dispose()
    return {
        "isolation": {
            "user1_count": u1.get("count"),
            "user2_count": u2.get("count"),
            "correct": isolation_ok,
        },
        "idempotency": {
            "duplicate_rows": int(count or 0),
            "correct": int(count or 0) == 1,
            "same_input_same_key": key == compute_idempotency_key(1, Decimal("88.00"), "餐饮", "幂等测试", "2026-08-15"),
            "different_amount_different_key": key != key2,
        },
    }


# ---------------------------------------------------------------------------
# 7. bare LLM vs deterministic tools
# ---------------------------------------------------------------------------

LEDGER = [
    # 2026-06
    ("2026-06-01", "income", "工资", "12000.00", "6月工资"),
    ("2026-06-02", "expense", "居住", "5000.00", "房租"),
    ("2026-06-03", "expense", "餐饮", "620.50", "吃饭"),
    ("2026-06-05", "expense", "交通", "280.00", "通勤"),
    ("2026-06-10", "expense", "购物", "399.00", "衣服"),
    ("2026-06-12", "expense", "医疗", "120.00", "药"),
    ("2026-06-15", "expense", "娱乐", "200.00", "电影"),
    ("2026-06-18", "expense", "居住", "180.00", "水电"),
    ("2026-06-20", "expense", "居住", "59.00", "话费"),
    ("2026-06-25", "expense", "教育", "300.00", "课程"),
    # 2026-07
    ("2026-07-01", "income", "工资", "12000.00", "7月工资"),
    ("2026-07-02", "expense", "居住", "5000.00", "房租"),
    ("2026-07-03", "expense", "餐饮", "810.30", "吃饭"),
    ("2026-07-05", "expense", "交通", "310.00", "通勤"),
    ("2026-07-10", "expense", "购物", "1299.00", "耳机"),
    ("2026-07-12", "expense", "医疗", "80.00", "药"),
    ("2026-07-15", "expense", "娱乐", "350.00", "演出"),
    ("2026-07-18", "expense", "居住", "210.00", "水电"),
    ("2026-07-20", "expense", "居住", "59.00", "话费"),
    # 2026-08
    ("2026-08-01", "income", "工资", "13000.00", "8月工资"),
    ("2026-08-02", "expense", "居住", "5000.00", "房租"),
    ("2026-08-03", "expense", "餐饮", "1020.80", "吃饭"),
    ("2026-08-05", "expense", "交通", "420.00", "通勤"),
    ("2026-08-10", "expense", "购物", "680.00", "日用品"),
    ("2026-08-12", "expense", "医疗", "350.00", "体检"),
    ("2026-08-15", "expense", "娱乐", "180.00", "电影"),
    ("2026-08-18", "expense", "居住", "230.00", "水电"),
    ("2026-08-20", "expense", "居住", "59.00", "话费"),
    ("2026-08-25", "expense", "教育", "200.00", "书"),
]


def build_facts() -> dict:
    months: dict[str, dict[str, Decimal]] = {}
    categories: dict[str, dict[str, Decimal]] = {}
    for occurred, txn_type, category, amount, _note in LEDGER:
        month = occurred[:7]
        months.setdefault(month, {"income": Decimal("0"), "expense": Decimal("0")})
        months[month][txn_type] += Decimal(amount)
        if txn_type == "expense":
            categories.setdefault(month, {})
            categories[month][category] = categories[month].get(category, Decimal("0")) + Decimal(amount)

    trend = compute_cashflow_trend(months)
    breakdown = compute_expense_breakdown(categories["2026-08"])
    aug = months["2026-08"]
    jul = months["2026-07"]
    expense_change = aug["expense"] - jul["expense"]
    food_share = (categories["2026-08"]["餐饮"] / aug["expense"] * Decimal("100")).quantize(Decimal("0.01"))
    savings_rate = ((aug["income"] - aug["expense"]) / aug["income"] * Decimal("100")).quantize(Decimal("0.01"))
    max_single = max(Decimal(row[3]) for row in LEDGER if row[1] == "expense")
    max_category = max(categories["2026-08"].items(), key=lambda item: item[1])
    total_expense = sum((month["expense"] for month in months.values()), Decimal("0"))
    aug_count = sum(1 for row in LEDGER if row[0].startswith("2026-08") and row[1] == "expense")

    food_cut = compute_scenario(
        aug["income"], aug["expense"], Decimal("0"), -(categories["2026-08"]["餐饮"] * Decimal("0.20"))
    )
    extra_saving = compute_scenario(aug["income"], aug["expense"], Decimal("0"), Decimal("-500"))
    income_up = compute_scenario(aug["income"], aug["expense"], Decimal("1000"), Decimal("0"))
    transport_double = compute_scenario(aug["income"], aug["expense"], Decimal("0"), categories["2026-08"]["交通"])

    facts = {
        "income_2026_08": aug["income"],
        "expense_2026_08": aug["expense"],
        "balance_2026_08": aug["income"] - aug["expense"],
        "food_2026_08": categories["2026-08"]["餐饮"],
        "transport_2026_08": categories["2026-08"]["交通"],
        "expense_2026_07": jul["expense"],
        "expense_change_08_vs_07": abs(expense_change),
        "expense_change_direction": "增加" if expense_change >= 0 else "减少",
        "total_expense_3m": total_expense,
        "max_single_expense": max_single,
        "food_share_2026_08_pct": food_share,
        "aug_expense_count": aug_count,
        "savings_rate_2026_08_pct": savings_rate,
        "max_category_2026_08": max_category[0],
        "max_category_amount_2026_08": max_category[1],
        "scenario_food_cut_20pct_balance": food_cut["adjusted_monthly_balance"],
        "scenario_extra_saving_500_balance": extra_saving["adjusted_monthly_balance"],
        "scenario_income_up_1000_balance": income_up["adjusted_monthly_balance"],
        "scenario_transport_double_expense": transport_double["adjusted_monthly_expense"],
    }
    return {
        "months": {month: {key: str(value) for key, value in values.items()} for month, values in months.items()},
        "trend": trend,
        "breakdown": breakdown,
        "facts": {key: str(value) for key, value in facts.items()},
    }


def make_questions(data: dict) -> list[dict]:
    facts = data["facts"]
    delta = Decimal(facts["expense_2026_08"]) - Decimal(facts["expense_2026_07"])
    if delta >= 0:
        change_question, change_truth = "2026年8月的支出比7月多了多少元？", delta
    else:
        change_question, change_truth = "2026年8月的支出比7月少了多少元？", -delta
    return [
        {"key": "income_2026_08", "question": "2026年8月的总收入是多少元？", "truth": Decimal(facts["income_2026_08"]), "tol": Decimal("0.01")},
        {"key": "expense_2026_08", "question": "2026年8月的总支出是多少元？", "truth": Decimal(facts["expense_2026_08"]), "tol": Decimal("0.01")},
        {"key": "food_2026_08", "question": "2026年8月的餐饮支出是多少元？", "truth": Decimal(facts["food_2026_08"]), "tol": Decimal("0.01")},
        {"key": "transport_2026_08", "question": "2026年8月的交通支出是多少元？", "truth": Decimal(facts["transport_2026_08"]), "tol": Decimal("0.01")},
        {"key": "balance_2026_08", "question": "2026年8月的结余是多少元？", "truth": Decimal(facts["balance_2026_08"]), "tol": Decimal("0.01")},
        {"key": "expense_change_08_vs_07", "question": change_question, "truth": change_truth, "tol": Decimal("0.01")},
        {"key": "total_expense_3m", "question": "6月到8月三个月的总支出是多少元？", "truth": Decimal(facts["total_expense_3m"]), "tol": Decimal("0.01")},
        {"key": "max_single_expense", "question": "这三个月里最大的一笔支出是多少元？", "truth": Decimal(facts["max_single_expense"]), "tol": Decimal("0.01")},
        {"key": "food_share_2026_08_pct", "question": "2026年8月餐饮支出占当月总支出的比例是多少？用百分比数值回答（例如 12.34 表示 12.34%）。", "truth": Decimal(facts["food_share_2026_08_pct"]), "tol": Decimal("0.05")},
        {"key": "aug_expense_count", "question": "2026年8月一共有多少笔支出？", "truth": Decimal(facts["aug_expense_count"]), "tol": Decimal("0")},
        {"key": "savings_rate_2026_08_pct", "question": "2026年8月的储蓄率是多少？用百分比数值回答（例如 12.34 表示 12.34%）。", "truth": Decimal(facts["savings_rate_2026_08_pct"]), "tol": Decimal("0.05")},
        {"key": "max_category_2026_08", "question": "2026年8月支出金额最大的类别是什么？只回答类别名。", "truth": facts["max_category_2026_08"], "tol": None},
        {"key": "scenario_food_cut_20pct_balance", "question": "如果8月餐饮支出减少20%，8月结余会变成多少元？", "truth": Decimal(facts["scenario_food_cut_20pct_balance"]), "tol": Decimal("0.01")},
        {"key": "scenario_extra_saving_500_balance", "question": "如果每月多存500元，8月结余会变成多少元？", "truth": Decimal(facts["scenario_extra_saving_500_balance"]), "tol": Decimal("0.01")},
        {"key": "scenario_income_up_1000_balance", "question": "如果8月收入增加1000元、支出不变，8月结余会变成多少元？", "truth": Decimal(facts["scenario_income_up_1000_balance"]), "tol": Decimal("0.01")},
        {"key": "scenario_transport_double_expense", "question": "如果8月交通支出翻倍，8月总支出会变成多少元？", "truth": Decimal(facts["scenario_transport_double_expense"]), "tol": Decimal("0.01")},
    ]


CATEGORY_NAMES = ("餐饮", "交通", "日用品", "娱乐", "医疗", "居住", "购物", "教育", "转账", "其他")


def parse_answer(content: str, expect_category: bool = False):
    obj = parse_json_object(content)
    answer = obj.get("answer", "") if isinstance(obj, dict) else ""
    if expect_category:
        for category in CATEGORY_NAMES:
            if category in answer or category in content:
                return category, answer or content[:200]
        return None, answer or content[:200]
    if obj:
        value = obj.get("value")
        if isinstance(value, (int, float)):
            return float(value), answer
        if isinstance(value, str):
            match = re.search(r"-?\d+(?:\.\d+)?", value.replace(",", ""))
            if match:
                return float(match.group()), answer
        if isinstance(answer, str):
            match = re.search(r"-?\d+(?:\.\d+)?", answer.replace(",", ""))
            if match:
                return float(match.group()), answer
    match = re.search(r"(?:为|是|：|:)\s*(-?\d+(?:\.\d+)?)", content.replace(",", ""))
    if match:
        return float(match.group(1)), content[:200]
    numbers = re.findall(r"-?\d+(?:\.\d+)?", content.replace(",", ""))
    return (float(numbers[-1]) if numbers else None), content[:200]


async def call_llm(settings, system: str, user: str, max_tokens: int = 500) -> dict:
    import litellm

    start = time.perf_counter()
    content = ""
    response = None
    for attempt in range(2):
        response = await litellm.acompletion(
            model=settings.llm_model,
            api_key=settings.llm_api_key.get_secret_value(),
            api_base=settings.llm_base_url,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0,
            max_tokens=max_tokens,
            timeout=60,
        )
        content = response.choices[0].message.content or ""
        if content.strip():
            break
        await asyncio.sleep(0.5)
    latency = (time.perf_counter() - start) * 1000
    usage = getattr(response, "usage", None)
    return {
        "content": content,
        "latency_ms": round(latency, 1),
        "total_tokens": getattr(usage, "total_tokens", None) if usage else None,
    }


async def eval_llm_ab(settings) -> dict:
    data = build_facts()
    questions = make_questions(data)
    ledger_json = json.dumps(
        [
            {"date": occurred, "type": txn_type, "category": category, "amount": amount, "note": note}
            for occurred, txn_type, category, amount, note in LEDGER
        ],
        ensure_ascii=False,
    )
    facts_json = json.dumps({key: str(value) for key, value in data["facts"].items()}, ensure_ascii=False)

    base_system = (
        "你是财务助手。根据用户提供的账单数据回答问题。"
        "只输出 JSON：{\"answer\": \"一句话\", \"value\": 数字}。"
        "金额保留两位小数；百分比用 0-100 的数值；类别题把类别名放在 answer 里。"
    )
    system_system = (
        "你是财务分析器。只能引用给定指标中的数字，禁止自行计算或编造。"
        "只输出 JSON：{\"answer\": \"一句话\", \"value\": 数字}。"
        "金额保留两位小数；百分比用 0-100 的数值；类别题把类别名放在 answer 里。"
    )

    rows = []
    base_tokens = system_tokens = 0
    base_latency = system_latency = 0.0
    for item in questions:
        question = item["question"]
        baseline = await call_llm(settings, base_system, f"账单数据（JSON）：\n{ledger_json}\n\n问题：{question}\n只输出 JSON。")
        augmented = await call_llm(settings, system_system, f"确定性工具输出（JSON）：\n{facts_json}\n\n问题：{question}\n只输出 JSON。")
        base_value, base_answer = parse_answer(baseline["content"], expect_category=item["tol"] is None)
        sys_value, sys_answer = parse_answer(augmented["content"], expect_category=item["tol"] is None)

        def correct(value):
            if item["tol"] is None:
                return str(value).strip() == item["truth"]
            try:
                return abs(Decimal(str(value)) - item["truth"]) <= item["tol"]
            except Exception:
                return False

        base_ok = correct(base_value)
        sys_ok = correct(sys_value)
        base_tokens += baseline["total_tokens"] or 0
        system_tokens += augmented["total_tokens"] or 0
        base_latency += baseline["latency_ms"]
        system_latency += augmented["latency_ms"]
        rows.append(
            {
                "key": item["key"],
                "question": question,
                "truth": str(item["truth"]),
                "baseline_value": base_value,
                "baseline_answer": base_answer[:160],
                "baseline_correct": base_ok,
                "system_value": sys_value,
                "system_answer": sys_answer[:160],
                "system_correct": sys_ok,
                "baseline_latency_ms": baseline["latency_ms"],
                "system_latency_ms": augmented["latency_ms"],
                "baseline_tokens": baseline["total_tokens"],
                "system_tokens": augmented["total_tokens"],
            }
        )
        print(f"  [{item['key']}] baseline={'OK' if base_ok else 'WRONG'} ({base_value}) system={'OK' if sys_ok else 'WRONG'} ({sys_value})")

    return {
        "total": len(rows),
        "baseline_correct": sum(1 for row in rows if row["baseline_correct"]),
        "baseline_accuracy_pct": pct(sum(1 for row in rows if row["baseline_correct"]), len(rows)),
        "system_correct": sum(1 for row in rows if row["system_correct"]),
        "system_accuracy_pct": pct(sum(1 for row in rows if row["system_correct"]), len(rows)),
        "baseline_tokens": base_tokens,
        "system_tokens": system_tokens,
        "baseline_avg_latency_ms": round(base_latency / len(rows), 1),
        "system_avg_latency_ms": round(system_latency / len(rows), 1),
        "rows": rows,
    }


# ---------------------------------------------------------------------------
# 8. pytest
# ---------------------------------------------------------------------------

def run_pytest() -> dict:
    env = dict(os.environ)
    env.setdefault("APP_ENV", "test")
    env.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    env.setdefault("JWT_SECRET", "test-only-jwt-secret-with-32-characters")
    start = time.perf_counter()
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "--disable-warnings"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=900,
        env=env,
    )
    duration = round(time.perf_counter() - start, 1)
    output = (proc.stdout or "") + "\n" + (proc.stderr or "")
    tail = "\n".join(line for line in output.splitlines() if line.strip())[-4000:]
    passed = re.search(r"(\d+) passed", output)
    failed = re.search(r"(\d+) failed", output)
    errors = re.search(r"(\d+) error", output)
    return {
        "exit_code": proc.returncode,
        "passed": int(passed.group(1)) if passed else 0,
        "failed": int(failed.group(1)) if failed else 0,
        "errors": int(errors.group(1)) if errors else 0,
        "duration_s": duration,
        "output_tail": tail,
    }


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------

def render_markdown(result: dict) -> str:
    records = result["records"]
    intent = result["intent"]
    confirm = result["confirm"]
    evidence = result["evidence"]
    graph = result["graph"]
    db = result["db"]
    ab = result.get("llm_ab")
    tests = result.get("tests")

    lines = [
        f"# Smart Finance 价值硬证据（{TODAY}）",
        "",
        "> 全部指标由本仓库脚本实测生成，可复现；未使用任何编造数字。",
        f"> 环境：Python 3.11 / SQLite 内存库 / 模型 `deepseek-v4-flash`（temp=0）。",
        "",
        "## 一页结论",
        "",
    ]
    lines.append(f"- **规则层**：{records['rule_all']['correct']}/{records['rule_all']['total']} 条记账语句解析正确（{records['rule_all']['accuracy_pct']}%）；常见句 {records['rule_common']['correct']}/{records['rule_common']['total']}，长尾/歧义句 {records['rule_hard']['correct']}/{records['rule_hard']['total']}。")
    lines.append(f"- **规则 + 置信升级**：长尾句转 LLM 后整体 {records['hybrid_all']['correct']}/{records['hybrid_all']['total']}（{records['hybrid_all']['accuracy_pct']}%），LLM 调用占比 {records['escalation_pct']}%。")
    lines.append(f"- **意图路由**：规则层命中 {intent['rule_hit_pct']}%，规则命中准确率 {intent['rule_accuracy_pct']}%；混合路由整体 {intent['hybrid_accuracy_pct']}%（LLM 兜底 {intent['llm_calls']}/{intent['total']} 次）。")
    lines.append(f"- **安全闸门**：写确认策略 {confirm['correct']}/{confirm['total']}（{confirm['accuracy_pct']}%）；证据链 fabricated 拦截 {evidence['fabricated_removed_pct']}%；用户隔离与幂等 {'通过' if db['isolation']['correct'] and db['idempotency']['correct'] else '未通过'}；图级校验 {graph['correct']}/{graph['total']}。")
    if ab:
        lines.append(f"- **裸模型 vs 系统**：{ab['total']} 道财务计算题，裸模型 {ab['baseline_correct']}/{ab['total']}（{ab['baseline_accuracy_pct']}%），确定性工具增强后 {ab['system_correct']}/{ab['total']}（{ab['system_accuracy_pct']}%）。")
    if tests:
        lines.append(f"- **测试套件**：{tests['passed']} passed / {tests['failed']} failed / {tests['errors']} errors（{tests['duration_s']}s）。")
    lines += [
        "",
        "## 1. 记账解析：规则层 vs 规则+LLM 升级",
        "",
        "| 子集 | 规则正确 | 规则准确率 | 混合正确 | 混合准确率 |",
        "|---|---:|---:|---:|---:|",
        f"| 常见句 | {records['rule_common']['correct']}/{records['rule_common']['total']} | {records['rule_common']['accuracy_pct']}% | {records['hybrid_common']['correct']}/{records['hybrid_common']['total']} | {records['hybrid_common']['accuracy_pct']}% |",
        f"| 长尾/歧义句 | {records['rule_hard']['correct']}/{records['rule_hard']['total']} | {records['rule_hard']['accuracy_pct']}% | {records['hybrid_hard']['correct']}/{records['hybrid_hard']['total']} | {records['hybrid_hard']['accuracy_pct']}% |",
        f"| 合计 | {records['rule_all']['correct']}/{records['rule_all']['total']} | {records['rule_all']['accuracy_pct']}% | {records['hybrid_all']['correct']}/{records['hybrid_all']['total']} | {records['hybrid_all']['accuracy_pct']}% |",
        "",
        f"升级规则：规则弃权、支出类别落到「其他」、或出现人均/AA/分摊/每等均摊词时转 LLM。LLM 调用 {records['llm_calls']}/{records['rule_all']['total']}（{records['escalation_pct']}%）。",
        "",
        "**关键发现**：规则层在标准句上很快，但会在品牌名（星巴克/盒马/iPhone）和多人分摊句上「自信地错」。修复方向不是全量调 LLM，而是把「规则命中」升级为「规则置信」——只把低置信样本转模型。",
        "",
        "### 逐条结果",
        "",
        "| 输入 | 子集 | 规则解析 | 期望 | 规则对 | 升级 | 混合对 |",
        "|---|---|---|---|---|---|---|",
    ]
    for row in records["hybrid_rows"]:
        expected = row["expected"]
        rule_text = "弃权" if row["abstained"] else f"{row['rule'].get('category')} {row['rule'].get('amount')}"
        lines.append(
            f"| {row['text']} | {row['subset']} | {rule_text} | {expected['category']} {expected['amount']} | {'✓' if row['correct'] else '✗'} | {'LLM' if row['used'] == 'llm' else '-'} | {'✓' if row['hybrid_correct'] else '✗'} |"
        )

    lines += [
        "",
        "## 2. 意图路由：规则层能挡掉多少 LLM 调用",
        "",
        f"- 规则命中：{intent['rule_hit_count']}/{intent['total']}（{intent['rule_hit_pct']}%）",
        f"- 规则命中准确率：{intent['rule_accuracy_pct']}%",
        f"- 混合路由准确率：{intent['hybrid_accuracy_pct']}%",
        f"- 实际 LLM 调用：{intent['llm_calls']}/{intent['total']}",
        "",
    ]
    if intent["errors"]:
        lines.append("**混合路由错误**：")
        for row in intent["errors"]:
            lines.append(f"- `{row['text']}`：期望 {row['expected']}，实际 {row['hybrid']}（{row['hybrid_method']}）")
        lines.append("")

    lines += [
        "## 3. 安全闸门",
        "",
        f"- 写操作确认策略：{confirm['correct']}/{confirm['total']}（{confirm['accuracy_pct']}%）",
        f"- 证据链：真实数字保留 {evidence['grounded_kept_pct']}%，编造数字拦截 {evidence['fabricated_removed_pct']}%",
        f"- 图级校验：非法工具/缺 user_id/参数类型/用户 ID 伪造 {graph['correct']}/{graph['total']}",
        f"- 多租户隔离：user1 只看到自己的 {db['isolation']['user1_count']} 条，user2 只看到 {db['isolation']['user2_count']} 条",
        f"- 幂等：同一笔重复提交落库 {db['idempotency']['duplicate_rows']} 条",
        "",
        "> 证据链的已知局限：句级过滤会把「真实数字 + 编造数字」混在同一句里时整句删掉，也会误删合理建议中的数字。下一步应做子句级校验。",
        "",
    ]

    if ab:
        lines += [
            "## 4. 裸模型 vs 确定性工具增强（同一批账单）",
            "",
            "| 指标 | 裸模型 | 系统（确定性工具 + 约束） |",
            "|---|---:|---:|",
            f"| 正确题数 | {ab['baseline_correct']}/{ab['total']} | {ab['system_correct']}/{ab['total']} |",
            f"| 准确率 | {ab['baseline_accuracy_pct']}% | {ab['system_accuracy_pct']}% |",
            f"| 总 token | {ab['baseline_tokens']} | {ab['system_tokens']} |",
            f"| 平均延迟 | {ab['baseline_avg_latency_ms']} ms | {ab['system_avg_latency_ms']} ms |",
            "",
            "### 逐题",
            "",
            "| 问题 | 标准答案 | 裸模型 | 系统 |",
            "|---|---:|---:|---:|",
        ]
        for row in ab["rows"]:
            lines.append(
                f"| {row['question']} | {row['truth']} | {row['baseline_value']} {'✓' if row['baseline_correct'] else '✗'} | {row['system_value']} {'✓' if row['system_correct'] else '✗'} |"
            )
        lines.append("")

    if tests:
        lines += [
            "## 5. 测试套件",
            "",
            f"- `pytest -q`：**{tests['passed']} passed / {tests['failed']} failed / {tests['errors']} errors**，耗时 {tests['duration_s']}s",
            f"- exit code：{tests['exit_code']}",
            "",
        ]

    lines += [
        "## 6. 怎么用这些数字",
        "",
        "面试里不要报「我做了个智能记账」，报这三个对比：",
        "",
        f"1. **成本**：规则层命中 {intent['rule_hit_pct']}% 的意图请求零 LLM；记账长尾只有 {records['escalation_pct']}% 需要模型。",
        f"2. **正确性**：同一批账单、同一模型，裸答 {ab['baseline_accuracy_pct'] if ab else '—'}% vs 确定性工具增强 {ab['system_accuracy_pct'] if ab else '—'}%；差异不是模型更强，是计算不经过模型。",
        f"3. **安全**：写确认 {confirm['accuracy_pct']}%、编造数字拦截 {evidence['fabricated_removed_pct']}%、越权/非法工具 {graph['correct']}/{graph['total']}、重复提交只落 1 条。",
        "",
        "复现：`APP_ENV=test DATABASE_URL=\"sqlite+aiosqlite:///:memory:\" .venv-bench/Scripts/python.exe scripts/value_proof.py`",
        "",
    ]
    return "\n".join(lines)


async def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    from app.core.config import get_settings

    settings = get_settings()
    model = LiteLLMChatModel(settings)

    print("[1/7] record extraction...")
    records = await eval_records(model)
    print(f"  rule {records['rule_all']['correct']}/{records['rule_all']['total']}, hybrid {records['hybrid_all']['correct']}/{records['hybrid_all']['total']}, llm calls {records['llm_calls']}")

    print("[2/7] intent routing...")
    intent = await eval_intent(model)
    print(f"  rule hit {intent['rule_hit_pct']}%, hybrid {intent['hybrid_accuracy_pct']}%")

    print("[3/7] confirmation policy...")
    confirm = eval_confirm()

    print("[4/7] evidence chain...")
    evidence = eval_evidence()

    print("[5/7] graph validation...")
    graph = eval_graph()

    print("[6/7] DB isolation + idempotency...")
    db = await eval_db()

    print("[7/7] bare LLM vs deterministic tools...")
    llm_ab = await eval_llm_ab(settings)

    print("[+] pytest suite...")
    tests = run_pytest()

    result = {
        "date": TODAY,
        "records": records,
        "intent": intent,
        "confirm": confirm,
        "evidence": evidence,
        "graph": graph,
        "db": db,
        "llm_ab": llm_ab,
        "tests": tests,
    }
    json_path = OUT_DIR / f"value_proof_{TODAY}.json"
    md_path = OUT_DIR / f"value_proof_{TODAY}.md"
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    md_path.write_text(render_markdown(result), encoding="utf-8")
    print(f"\nWROTE {json_path}")
    print(f"WROTE {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
