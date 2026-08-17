import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def test_alembic_upgrade_head_creates_business_schema_in_sqlite(
    tmp_path: Path,
) -> None:
    environment = os.environ.copy()
    database_path = (tmp_path / "alembic-smoke.db").as_posix()
    environment["DATABASE_URL"] = f"sqlite+aiosqlite:///{database_path}"
    environment["QDRANT_URL"] = "http://127.0.0.1:6333"
    environment["JWT_SECRET"] = "test-only-jwt-secret-with-32-characters"

    result = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", "upgrade", "head"],
        cwd=BACKEND_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr

    with sqlite3.connect(database_path) as connection:
        table_names = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {
            "users",
            "ledgers",
            "transactions",
            "budgets",
            "goals",
            "assets",
            "liabilities",
            "user_profiles",
            "alembic_version",
        } <= table_names

        for table_name in (
            "ledgers",
            "transactions",
            "budgets",
            "goals",
            "assets",
            "liabilities",
            "user_profiles",
        ):
            index_names = [
                row[1]
                for row in connection.execute(
                    f'PRAGMA index_list("{table_name}")'
                )
            ]
            indexed_columns = {
                column[2]
                for index_name in index_names
                for column in connection.execute(
                    f'PRAGMA index_info("{index_name}")'
                )
            }
            assert "user_id" in indexed_columns

        transaction_columns = {
            row[1] for row in connection.execute('PRAGMA table_info("transactions")')
        }
        assert "income_source" in transaction_columns

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO transactions (
                    id, user_id, ledger_id, type, category, amount,
                    income_source, occurred_at
                ) VALUES (101, 1, 1, 'income', 'salary', 1, 'invalid', CURRENT_TIMESTAMP)
                """
            )

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO transactions (
                    id, user_id, ledger_id, type, category, amount,
                    income_source, occurred_at
                ) VALUES (102, 1, 1, 'expense', 'food', 1, 'salary', CURRENT_TIMESTAMP)
                """
            )

        revision = connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone()
        assert revision is not None
