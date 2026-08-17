"""从旧 Node MySQL 迁移到新 Python 库。

连接串走环境变量：
- ``OLD_DATABASE_URL``：旧库（Node 系统）
- ``DATABASE_URL``：新库（当前系统，async 驱动）

用法::

    python scripts/migrate_from_node.py --dry-run
    python scripts/migrate_from_node.py --limit 100
    python scripts/migrate_from_node.py

幂等：按主键 id 跳过已迁移行，可安全重跑。密码哈希（bcrypt）直接复用。
"""

from __future__ import annotations

import argparse
import asyncio
import calendar
import json
import logging
import os
import sys
from collections.abc import Callable
from datetime import date, datetime, time
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.ext.asyncio import AsyncEngine

from app.models import Asset, Budget, Goal, Ledger, Transaction, User

logger = logging.getLogger(__name__)

MONEY = Decimal("0.01")
OLD_ASSET_TYPE_MAP = {
    "deposit": "bank_deposit",
    "fund": "investment",
    "stock": "investment",
    "liability": "other",
}


def _quantize(value) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value)).quantize(MONEY, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return None


def _to_datetime(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, time.min)
    try:
        return datetime.combine(date.fromisoformat(str(value)[:10]), time.min)
    except ValueError:
        return None


def _to_date(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _with_created_at(mapped: dict, row) -> dict:
    created_at = row.get("created_at")
    if created_at is not None:
        mapped["created_at"] = created_at
    return mapped


def map_user(row) -> dict | None:
    email = row.get("email")
    password = row.get("password")
    if not email or not password:
        return None  # 匿名/无邮箱用户无法迁移到邮箱密码认证
    return _with_created_at(
        {
            "id": row["id"],
            "email": email,
            "password_hash": password,
            "nickname": row.get("nickname"),
        },
        row,
    )


def map_ledger(row) -> dict | None:
    return _with_created_at(
        {
            "id": row["id"],
            "user_id": row["user_id"],
            "name": row["name"],
            "icon": row.get("icon"),
            "color": row.get("color"),
            "base_currency": row.get("base_currency") or "CNY",
        },
        row,
    )


def map_record(row) -> dict | None:
    user_id = row.get("user_id")
    ledger_id = row.get("ledger_id")
    occurred_at = _to_datetime(row.get("date"))
    if user_id is None or ledger_id is None or occurred_at is None:
        return None  # 设备匿名记录 / 无账本归属无法映射
    record_type = row.get("type")
    return _with_created_at(
        {
            "id": row["id"],
            "user_id": user_id,
            "ledger_id": ledger_id,
            "type": record_type if record_type in ("income", "expense") else "expense",
            "category": row.get("category") or "其他",
            "amount": _quantize(row.get("amount")),
            "currency": row.get("currency") or "CNY",
            "note": row.get("description") or row.get("merchant"),
            "occurred_at": occurred_at,
        },
        row,
    )


def _budget_period_bounds(period: str, anchor):
    if isinstance(anchor, datetime):
        anchor_date = anchor.date()
    elif isinstance(anchor, date):
        anchor_date = anchor
    else:
        anchor_date = datetime.now().date()
    if period == "yearly":
        return date(anchor_date.year, 1, 1), date(anchor_date.year, 12, 31)
    last_day = calendar.monthrange(anchor_date.year, anchor_date.month)[1]
    return (
        date(anchor_date.year, anchor_date.month, 1),
        date(anchor_date.year, anchor_date.month, last_day),
    )


def map_budget(row) -> dict | None:
    user_id = row.get("user_id")
    ledger_id = row.get("ledger_id")
    if user_id is None or ledger_id is None:
        return None
    period = row.get("period") if row.get("period") in ("monthly", "yearly") else "monthly"
    period_start, period_end = _budget_period_bounds(period, row.get("created_at"))
    return _with_created_at(
        {
            "id": row["id"],
            "user_id": user_id,
            "ledger_id": ledger_id,
            "category": row.get("category") or "其他",
            "amount": _quantize(row.get("amount")),
            "period": period,
            "period_start": period_start,
            "period_end": period_end,
        },
        row,
    )


def map_goal(row) -> dict | None:
    if row.get("user_id") is None:
        return None
    target_date = _to_date(row.get("deadline"))
    if target_date is None:
        return None
    return _with_created_at(
        {
            "id": row["id"],
            "user_id": row["user_id"],
            "name": row["name"],
            "target_amount": _quantize(row.get("target_amount")),
            "current_amount": _quantize(row.get("current_amount")) or Decimal("0.00"),
            "target_date": target_date,
        },
        row,
    )


def map_asset(row) -> dict | None:
    return _with_created_at(
        {
            "id": row["id"],
            "user_id": row["user_id"],
            "name": row["name"],
            "type": OLD_ASSET_TYPE_MAP.get(row.get("type"), "other"),
            "amount": _quantize(row.get("balance")) or Decimal("0.00"),
            "currency": row.get("currency") or "CNY",
            "notes": row.get("note"),
        },
        row,
    )


# 迁移顺序遵循外键依赖；references 记录「列 → 父表」，用于跳过孤儿行
TABLE_SPECS = [
    {"source": "users", "target": "users", "map": map_user, "table": User.__table__, "references": {}},
    {"source": "ledgers", "target": "ledgers", "map": map_ledger, "table": Ledger.__table__, "references": {"user_id": "users"}},
    {"source": "records", "target": "transactions", "map": map_record, "table": Transaction.__table__, "references": {"user_id": "users", "ledger_id": "ledgers"}},
    {"source": "budgets", "target": "budgets", "map": map_budget, "table": Budget.__table__, "references": {"user_id": "users", "ledger_id": "ledgers"}},
    {"source": "goals", "target": "goals", "map": map_goal, "table": Goal.__table__, "references": {"user_id": "users"}},
    {"source": "assets", "target": "assets", "map": map_asset, "table": Asset.__table__, "references": {"user_id": "users"}},
]


async def _existing_ids(target: AsyncEngine, table) -> set:
    async with target.connect() as connection:
        result = await connection.execute(select(table.c.id))
        return {row[0] for row in result}


async def _migrate_table(
    source: AsyncEngine,
    target: AsyncEngine,
    spec: dict,
    known_ids: dict[str, set],
    *,
    dry_run: bool,
    limit: int | None,
) -> tuple[dict, set]:
    source_name = spec["source"]
    target_table = spec["table"]
    map_row: Callable[[dict], dict | None] = spec["map"]

    query = f"SELECT * FROM {source_name}"
    if limit:
        query += f" LIMIT {int(limit)}"
    try:
        async with source.connect() as connection:
            result = await connection.execute(text(query))
            rows = [dict(row._mapping) for row in result]
    except Exception as exc:
        logger.warning("读取源表 %s 失败，跳过: %s", source_name, exc)
        return {"total": 0, "migrated": 0, "skipped": 0, "failed": 0}, set()

    existing = await _existing_ids(target, target_table)
    planned: list[dict] = []
    failed = 0
    for row in rows:
        try:
            mapped = map_row(row)
        except Exception:
            failed += 1
            continue
        if mapped is None or mapped.get("id") is None:
            continue
        if mapped["id"] in existing:
            continue
        if any(
            mapped.get(column) not in known_ids[parent]
            for column, parent in spec["references"].items()
        ):
            continue
        planned.append(mapped)
        existing.add(mapped["id"])

    if not dry_run and planned:
        async with target.begin() as connection:
            await connection.execute(target_table.insert(), planned)

    migrated = len(planned)
    skipped = len(rows) - migrated - failed
    return (
        {"total": len(rows), "migrated": migrated, "skipped": skipped, "failed": failed},
        existing,
    )


async def migrate(
    source: AsyncEngine,
    target: AsyncEngine,
    *,
    dry_run: bool = False,
    limit: int | None = None,
) -> dict:
    """把旧库数据迁移到新库，返回每表 {total, migrated, skipped, failed} 报告。"""
    report: dict = {}
    known_ids: dict[str, set] = {}
    for spec in TABLE_SPECS:
        table_report, ids = await _migrate_table(
            source, target, spec, known_ids, dry_run=dry_run, limit=limit
        )
        report[spec["target"]] = table_report
        known_ids[spec["target"]] = ids
    return report


def to_async_url(url: str) -> str:
    if url.startswith("mysql://") or url.startswith("mysql+pymysql://"):
        return "mysql+asyncmy://" + url.split("://", 1)[1]
    if url.startswith("sqlite://") and not url.startswith("sqlite+aiosqlite://"):
        return "sqlite+aiosqlite://" + url.split("://", 1)[1]
    return url


async def _run(args) -> None:
    old_url = to_async_url(os.environ["OLD_DATABASE_URL"])
    new_url = to_async_url(
        os.environ.get("DATABASE_URL") or os.environ["NEW_DATABASE_URL"]
    )
    source = create_async_engine(old_url)
    target = create_async_engine(new_url)
    try:
        report = await migrate(
            source, target, dry_run=args.dry_run, limit=args.limit
        )
    finally:
        await source.dispose()
        await target.dispose()
    print(json.dumps(report, ensure_ascii=False, default=str, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="从旧 Node MySQL 迁移到新 Python 库")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写入")
    parser.add_argument("--limit", type=int, default=None, help="每个表最多迁移 N 条")
    args = parser.parse_args()
    asyncio.run(_run(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
