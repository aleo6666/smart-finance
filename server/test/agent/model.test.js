import test from 'node:test'
import assert from 'node:assert/strict'
import { createFinanceModel } from '../../src/agent/model.js'

test('finance model always uses temperature 0.1 with the configured public API', () => {
  const model = createFinanceModel({
    baseUrl: 'https://llm.example/v1',
    apiKey: 'test-key',
    model: 'test-model',
    maxRetries: 2,
    timeout: 12_000,
    temperature: 0.9
  })

  assert.equal(model.temperature, 0.1)
  assert.equal(model.model, 'test-model')
  assert.equal(model.caller.maxRetries, 2)
  assert.equal(model.timeout, 12_000)
  assert.equal(model.clientConfig.baseURL, 'https://llm.example/v1')
})

test('finance model rejects incomplete or unsafe configuration without exposing a key', () => {
  for (const input of [
    { baseUrl: 'file:///local/model', apiKey: 'secret-key', model: 'm', maxRetries: 1, timeout: 1000 },
    { baseUrl: 'https://llm.example/v1', apiKey: '', model: 'm', maxRetries: 1, timeout: 1000 },
    { baseUrl: 'https://llm.example/v1', apiKey: 'secret-key', model: '', maxRetries: 1, timeout: 1000 },
    { baseUrl: 'https://llm.example/v1', apiKey: 'secret-key', model: 'm', maxRetries: -1, timeout: 1000 },
    { baseUrl: 'https://llm.example/v1', apiKey: 'secret-key', model: 'm', maxRetries: 1, timeout: 0 }
  ]) {
    assert.throws(
      () => createFinanceModel(input),
      error => !error.message.includes('secret-key')
    )
  }
})
