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

function booleanFromEnv(value, fallback = false) {
  if (value === undefined) return fallback
  return String(value).toLowerCase() === 'true'
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
    agent: {
      enabled: booleanFromEnv(env.ENABLE_LANGGRAPH_AGENT),
      fourLayerMemory: booleanFromEnv(env.ENABLE_FOUR_LAYER_MEMORY),
      adminSqlEnabled: booleanFromEnv(env.ENABLE_ADMIN_SQL_AGENT),
      paddleOcrEnabled: booleanFromEnv(env.ENABLE_PADDLE_OCR),
      qdrantKnowledgeEnabled: booleanFromEnv(env.ENABLE_QDRANT_KNOWLEDGE),
      billVectorWriteEnabled: booleanFromEnv(env.ENABLE_BILL_VECTOR_WRITE),
      rolloutPercent: boundedNumber(env.LANGGRAPH_ROLLOUT_PERCENT, 0, 0, 100),
      maxToolCalls: boundedNumber(env.AGENT_MAX_TOOL_CALLS, 5, 1, 12),
      recursionLimit: boundedNumber(env.AGENT_GRAPH_RECURSION_LIMIT, 12, 4, 30),
      requestTimeoutMs: boundedNumber(env.AGENT_REQUEST_TIMEOUT_MS, 120000, 5000, 300000),
      networkRetryCount: boundedNumber(env.AGENT_NETWORK_RETRY_COUNT, 2, 0, 2),
      datasetTtlSeconds: boundedNumber(env.AGENT_DATASET_TTL_SECONDS, 300, 30, 1800),
      confirmationTtlSeconds: boundedNumber(env.AGENT_CONFIRMATION_TTL_SECONDS, 1800, 60, 86400),
      temperature: 0.1
    },
    memory: {
      windowMaxMessages: boundedNumber(env.MEMORY_WINDOW_MAX_MESSAGES, 10, 2, 30),
      windowMaxTokens: boundedNumber(env.MEMORY_WINDOW_MAX_TOKENS, 4000, 500, 12000),
      sessionTtlSeconds: boundedNumber(env.MEMORY_SESSION_TTL_SECONDS, 1800, 60, 86400),
      summaryTriggerMessages: boundedNumber(env.MEMORY_SUMMARY_TRIGGER_MESSAGES, 12, 4, 50),
      summaryRetentionDays: boundedNumber(env.MEMORY_SUMMARY_RETENTION_DAYS, 30, 1, 365)
    },
    adminSql: {
      host: env.ADMIN_SQL_HOST || env.DB_HOST || 'localhost',
      port: numberFromEnv(env.ADMIN_SQL_PORT || env.DB_PORT, 3306),
      name: env.ADMIN_SQL_DB_NAME || env.DB_NAME || 'smart_finance',
      user: env.ADMIN_SQL_DB_USER || '',
      password: env.ADMIN_SQL_DB_PASSWORD || '',
      maxRows: boundedNumber(env.ADMIN_SQL_MAX_ROWS, 200, 1, 1000),
      timeoutMs: boundedNumber(env.ADMIN_SQL_TIMEOUT_MS, 3000, 500, 10000)
    },
    paddleOcr: {
      accessToken: env.PADDLEOCR_ACCESS_TOKEN || '',
      requestTimeoutMs: boundedNumber(env.PADDLEOCR_REQUEST_TIMEOUT_MS, 300000, 5000, 600000),
      pollTimeoutMs: boundedNumber(env.PADDLEOCR_POLL_TIMEOUT_MS, 600000, 10000, 900000)
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
