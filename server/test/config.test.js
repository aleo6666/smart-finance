import test from 'node:test'
import assert from 'node:assert/strict'

const previousNodeEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'test'
const { loadConfig } = await import('../src/config.js?config-test')
if (previousNodeEnv == null) delete process.env.NODE_ENV
else process.env.NODE_ENV = previousNodeEnv

test('loadConfig returns the complete default config', () => {
  assert.deepEqual(loadConfig({}), {
    server: {
      nodeEnv: 'development',
      port: 3000,
      uploadsDir: './uploads'
    },
    db: {
      host: 'localhost',
      port: 3306,
      name: 'smart_finance',
      user: 'finance',
      password: 'change-me-in-production'
    },
    redis: {
      host: 'localhost',
      port: 6379,
      password: ''
    },
    vector: {
      url: 'http://localhost:6333',
      apiKey: '',
      collection: 'finance_records'
    },
    ai: {
      openaiApiKey: '',
      embeddingModel: 'text-embedding-3-small',
      zhipuApiKey: '',
      anthropicApiKey: ''
    },
    lmStudio: {
      baseUrl: 'http://127.0.0.1:1234/v1',
      chatModel: 'qwen3.6-35b-a3b',
      embeddingModel: 'text-embedding-nomic-embed-text-v1.5',
      apiKey: '',
      embeddingBaseUrl: '',
      embeddingApiKey: '',
      embeddingTimeoutMs: 10000,
      chatTimeoutMs: 120000,
      listModelsTimeoutMs: 5000
    },
    rag: {
      enabled: true,
      collection: 'finance_records_nomic_v1',
      topK: 5,
      maxContextChars: 6000
    },
    agent: {
      enabled: false,
      fourLayerMemory: false,
      adminSqlEnabled: false,
      paddleOcrEnabled: false,
      qdrantKnowledgeEnabled: false,
      billVectorWriteEnabled: false,
      rolloutPercent: 0,
      maxToolCalls: 5,
      recursionLimit: 12,
      requestTimeoutMs: 120000,
      networkRetryCount: 2,
      datasetTtlSeconds: 300,
      confirmationTtlSeconds: 1800,
      temperature: 0.1
    },
    memory: {
      windowMaxMessages: 10,
      windowMaxTokens: 4000,
      sessionTtlSeconds: 1800,
      summaryTriggerMessages: 12,
      summaryRetentionDays: 30
    },
    adminSql: {
      host: 'localhost',
      port: 3306,
      name: 'smart_finance',
      user: '',
      password: '',
      maxRows: 200,
      timeoutMs: 3000
    },
    paddleOcr: {
      accessToken: '',
      requestTimeoutMs: 300000,
      pollTimeoutMs: 600000
    },
    auth: {
      jwtSecret: undefined
    },
    wechat: {
      miniAppId: '',
      miniSecret: '',
      mpAppId: '',
      mpSecret: ''
    }
  })
})

test('loadConfig converts numeric environment values', () => {
  const config = loadConfig({
    PORT: '3100',
    DB_PORT: '3307',
    REDIS_PORT: '6380'
  })

  assert.equal(config.server.port, 3100)
  assert.equal(config.db.port, 3307)
  assert.equal(config.redis.port, 6380)
})

test('loadConfig reads LM Studio and bounded RAG overrides', () => {
  const loaded = loadConfig({
    LM_STUDIO_BASE_URL: 'http://host.docker.internal:1234/v1/',
    LM_STUDIO_CHAT_MODEL: 'local-chat',
    LM_STUDIO_EMBEDDING_MODEL: 'local-embed',
    RAG_ENABLED: 'false',
    RAG_TOP_K: '99',
    RAG_MAX_CONTEXT_CHARS: '999999'
  })
  assert.equal(loaded.lmStudio.baseUrl, 'http://host.docker.internal:1234/v1')
  assert.equal(loaded.rag.enabled, false)
  assert.equal(loaded.rag.topK, 20)
  assert.equal(loaded.rag.maxContextChars, 20000)
})

test('agent flags only enable for case-insensitive true values', () => {
  const loaded = loadConfig({
    ENABLE_LANGGRAPH_AGENT: 'TRUE',
    ENABLE_FOUR_LAYER_MEMORY: 'true',
    ENABLE_ADMIN_SQL_AGENT: '1',
    ENABLE_PADDLE_OCR: 'yes',
    ENABLE_QDRANT_KNOWLEDGE: 'false',
    ENABLE_BILL_VECTOR_WRITE: ''
  })

  assert.equal(loaded.agent.enabled, true)
  assert.equal(loaded.agent.fourLayerMemory, true)
  assert.equal(loaded.agent.adminSqlEnabled, false)
  assert.equal(loaded.agent.paddleOcrEnabled, false)
  assert.equal(loaded.agent.qdrantKnowledgeEnabled, false)
  assert.equal(loaded.agent.billVectorWriteEnabled, false)
})

