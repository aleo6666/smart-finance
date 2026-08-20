"""汇率看板服务：抓取快照、24h 变化、连续趋势、异常告警、AI 建议、周报、上下文。

对齐旧 Node 后端 server/src/services/exchangeRate.js 的逻辑：
- 数据源 https://open.er-api.com/v6/latest/CNY，rate = 1 / rates[currency]
  （1 单位外币 = X 人民币），存为 exchange_rates 快照
- 异常规则：24h 波动 ≥2%（warning）；连续 3 天同向且累计 ≥1%（info）；
  USD/EUR/JPY 高低阈值突破（critical / info）
- AI 建议优先（LiteLLM + zhipu/glm-4-flash），无 API Key 或失败时降级规则引擎
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from decimal import Decimal

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.llm import get_chat_model
from app.models.support import ExchangeRate

logger = logging.getLogger(__name__)

TARGETS = ["USD", "EUR", "JPY", "GBP", "HKD", "KRW", "AUD", "THB"]
_SOURCE_URL = "https://open.er-api.com/v6/latest/CNY"
_HTTP_TIMEOUT = 10.0

_CURRENCY_NAMES = {
    "USD": "美元",
    "EUR": "欧元",
    "JPY": "日元",
    "GBP": "英镑",
    "HKD": "港币",
    "KRW": "韩元",
    "AUD": "澳元",
    "THB": "泰铢",
}

_THRESHOLDS = {
    "USD": {"low": Decimal("6.8"), "high": Decimal("7.5")},
    "EUR": {"low": Decimal("7.0"), "high": Decimal("8.5")},
    "JPY": {"low": Decimal("0.044"), "high": Decimal("0.050")},
}


# ========= 数据抓取 =========


async def fetch_rates(db: AsyncSession) -> bool:
    """抓取最新汇率并落库快照；失败返回 False（不抛异常）。"""
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.get(_SOURCE_URL)
            response.raise_for_status()
            payload = response.json()
    except Exception as exc:  # 网络/解析失败都静默降级
        logger.warning("[Exchange] 汇率获取失败: %s", exc)
        return False

    now = datetime.now()
    rows: list[ExchangeRate] = []
    for currency in TARGETS:
        value = payload.get("rates", {}).get(currency)
        if value:
            try:
                rate = (Decimal("1") / Decimal(str(value))).quantize(
                    Decimal("0.00000001")
                )
            except Exception:
                continue
            rows.append(
                ExchangeRate(base="CNY", currency=currency, rate=rate, fetched_at=now)
            )
    if not rows:
        return False
    db.add_all(rows)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        logger.warning("[Exchange] 汇率快照写入失败", exc_info=True)
        return False
    logger.info("[Exchange] 汇率数据已更新 (%s), %d 货币对", now, len(rows))
    return True


# ========= 数据查询 =========


async def get_latest_rates(db: AsyncSession) -> dict[str, ExchangeRate]:
    rates: dict[str, ExchangeRate] = {}
    for currency in TARGETS:
        row = await db.scalar(
            select(ExchangeRate)
            .where(ExchangeRate.currency == currency)
            .order_by(ExchangeRate.fetched_at.desc(), ExchangeRate.id.desc())
            .limit(1)
        )
        if row is not None:
            rates[currency] = row
    return rates


async def get_latest_rate(db: AsyncSession, currency: str) -> ExchangeRate | None:
    return await db.scalar(
        select(ExchangeRate)
        .where(ExchangeRate.currency == currency)
        .order_by(ExchangeRate.fetched_at.desc(), ExchangeRate.id.desc())
        .limit(1)
    )


async def get_24h_change(
    db: AsyncSession, currency: str
) -> dict | None:
    latest = await get_latest_rate(db, currency)
    if latest is None:
        return None
    cutoff = latest.fetched_at - timedelta(hours=24)
    prev = await db.scalar(
        select(ExchangeRate)
        .where(
            ExchangeRate.currency == currency,
            ExchangeRate.fetched_at <= cutoff,
        )
        .order_by(ExchangeRate.fetched_at.desc(), ExchangeRate.id.desc())
        .limit(1)
    )
    if prev is None:
        return None
    change = (float(latest.rate) - float(prev.rate)) / float(prev.rate) * 100
    return {
        "current": float(latest.rate),
        "previous": float(prev.rate),
        "change": round(change, 4),
        "time": latest.fetched_at,
    }


async def get_history(
    db: AsyncSession, currency: str, hours: int = 168
) -> list[ExchangeRate]:
    cutoff = datetime.now() - timedelta(hours=hours)
    rows = (
        await db.scalars(
            select(ExchangeRate)
            .where(
                ExchangeRate.currency == currency,
                ExchangeRate.fetched_at >= cutoff,
            )
            .order_by(ExchangeRate.fetched_at.asc(), ExchangeRate.id.asc())
        )
    ).all()
    return list(rows)


async def get_consecutive_trend(
    db: AsyncSession, currency: str, days: int = 3
) -> dict | None:
    """连续 N 天同向趋势：按天聚合日均，逐日变化方向一致且累计变化 ≥0.1%。"""
    cutoff = datetime.now() - timedelta(days=days * 2)
    rows = (
        await db.scalars(
            select(ExchangeRate)
            .where(
                ExchangeRate.currency == currency,
                ExchangeRate.fetched_at >= cutoff,
            )
            .order_by(ExchangeRate.fetched_at.asc(), ExchangeRate.id.asc())
        )
    ).all()
    if len(rows) < days:
        return None

    daily: dict[str, list[float]] = {}
    for row in rows:
        daily.setdefault(row.fetched_at.date().isoformat(), []).append(
            float(row.rate)
        )
    days_list = [
        {"day": day, "avg": sum(values) / len(values)}
        for day, values in sorted(daily.items())
    ]
    if len(days_list) < days:
        return None

    recent = days_list[-days:]
    direction = 0
    for index in range(1, len(recent)):
        prev_avg = recent[index - 1]["avg"]
        change = (recent[index]["avg"] - prev_avg) / prev_avg * 100
        if abs(change) < 0.1:
            continue
        if direction == 0:
            direction = 1 if change > 0 else -1
        elif (change > 0 and direction == -1) or (
            change < 0 and direction == 1
        ):
            return None
    if direction == 0:
        return None

    total_change = (
        (recent[-1]["avg"] - recent[0]["avg"]) / recent[0]["avg"] * 100
    )
    return {
        "direction": "上涨" if direction == 1 else "下跌",
        "days": days,
        "totalChange": round(total_change, 2),
        "data": recent,
    }


# ========= 异常检测 =========


async def detect_anomalies(db: AsyncSession) -> list[dict]:
    alerts: list[dict] = []
    for currency in ("USD", "EUR", "JPY"):
        volatility = await _check_volatility(db, currency)
        if volatility:
            alerts.append(volatility)
        trend = await _check_consecutive_trend_anomaly(db, currency, 3)
        if trend:
            alerts.append(trend)
        breach = await _check_threshold_breach(db, currency)
        if breach:
            alerts.append(breach)
    return alerts


async def _check_volatility(
    db: AsyncSession, currency: str, threshold: float = 2
) -> dict | None:
    change = await get_24h_change(db, currency)
    if change is None or abs(change["change"]) < threshold:
        return None
    sign = "+" if change["change"] > 0 else ""
    return {
        "rule": "volatility",
        "level": "warning",
        "title": f"⚠️ {currency}/CNY 汇率大幅波动",
        "message": (
            f"{currency}/CNY 24小时变化 {sign}{change['change']}%"
            f"（当前 {change['current']:.4f}），请关注汇率变化"
        ),
        "data": change,
    }


async def _check_consecutive_trend_anomaly(
    db: AsyncSession, currency: str, days: int = 3
) -> dict | None:
    trend = await get_consecutive_trend(db, currency, days)
    if trend is None or abs(trend["totalChange"]) < 1:
        return None
    sign = "+" if trend["totalChange"] > 0 else ""
    return {
        "rule": "trend",
        "level": "info",
        "title": f"📈 {currency}/CNY 连续{trend['days']}天{trend['direction']}",
        "message": (
            f"{currency}/CNY 连续{trend['days']}天{trend['direction']}，"
            f"累计{sign}{trend['totalChange']}%，建议关注趋势"
        ),
        "data": trend,
    }


async def _check_threshold_breach(
    db: AsyncSession, currency: str
) -> dict | None:
    latest = await get_latest_rate(db, currency)
    if latest is None:
        return None
    threshold = _THRESHOLDS.get(currency)
    if threshold is None:
        return None
    rate = float(latest.rate)
    high = float(threshold["high"])
    low = float(threshold["low"])
    if rate >= high:
        return {
            "rule": "threshold_high",
            "level": "critical",
            "title": f"🔴 {currency}/CNY 突破 {high}",
            "message": (
                f"{currency}/CNY 当前 {rate:.4f}，已突破{high}，建议关注换汇时机"
            ),
            "data": {"rate": rate, "threshold": high, "direction": "high"},
        }
    if rate <= low:
        return {
            "rule": "threshold_low",
            "level": "info",
            "title": f"🟢 {currency}/CNY 跌破 {low}",
            "message": (
                f"{currency}/CNY 当前 {rate:.4f}，已跌破{low}，可能是换汇好时机"
            ),
            "data": {"rate": rate, "threshold": low, "direction": "low"},
        }
    return None


# ========= AI 建议（带规则降级） =========


async def get_rate_advice(
    db: AsyncSession, currency: str
) -> dict | None:
    change = await get_24h_change(db, currency)
    latest = await get_latest_rate(db, currency)

    ai_advice = await _generate_ai_advice(db, currency, change, latest)
    if ai_advice:
        return ai_advice

    if change is None:
        return None
    advices = {
        "USD": "建议使用人民币结算，暂缓大额美元消费",
        "EUR": "欧元波动中，出行前关注汇率走势",
        "JPY": "日元处于低位，是换汇的好时机",
    }
    if change["change"] > 1:
        return {
            "advice": advices.get(currency, f"{currency}汇率上涨较多，建议使用人民币结算"),
            "direction": "up",
            "change": change["change"],
        }
    if change["change"] < -1:
        return {
            "advice": f"{currency}汇率下跌，现在是兑换{currency}的好时机",
            "direction": "down",
            "change": change["change"],
        }
    return None


async def _generate_ai_advice(
    db: AsyncSession, currency: str, change: dict | None, latest: ExchangeRate | None
) -> dict | None:
    settings = get_settings()
    if settings.llm_api_key is None:
        return None
    try:
        from langchain_core.messages import HumanMessage, SystemMessage

        name = _CURRENCY_NAMES.get(currency, currency)
        rate_text = f"{float(latest.rate):.4f}" if latest else "0.0000"
        if change is None:
            change_text = "未知"
        else:
            sign = "+" if change["change"] > 0 else ""
            change_text = f"{sign}{change['change']}%"
        messages = [
            SystemMessage(
                content=(
                    "你是一个专业的汇率分析师。请根据提供的汇率数据，"
                    "给出简短实用的换汇/消费建议。用中文回答，控制在 80 字以内。"
                )
            ),
            HumanMessage(
                content=(
                    f"当前 {name}({currency})/CNY 汇率: {rate_text}。"
                    f"24小时变化: {change_text}。请给出换汇时机建议或出行消费建议。"
                )
            ),
        ]
        response = await get_chat_model(settings).ainvoke(messages)
        text = (response.content or "").strip()
        if not text:
            return None
        direction = (
            "up"
            if change and change["change"] > 0
            else "down"
            if change and change["change"] < 0
            else "flat"
        )
        return {
            "advice": text,
            "direction": direction,
            "change": change["change"] if change else 0,
            "source": "zhipu-ai",
        }
    except Exception as exc:
        logger.warning("[Exchange] Zhipu advice for %s skipped: %s", currency, exc)
        return None


# ========= AI 周报 =========


async def generate_weekly_report(db: AsyncSession) -> dict:
    report: dict = {"generatedAt": datetime.now().isoformat(), "currencies": {}}
    for currency in ("USD", "EUR", "JPY", "GBP"):
        history = await get_history(db, currency, 168)
        if not history:
            continue
        first = float(history[0].rate)
        last = float(history[-1].rate)
        week_change = (last - first) / first * 100 if first else 0
        values = [float(row.rate) for row in history]
        report["currencies"][currency] = {
            "start": f"{first:.4f}",
            "end": f"{last:.4f}",
            "weekChange": round(week_change, 2),
            "high": f"{max(values):.4f}",
            "low": f"{min(values):.4f}",
            "trend": "上涨" if week_change > 0 else "下跌",
        }
    try:
        summary = await _generate_ai_weekly_summary(report)
        if summary:
            report["summary"] = summary
    except Exception:
        pass
    return report


async def _generate_ai_weekly_summary(report: dict) -> str | None:
    entries = list(report.get("currencies", {}).items())
    if not entries:
        return None
    settings = get_settings()
    if settings.llm_api_key is None:
        return None
    lines = "\n".join(
        f"{currency}: {data['start']} → {data['end']} "
        f"({data['trend']}{data['weekChange']}%)"
        for currency, data in entries
    )
    try:
        from langchain_core.messages import HumanMessage, SystemMessage

        messages = [
            SystemMessage(
                content=(
                    "你是汇率分析师。根据本周各货币对CNY的汇率变化数据，"
                    "生成一段简洁的周报摘要（100字内）。"
                )
            ),
            HumanMessage(content=f"本周汇率变化：\n{lines}\n\n请生成周报摘要。"),
        ]
        response = await get_chat_model(settings).ainvoke(messages)
        text = (response.content or "").strip()
        return text or None
    except Exception as exc:
        logger.warning("[Exchange] AI 周报摘要生成失败: %s", exc)
        return None


# ========= 汇率上下文摘要（供对话 Agent 注入） =========


async def get_exchange_context(db: AsyncSession) -> str:
    rates = await get_latest_rates(db)
    if not rates:
        return ""
    lines = ["## 当前汇率（CNY）"]
    for currency, row in rates.items():
        change = await get_24h_change(db, currency)
        arrow = "↑" if change and change["change"] > 0 else "↓" if change else ""
        lines.append(f"- {currency}: {float(row.rate):.4f} {arrow}")

    anomalies = await detect_anomalies(db)
    if anomalies:
        lines.append("\n## 汇率异常提醒")
        for alert in anomalies:
            lines.append(f"- {alert['title']}: {alert['message']}")

    for currency in ("USD", "JPY"):
        advice = await get_rate_advice(db, currency)
        if advice:
            lines.append(f"\n💡 {currency}建议: {advice['advice']}")
    return "\n".join(lines)
