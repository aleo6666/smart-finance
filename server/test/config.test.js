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
