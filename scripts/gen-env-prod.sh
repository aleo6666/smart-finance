#!/bin/sh
# 一键生成 .env.production
# 使用方法: bash scripts/gen-env-prod.sh

cat > .env.production << 'INNEREOF'
DB_NAME=smart_finance
DB_USER=finance
DB_PASSWORD=V1jyZLjZGb9HTipXy+G+EAl3zBvRRJ0L
DB_ROOT_PASSWORD=tzkyTgFEdFI6kvlQoq9SOb4zj5PLO4pl

REDIS_HOST=redis
REDIS_PORT=6379

JWT_SECRET=gafRFHm09Z+bHqlF6Umhls8lmKMR9PW5XaG+tWeIJurfQ80cYUv/aBZzSrZAGsAg

VECTOR_DB_URL=http://qdrant:6333

LM_STUDIO_BASE_URL=https://api.deepseek.com/v1
LM_STUDIO_API_KEY=sk-4ae47a37d99845c597e7b8969c0d6c90
LM_STUDIO_CHAT_MODEL=deepseek-chat

LM_STUDIO_EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LM_STUDIO_EMBEDDING_API_KEY=07c21360aa5e4d6899f1e5fbd4ba53cd.xx5nQvKIB4NnwBy6
LM_STUDIO_EMBEDDING_MODEL=embedding-3

RAG_ENABLED=true
RAG_COLLECTION=finance_records_prod_v1
RAG_TOP_K=5
RAG_MAX_CONTEXT_CHARS=6000
INNEREOF
echo "✅ .env.production created"
