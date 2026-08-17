"""数据迁移脚本测试：SQLite 源库 → 目标库映射正确性（可注入连接）。"""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.models import Asset, Base, Budget, Goal, Ledger, Transaction, User
from scripts.migrate_from_node import migrate, to_async_url


OLD_SCHEMA = [
    "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, password TEXT, nickname TEXT)",
    "CREATE TABLE ledgers (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, icon TEXT, color TEXT, base_currency TEXT)",
    "CREATE TABLE records (id INTEGER PRIMARY KEY, user_id INTEGER, ledger_id INTEGER, type TEXT, amount REAL, currency TEXT, category TEXT, description TEXT, merchant TEXT, date TEXT)",
    "CREATE TABLE budgets (id INTEGER PRIMARY KEY, user_id INTEGER, ledger_id INTEGER, category TEXT, amount REAL, period TEXT)",
    "CREATE TABLE goals (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, target_amount REAL, current_amount REAL, deadline TEXT)",
    "CREATE TABLE assets (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, type TEXT, balance REAL, currency TEXT, note TEXT)",
]


async def _make_engines(tmp_path) -> tuple[AsyncEngine, AsyncEngine]:
    source = create_async_engine(
        f"sqlite+aiosqlite:///{(tmp_path / 'source.db').as_posix()}"
    )
    target = create_async_engine(
        f"sqlite+aiosqlite:///{(tmp_path / 'target.db').as_posix()}"
    )
    async with source.begin() as connection:
        for ddl in OLD_SCHEMA:
            await connection.execute(text(ddl))
    async with target.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return source, target


async def _seed_source(source: AsyncEngine) -> None:
    async with source.begin() as connection:
        await connection.execute(
            text("INSERT INTO users VALUES (1, 'alice@example.com', '$2b$12$abcdefghijklmnopqrstuv', 'Alice')")
        )
        await connection.execute(text("INSERT INTO users VALUES (2, NULL, NULL, NULL)"))
        await connection.execute(
            text("INSERT INTO ledgers VALUES (1, 1, '我的账本', NULL, NULL, 'CNY')")
        )
        await connection.execute(
            text("INSERT INTO records VALUES (1, 1, 1, 'expense', 88.5, 'CNY', '餐饮', '午餐', '麦当劳', '2026-08-01')")
        )
        await connection.execute(
            text("INSERT INTO records VALUES (2, NULL, 1, 'expense', 10, 'CNY', '其他', NULL, NULL, '2026-08-02')")
        )
        await connection.execute(
            text("INSERT INTO budgets VALUES (1, 1, 1, '餐饮', 500, 'monthly')")
        )
        await connection.execute(
            text("INSERT INTO goals VALUES (1, 1, '旅行基金', 10000, 2000, '2026-12-31')")
        )
        await connection.execute(
            text("INSERT INTO goals VALUES (2, 1, '无期限目标', 500, 0, NULL)")
        )
        await connection.execute(
            text("INSERT INTO assets VALUES (1, 1, '招商银行', 'deposit', 12345.67, 'CNY', '工资卡')")
        )


async def test_migrate_maps_old_schema_to_new(tmp_path) -> None:
    source, target = await _make_engines(tmp_path)
    await _seed_source(source)
    try:
        report = await migrate(source, target)

        assert report["users"] == {"total": 2, "migrated": 1, "skipped": 1, "failed": 0}
        assert report["ledgers"] == {"total": 1, "migrated": 1, "skipped": 0, "failed": 0}
        assert report["transactions"] == {"total": 2, "migrated": 1, "skipped": 1, "failed": 0}
        assert report["budgets"] == {"total": 1, "migrated": 1, "skipped": 0, "failed": 0}
        assert report["goals"] == {"total": 2, "migrated": 1, "skipped": 1, "failed": 0}
        assert report["assets"] == {"total": 1, "migrated": 1, "skipped": 0, "failed": 0}

        async with target.connect() as connection:
            user = (
                await connection.execute(
                    select(User.__table__).where(User.__table__.c.id == 1)
                )
            ).one()
            assert user.email == "alice@example.com"
            assert user.password_hash == "$2b$12$abcdefghijklmnopqrstuv"
            assert (
                await connection.execute(
                    select(User.__table__).where(User.__table__.c.id == 2)
                )
            ).first() is None

            txn = (
                await connection.execute(
                    select(Transaction.__table__).where(Transaction.__table__.c.id == 1)
                )
            ).one()
            assert txn.type == "expense"
            assert txn.category == "餐饮"
            assert txn.note == "午餐"
            assert txn.occurred_at == datetime(2026, 8, 1)
            assert Decimal(str(txn.amount)) == Decimal("88.50")

            budget = (
                await connection.execute(
                    select(Budget.__table__).where(Budget.__table__.c.id == 1)
                )
            ).one()
            assert budget.period == "monthly"
            assert Decimal(str(budget.amount)) == Decimal("500.00")

            goal = (
                await connection.execute(
                    select(Goal.__table__).where(Goal.__table__.c.id == 1)
                )
            ).one()
            assert goal.target_date == date(2026, 12, 31)
            assert (
                await connection.execute(
                    select(Goal.__table__).where(Goal.__table__.c.id == 2)
                )
            ).first() is None

            asset = (
                await connection.execute(
                    select(Asset.__table__).where(Asset.__table__.c.id == 1)
                )
            ).one()
            assert asset.type == "bank_deposit"
            assert Decimal(str(asset.amount)) == Decimal("12345.67")
    finally:
        await source.dispose()
        await target.dispose()


async def test_migrate_is_idempotent(tmp_path) -> None:
    source, target = await _make_engines(tmp_path)
    await _seed_source(source)
    try:
        await migrate(source, target)
        second = await migrate(source, target)

        for table, counts in second.items():
            assert counts["migrated"] == 0, table
            assert counts["failed"] == 0, table
    finally:
        await source.dispose()
        await target.dispose()


async def test_migrate_dry_run_writes_nothing(tmp_path) -> None:
    source, target = await _make_engines(tmp_path)
    await _seed_source(source)
    try:
        report = await migrate(source, target, dry_run=True)

        assert report["users"]["migrated"] == 1
        async with target.connect() as connection:
            count = (
                await connection.execute(text("SELECT COUNT(*) FROM users"))
            ).scalar()
            assert count == 0
    finally:
        await source.dispose()
        await target.dispose()


def test_to_async_url_converts_drivers() -> None:
    assert to_async_url("mysql://u:p@h:3306/db") == "mysql+asyncmy://u:p@h:3306/db"
    assert to_async_url("mysql+pymysql://u:p@h/db") == "mysql+asyncmy://u:p@h/db"
    assert to_async_url("sqlite:///foo.db") == "sqlite+aiosqlite:///foo.db"
    assert to_async_url("sqlite+aiosqlite:///foo.db") == "sqlite+aiosqlite:///foo.db"
    assert to_async_url("mysql+asyncmy://u:p@h/db") == "mysql+asyncmy://u:p@h/db"
