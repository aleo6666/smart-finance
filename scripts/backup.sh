#!/bin/bash
# Smart Finance - 每日备份
# 用法: ./scripts/backup.sh
# 放 crontab: 0 3 * * * /opt/smart-finance/scripts/backup.sh >> /var/log/sf-backup.log 2>&1

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="/opt/backups/smart-finance"
RETENTION_DAYS=7

mkdir -p "$BACKUP_DIR"
DATE=$(date +%Y%m%d-%H%M)
cd "$PROJECT_DIR"

# 加载环境变量
set -a
source .env.production 2>/dev/null || true
set +a

echo "=== Backup started: $DATE ==="

# 1. MySQL dump
echo "[1/4] Exporting MySQL..."
docker exec finance-mysql mysqldump \
  -u"${DB_USER:-finance}" \
  -p"${DB_PASSWORD}" \
  --single-transaction \
  --quick \
  "${DB_NAME:-smart_finance}" \
  | gzip > "$BACKUP_DIR/mysql-${DATE}.sql.gz"
echo "  -> mysql-${DATE}.sql.gz ($(du -h "$BACKUP_DIR/mysql-${DATE}.sql.gz" | cut -f1))"

# 2. 打包上传文件
echo "[2/4] Backing up uploads..."
tar czf "$BACKUP_DIR/uploads-${DATE}.tar.gz" \
  -C /var/lib/docker/volumes/smartfinance_backend_uploads/_data . 2>/dev/null || \
  echo "  (no uploads or volume not found — skipping)"
echo "  -> uploads-${DATE}.tar.gz"

# 3. Qdrant 快照（如果 RAG 启用）
echo "[3/4] Qdrant snapshot..."
COLLECTION="${RAG_COLLECTION:-finance_records_prod_v1}"
docker exec finance-qdrant sh -c "curl -s -X POST http://localhost:6333/collections/${COLLECTION}/snapshots" 2>/dev/null && \
  echo "  -> snapshot created" || \
  echo "  -> skipped (Qdrant not available)"

# 4. 清理旧备份
echo "[4/4] Cleaning backups older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -type f -mtime +${RETENTION_DAYS} -delete
echo "  -> done"

echo "=== Backup complete: $(date) ==="
