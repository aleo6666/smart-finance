"""备份脚本（可手动执行，亦被 APScheduler 调用同一备份例程）。

用法::

    python scripts/backup.py --full   # MySQL + Qdrant
    python scripts/backup.py --db     # 仅 MySQL
    python scripts/backup.py --qdrant # 仅 Qdrant
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import get_settings
from app.services.backup import run_backup


def main() -> int:
    parser = argparse.ArgumentParser(description="Smart Finance 数据备份")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--full", action="store_true", help="MySQL + Qdrant 全量备份")
    group.add_argument("--db", action="store_true", help="仅 MySQL 全量导出")
    group.add_argument("--qdrant", action="store_true", help="仅 Qdrant 集合快照")
    args = parser.parse_args()

    kind = "full" if args.full else "db" if args.db else "qdrant"
    settings = get_settings()
    outputs = run_backup(kind, settings)
    for path in outputs:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
