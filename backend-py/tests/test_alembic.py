import os
from pathlib import Path
import subprocess
import sys


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def test_alembic_environment_runs_with_async_sqlite(tmp_path: Path) -> None:
    environment = os.environ.copy()
    database_path = (tmp_path / "alembic-smoke.db").as_posix()
    environment["DATABASE_URL"] = f"sqlite+aiosqlite:///{database_path}"
    environment["QDRANT_URL"] = "http://127.0.0.1:6333"
    environment["JWT_SECRET"] = "test-only-jwt-secret-with-32-characters"

    result = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", "current"],
        cwd=BACKEND_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
