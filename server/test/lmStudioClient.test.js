import test from 'node:test'
import assert from 'node:assert/strict'
import { createLmStudioClient } from '../src/services/lmStudioClient.js'

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test('embed calls the configured OpenAI-compatible endpoint', async () => {
  const calls = []
  const client = createLmStudioClient({
    settings: {
      baseUrl: 'http://lm/v1',
      embeddingModel: 'embed-model',
      chatModel: 'chat-model',
      embeddingTimeoutMs: 100,
      chatTimeoutMs: 100
    },
    fetchFn: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return response({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
    }
  })
  assert.deepEqual(await client.embed('午餐消费'), [0.1, 0.2, 0.3])
  assert.equal(calls[0].url, 'http://lm/v1/embeddings')
  assert.deepEqual(calls[0].body, { model: 'embed-model', input: '午餐消费' })
})

test('chat returns content and rejects malformed responses safely', async () => {
  const good = createLmStudioClient({
    settings: {
      baseUrl: 'http://lm/v1',
      embeddingModel: 'embed',
      chatModel: 'chat',
      embeddingTimeoutMs: 100,
      chatTimeoutMs: 100
    },
    fetchFn: async () => response({ choices: [{ message: { content: '建议减少外卖。' } }] })
  })
  assert.equal(await good.chat([{ role: 'user', content: '给我建议' }]), '建议减少外卖。')

  const bad = createLmStudioClient({
    settings: {
      baseUrl: 'http://lm/v1',
      embeddingModel: 'embed',
      chatModel: 'chat',
      embeddingTimeoutMs: 100,
      chatTimeoutMs: 100
    },
    fetchFn: async () => response({ choices: [] })
  })
  await assert.rejects(bad.chat([]), /LM Studio 返回格式无效/)
})

test('listModels returns model ids', async () => {
  const client = createLmStudioClient({
    settings: {
      baseUrl: 'http://lm/v1',
      embeddingModel: 'embed-model',
      chatModel: 'chat-model',
      embeddingTimeoutMs: 100,
      chatTimeoutMs: 100
    },
    fetchFn: async () => response({ data: [{ id: 'model-a' }, { id: 'model-b' }] })
  })
  assert.deepEqual(await client.listModels(), ['model-a', 'model-b'])
})

test('aborted timeout returns LmStudioError without response body or prompt content in message', async () => {
  const client = createLmStudioClient({
    settings: {
      baseUrl: 'http://lm/v1',
      embeddingModel: 'embed-model',
      chatModel: 'chat-model',
      embeddingTimeoutMs: 1,
      chatTimeoutMs: 1
    },
    fetchFn: async (_url, options) => {
      // Simulate a fetch that never resolves, causing AbortController timeout
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new DOMException('The operation was aborted', 'AbortError')
          reject(err)
        })
      })
    }
  })
  await assert.rejects(
    client.chat([{ role: 'user', content: '敏感内容，不应出现在错误消息中' }]),
    (err) => {
      // Verify it's an LmStudioError
      assert.equal(err.name, 'LmStudioError')
      // Verify the error message does NOT contain the prompt content
      assert.ok(!err.message.includes('敏感内容，不应出现在错误消息中'))
      // Verify the error message does NOT contain response bodies
      return true
    }
  )
})
