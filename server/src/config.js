function numberFromEnv(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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
    auth: {
      jwtSecret: env.JWT_SECRET || 'dev-secret-change-me'
    }
  }
}

const config = loadConfig()

export default config
