#!/bin/sh
# 一键生成 .env.production（使用随机密码）
# 使用方法: bash scripts/gen-env-prod.sh

cat > .env.production << INNEREOF
DB_NAME=smart_finance
DB_USER=finance
DB_PASSWORD=$(openssl rand -base64 24)
DB_ROOT_PASSWORD=$(openssl rand -base64 24)

REDIS_HOST=redis
REDIS_PORT=6379

JWT_SECRET=$(openssl rand -base64 48)

VECTOR_DB_URL=http://qdrant:6333

LM_STUDIO_BASE_URL=https://api.deepseek.com/v1
LM_STUDIO_API_KEY=<填写你的 DeepSeek API Key>
LM_STUDIO_CHAT_MODEL=deepseek-v4-pro

LM_STUDIO_EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LM_STUDIO_EMBEDDING_API_KEY=<填写你的智谱 API Key>
LM_STUDIO_EMBEDDING_MODEL=embedding-3

RAG_ENABLED=true
RAG_COLLECTION=finance_records_prod_v1
RAG_TOP_K=5
RAG_MAX_CONTEXT_CHARS=6000
INNEREOF
echo "✅ .env.production created (edit API keys before deploying!)"
