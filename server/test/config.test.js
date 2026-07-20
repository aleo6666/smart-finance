import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

test('loadConfig returns MySQL Redis and vector defaults', () => {
  const config = loadConfig({})

  assert.equal(config.db.host, 'localhost')
  assert.equal(config.db.port, 3306)
  assert.equal(config.db.name, 'smart_finance')
  assert.equal(config.redis.host, 'localhost')
  assert.equal(config.redis.port, 6379)
  assert.equal(config.vector.url, 'http://localhost:6333')
  assert.equal(config.vector.collection, 'finance_records')
  assert.equal(config.ai.embeddingModel, 'text-embedding-3-small')
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

test('loadConfig returns local LM Studio and RAG defaults', () => {
  const loaded = loadConfig({})
  assert.deepEqual(loaded.lmStudio, {
    baseUrl: 'http://127.0.0.1:1234/v1',
    chatModel: 'qwen3.6-35b-a3b',
    embeddingModel: 'text-embedding-nomic-embed-text-v1.5',
    embeddingTimeoutMs: 10000,
    chatTimeoutMs: 120000,
    listModelsTimeoutMs: 5000
  })
  assert.deepEqual(loaded.rag, {
    enabled: true,
    collection: 'finance_records_nomic_v1',
    topK: 5,
    maxContextChars: 6000
  })
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
