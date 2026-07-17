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
