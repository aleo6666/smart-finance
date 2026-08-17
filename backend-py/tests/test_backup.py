"""备份脚本单元测试：目录创建、mysqldump 子进程 mock、保留策略。"""

import os
from datetime import datetime

from app.core.config import Settings
from app.services.backup import (
    backup_mysql,
    cleanup_old_backups,
    parse_mysql_url,
    run_backup,
    upload_to_s3,
)

FIXED_NOW = datetime(2026, 8, 18, 4, 0, 0)


def _settings(tmp_path) -> Settings:
    return Settings(
        database_url="mysql+asyncmy://user:secret@localhost:3306/smart_finance",
        qdrant_url="http://localhost:6333",
        jwt_secret="x" * 32,
        backup_dir=str(tmp_path),
        backup_retention=3,
        s3_endpoint_url=None,
        s3_access_key=None,
        s3_secret_key=None,
        s3_bucket=None,
    )


def test_parse_mysql_url_strips_async_driver() -> None:
    connection = parse_mysql_url(
        "mysql+asyncmy://user:secret@db.example.com:3307/my_finance"
    )

    assert connection == {
        "host": "db.example.com",
        "port": 3307,
        "user": "user",
        "password": "secret",
        "database": "my_finance",
    }


def test_backup_mysql_creates_dir_and_archive(tmp_path) -> None:
    commands = []

    def fake_run(command, stdout=None, check=True):
        commands.append(command)
        stdout.write(b"-- fake mysqldump output\n")

    archive = backup_mysql(
        tmp_path,
        "mysql+asyncmy://user:secret@localhost:3306/smart_finance",
        run_command=fake_run,
        now=FIXED_NOW,
    )

    assert archive.name == "mysql-smart_finance-20260818-040000.tar.gz"
    assert archive.exists()
    # 中间 .sql 已清理
    assert not (tmp_path / "mysql-smart_finance-20260818-040000.sql").exists()
    assert len(commands) == 1
    command = commands[0]
    assert command[0] == "mysqldump"
    assert "--user=user" in command
    assert "smart_finance" in command


def test_cleanup_old_backups_keeps_most_recent(tmp_path) -> None:
    for index in range(5):
        path = tmp_path / f"backup-{index}.tar.gz"
        path.write_bytes(b"x")
        os.utime(path, (index + 1, index + 1))

    removed = cleanup_old_backups(tmp_path, keep=2)

    assert sorted(path.name for path in removed) == [
        "backup-0.tar.gz",
        "backup-1.tar.gz",
        "backup-2.tar.gz",
    ]
    assert sorted(path.name for path in tmp_path.glob("*.tar.gz")) == [
        "backup-3.tar.gz",
        "backup-4.tar.gz",
    ]


def test_run_backup_db_skips_qdrant(tmp_path) -> None:
    commands = []

    def fake_run(command, stdout=None, check=True):
        commands.append(command)
        stdout.write(b"-- fake mysqldump output\n")

    outputs = run_backup(
        "db", _settings(tmp_path), run_command=fake_run, now=FIXED_NOW
    )

    assert len(outputs) == 1
    assert outputs[0].name == "mysql-smart_finance-20260818-040000.tar.gz"
    assert outputs[0].exists()
    assert commands and commands[0][0] == "mysqldump"


def test_upload_to_s3_skips_when_unconfigured(tmp_path) -> None:
    path = tmp_path / "x.tar.gz"
    path.write_bytes(b"x")

    assert upload_to_s3(path, _settings(tmp_path)) is False