test('agent, memory, admin SQL, and PaddleOCR numeric settings are bounded', () => {
  const loaded = loadConfig({
    AGENT_MAX_TOOL_CALLS: '99',
    AGENT_GRAPH_RECURSION_LIMIT: '1',
    LANGGRAPH_ROLLOUT_PERCENT: '150',
    AGENT_REQUEST_TIMEOUT_MS: '1',
    AGENT_NETWORK_RETRY_COUNT: '99',
    AGENT_DATASET_TTL_SECONDS: '1',
    AGENT_CONFIRMATION_TTL_SECONDS: '999999',
    MEMORY_WINDOW_MAX_MESSAGES: '1',
    MEMORY_WINDOW_MAX_TOKENS: '999999',
    MEMORY_SESSION_TTL_SECONDS: '1',
    MEMORY_SUMMARY_TRIGGER_MESSAGES: '99',
    MEMORY_SUMMARY_RETENTION_DAYS: '0',
    ADMIN_SQL_MAX_ROWS: '9999',
    ADMIN_SQL_TIMEOUT_MS: '1',
    PADDLEOCR_REQUEST_TIMEOUT_MS: '1',
    PADDLEOCR_POLL_TIMEOUT_MS: '999999'
  })

  assert.equal(loaded.agent.maxToolCalls, 12)
  assert.equal(loaded.agent.recursionLimit, 4)
  assert.equal(loaded.agent.rolloutPercent, 100)
  assert.equal(loaded.agent.requestTimeoutMs, 5000)
  assert.equal(loaded.agent.networkRetryCount, 2)
  assert.equal(loaded.agent.datasetTtlSeconds, 30)
  assert.equal(loaded.agent.confirmationTtlSeconds, 86400)
  assert.equal(loaded.agent.temperature, 0.1)
  assert.equal(loaded.memory.windowMaxMessages, 2)
  assert.equal(loaded.memory.windowMaxTokens, 12000)
  assert.equal(loaded.memory.sessionTtlSeconds, 60)
  assert.equal(loaded.memory.summaryTriggerMessages, 50)
  assert.equal(loaded.memory.summaryRetentionDays, 1)
  assert.equal(loaded.adminSql.maxRows, 1000)
  assert.equal(loaded.adminSql.timeoutMs, 500)
  assert.equal(loaded.paddleOcr.requestTimeoutMs, 5000)
  assert.equal(loaded.paddleOcr.pollTimeoutMs, 900000)
})

test('agent integer settings accept zero and reject blank, malformed, or fractional values', () => {
  assert.equal(loadConfig({ AGENT_NETWORK_RETRY_COUNT: '0' }).agent.networkRetryCount, 0)
  assert.equal(loadConfig({ AGENT_NETWORK_RETRY_COUNT: ' ' }).agent.networkRetryCount, 2)
  assert.equal(loadConfig({ AGENT_NETWORK_RETRY_COUNT: 'invalid' }).agent.networkRetryCount, 2)
  assert.equal(loadConfig({ AGENT_NETWORK_RETRY_COUNT: '1.5' }).agent.networkRetryCount, 2)
  assert.equal(loadConfig({ AGENT_MAX_TOOL_CALLS: '2.5' }).agent.maxToolCalls, 5)
})

test('admin SQL connection settings use database fallbacks and explicit overrides', () => {
  const fallback = loadConfig({
    DB_HOST: 'mysql',
    DB_PORT: '3307',
    DB_NAME: 'finance_test'
  })
  assert.equal(fallback.adminSql.host, 'mysql')
  assert.equal(fallback.adminSql.port, 3307)
  assert.equal(fallback.adminSql.name, 'finance_test')

  const overridden = loadConfig({
    DB_HOST: 'mysql',
    ADMIN_SQL_HOST: 'readonly-mysql',
    ADMIN_SQL_PORT: '3308',
    ADMIN_SQL_DB_NAME: 'finance_reporting',
    ADMIN_SQL_DB_USER: 'readonly',
    ADMIN_SQL_DB_PASSWORD: 'test-only'
  })
  assert.deepEqual(overridden.adminSql, {
    host: 'readonly-mysql',
    port: 3308,
    name: 'finance_reporting',
    user: 'readonly',
    password: 'test-only',
    maxRows: 200,
    timeoutMs: 3000
  })
})
