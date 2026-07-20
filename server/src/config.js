function numberFromEnv(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '')
}

export function loadConfig(env = process.env) {
  return {
    server: {
      nodeEnv: env.NODE_ENV || 'development',
      port: numberFromEnv(env.PORT, 3000),
      uploadsDir: env.UPLOADS_DIR || './uploads'
    },
    db: {
      host: env.DB_HOST || 'localhost',
      port: numberFromEnv(env.DB_PORT, 3306),
      name: env.DB_NAME || 'smart_finance',
      user: env.DB_USER || 'finance',
      password: env.DB_PASSWORD || 'FinancePass2026!'
    },
    redis: {
      host: env.REDIS_HOST || 'localhost',
      port: numberFromEnv(env.REDIS_PORT, 6379),
      password: env.REDIS_PASSWORD || ''
    },
    vector: {
      url: env.VECTOR_DB_URL || 'http://localhost:6333',
      collection: env.VECTOR_COLLECTION || 'finance_records'
    },
    ai: {
      openaiApiKey: env.OPENAI_API_KEY || '',
      embeddingModel: env.EMBEDDING_MODEL || 'text-embedding-3-small',
      zhipuApiKey: env.ZHIPU_API_KEY || '',
      anthropicApiKey: env.ANTHROPIC_API_KEY || ''
    },
    lmStudio: {
      baseUrl: trimTrailingSlash(env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234/v1'),
      chatModel: env.LM_STUDIO_CHAT_MODEL || 'qwen3.6-35b-a3b',
      embeddingModel: env.LM_STUDIO_EMBEDDING_MODEL || 'text-embedding-nomic-embed-text-v1.5',
      embeddingTimeoutMs: boundedNumber(env.LM_STUDIO_EMBEDDING_TIMEOUT_MS, 10000, 1000, 60000),
      chatTimeoutMs: boundedNumber(env.LM_STUDIO_CHAT_TIMEOUT_MS, 120000, 5000, 300000),
      listModelsTimeoutMs: boundedNumber(env.LM_STUDIO_LIST_MODELS_TIMEOUT_MS, 5000, 1000, 30000)
    },
    rag: {
      enabled: env.RAG_ENABLED !== 'false',
      collection: env.RAG_COLLECTION || 'finance_records_nomic_v1',
      topK: boundedNumber(env.RAG_TOP_K, 5, 1, 20),
      maxContextChars: boundedNumber(env.RAG_MAX_CONTEXT_CHARS, 6000, 1000, 20000)
    },
    auth: {
      jwtSecret: env.JWT_SECRET || 'dev-secret-change-me'
    }
  }
}

const config = loadConfig()

export default config
