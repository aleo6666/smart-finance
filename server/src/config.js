import dotenv from 'dotenv'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '..', '.env') })

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
      password: env.DB_PASSWORD || 'change-me-in-production'
    },
    redis: {
      host: env.REDIS_HOST || 'localhost',
      port: numberFromEnv(env.REDIS_PORT, 6379),
      password: env.REDIS_PASSWORD || ''
    },
    vector: {
      url: env.VECTOR_DB_URL || 'http://localhost:6333',
      apiKey: env.VECTOR_DB_API_KEY || '',
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
      apiKey: env.LM_STUDIO_API_KEY || '',
      embeddingBaseUrl: trimTrailingSlash(env.LM_STUDIO_EMBEDDING_BASE_URL || ''),
      embeddingApiKey: env.LM_STUDIO_EMBEDDING_API_KEY || '',
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
      jwtSecret: env.JWT_SECRET || undefined
    },
    wechat: {
      miniAppId: env.WECHAT_MINI_APPID || '',
      miniSecret: env.WECHAT_MINI_SECRET || '',
      mpAppId: env.WECHAT_MP_APPID || '',
      mpSecret: env.WECHAT_MP_SECRET || ''
    }
  }
}

const config = loadConfig()

// 生产环境配置校验
if (config.server.nodeEnv === 'production') {
  if (!config.auth.jwtSecret) {
    throw new Error('JWT_SECRET is required in production')
  }
  // 禁止使用默认占位符或过短的JWT密钥
  if (config.auth.jwtSecret.includes('change-me') || config.auth.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be changed in production to a strong random string of at least 32 characters')
  }
  if (config.db.password === 'change-me-in-production') {
    throw new Error('DB_PASSWORD must be set in production to a strong custom password, cannot use default value')
  }
}

export default config
