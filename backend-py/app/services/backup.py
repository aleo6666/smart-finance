"""备份：MySQL 全量导出 + Qdrant 集合快照 + 保留策略 + 可选 S3 上传.

所有外部依赖（mysqldump / Qdrant / boto3）都可注入或懒加载，便于测试与
在未配置时优雅跳过。备份只读，不依赖云厂商专有服务（MinIO/自建 S3 均可）。
"""

from __future__ import annotations

import logging
import subprocess
import tarfile
from collections.abc import Callable, Sequence
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

QDRANT_COLLECTIONS = ("knowledge_chunks_v1", "transactions_v1")


def _timestamp(now: datetime | None = None) -> str:
    return (now or datetime.now()).strftime("%Y%m%d-%H%M%S")


def parse_mysql_url(database_url: str) -> dict:
    parsed = urlparse(database_url.replace("+asyncmy", ""))
    return {
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or 3306,
        "user": parsed.username or "",
        "password": parsed.password or "",
        "database": parsed.path.lstrip("/"),
    }


def _compress_to_targz(path: Path) -> Path:
    archive = path.with_suffix(".tar.gz")
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(path, arcname=path.name)
    path.unlink()
    return archive


def backup_mysql(
    backup_dir: Path,
    database_url: str,
    *,
    run_command: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    now: datetime | None = None,
) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    connection = parse_mysql_url(database_url)
    if not connection["database"]:
        raise ValueError("DATABASE_URL 缺少数据库名，无法备份")
    dump_path = backup_dir / f"mysql-{connection['database']}-{_timestamp(now)}.sql"
    command = [
        "mysqldump",
        f"--host={connection['host']}",
        f"--port={connection['port']}",
        f"--user={connection['user']}",
        f"--password={connection['password']}",
        connection["database"],
    ]
    with open(dump_path, "wb") as handle:
        run_command(command, stdout=handle, check=True)
    return _compress_to_targz(dump_path)


def list_qdrant_collections(qdrant_url: str, client=None) -> list[str]:
    import httpx

    http = client or httpx.Client(base_url=qdrant_url.rstrip("/"))
    response = http.get("/collections")
    response.raise_for_status()
    payload = response.json()
    collections = payload.get("result", {}).get("collections", [])
    return [item["name"] for item in collections]


def backup_qdrant(
    backup_dir: Path,
    qdrant_url: str,
    collections: Sequence[str],
    *,
    client=None,
    now: datetime | None = None,
) -> list[Path]:
    import httpx

    backup_dir.mkdir(parents=True, exist_ok=True)
    http = client or httpx.Client(base_url=qdrant_url.rstrip("/"))
    outputs: list[Path] = []
    for collection in collections:
        try:
            response = http.post(f"/collections/{collection}/snapshots")
            response.raise_for_status()
            snapshot_name = response.json()["result"]["name"]
            data = http.get(
                f"/collections/{collection}/snapshots/{snapshot_name}"
            ).content
            snapshot_path = (
                backup_dir / f"qdrant-{collection}-{_timestamp(now)}.snapshot"
            )
            snapshot_path.write_bytes(data)
            outputs.append(_compress_to_targz(snapshot_path))
        except Exception as exc:  # 单个集合失败不阻断其它集合
            logger.warning("Qdrant 集合 %s 快照失败: %s", collection, exc)
    return outputs


def cleanup_old_backups(backup_dir: Path, keep: int) -> list[Path]:
    """按修改时间保留最近 ``keep`` 份 tar.gz，返回被删除的文件列表。"""
    files = sorted(
        backup_dir.glob("*.tar.gz"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    removed = files[keep:]
    for path in removed:
        path.unlink()
    return removed


def upload_to_s3(path: Path, settings) -> bool:
    """上传到 S3 兼容对象存储；未配置或未安装 boto3 时跳过。"""
    if not all(
        (
            settings.s3_endpoint_url,
            settings.s3_access_key,
            settings.s3_secret_key,
            settings.s3_bucket,
        )
    ):
        return False
    try:
        import boto3
    except ImportError:
        logger.warning("boto3 未安装，跳过 S3 上传")
        return False
    try:
        client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
        )
        client.upload_file(
            str(path), settings.s3_bucket, f"backups/{path.name}"
        )
        return True
    except Exception:
        logger.warning("S3 上传失败: %s", path.name, exc_info=True)
        return False


def run_backup(
    kind: str,
    settings,
    *,
    run_command: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    now: datetime | None = None,
) -> list[Path]:
    """执行备份。``kind`` 取 ``full`` / ``db`` / ``qdrant``。"""
    backup_dir = Path(settings.backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    outputs: list[Path] = []

    if kind in ("full", "db"):
        outputs.append(
            backup_mysql(
                backup_dir, settings.database_url, run_command=run_command, now=now
            )
        )

    if kind in ("full", "qdrant"):
        try:
            collections = list_qdrant_collections(settings.qdrant_url)
        except Exception:
            collections = list(QDRANT_COLLECTIONS)
        outputs.extend(
            backup_qdrant(backup_dir, settings.qdrant_url, collections, now=now)
        )

    cleanup_old_backups(backup_dir, settings.backup_retention)

    for path in outputs:
        upload_to_s3(path, settings)
    return outputs
