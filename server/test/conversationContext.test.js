import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendConversationMessage,
  buildContextSummary,
  clearConversationContext,
  getConversationContext
} from '../src/services/conversationContext.js'

function createMemoryCache({ failGet = false, failSet = false, failDelete = false } = {}) {
  const store = new Map()
  return {
    store,
    async get(key) {
      if (failGet) throw new Error('redis get failed')
      return store.get(key) || null
    },
    async set(key, value) {
      if (failSet) throw new Error('redis set failed')
      store.set(key, value)
    },
    async del(key) {
      if (failDelete) throw new Error('redis del failed')
      store.delete(key)
    }
  }
}

test('appendConversationMessage stores and reads recent messages', async () => {
  const cache = createMemoryCache()
  await appendConversationMessage('user-7', { role: 'user', content: '本月餐饮花了多少' }, { cache })
  await appendConversationMessage('user-7', { role: 'assistant', content: '我来查一下' }, { cache })

  const ctx = await getConversationContext('user-7', { cache })

  assert.equal(ctx.length, 2)
  assert.equal(ctx[0].role, 'user')
  assert.equal(ctx[0].content, '本月餐饮花了多少')
  assert.equal(ctx[1].role, 'assistant')
})

test('appendConversationMessage trims old messages into summary after limit', async () => {
  const cache = createMemoryCache()
  for (let i = 1; i <= 10; i += 1) {
    await appendConversationMessage('user-7', { role: 'user', content: `第${i}轮 餐饮 本月` }, { cache, maxMessages: 8 })
  }

  const ctx = await getConversationContext('user-7', { cache })

  assert.equal(ctx.length, 8)
  assert.equal(ctx[0].role, 'system')
  assert.match(ctx[0].content, /上文摘要/)
  assert.match(ctx[0].content, /餐饮/)
  assert.equal(ctx.at(-1).content, '第10轮 餐饮 本月')
})

test('buildContextSummary keeps finance keywords and shortens content', () => {
  const summary = buildContextSummary([
    { role: 'user', content: '本月餐饮花了多少' },
    { role: 'assistant', content: '找到 3 条餐饮记录' },
    { role: 'user', content: '再看看购物' }
  ])

  assert.match(summary, /本月/)
  assert.match(summary, /餐饮/)
  assert.match(summary, /购物/)
  assert.ok(summary.length <= 160)
})

test('conversationContext degrades to empty context when cache get fails', async () => {
  const cache = createMemoryCache({ failGet: true })
  const ctx = await getConversationContext('user-7', { cache })
  assert.deepEqual(ctx, [])
})

test('clearConversationContext removes context and ignores delete failures', async () => {
  const cache = createMemoryCache()
  await appendConversationMessage('user-7', { role: 'user', content: 'hello' }, { cache })
  await clearConversationContext('user-7', { cache })
  assert.deepEqual(await getConversationContext('user-7', { cache }), [])

  await clearConversationContext('user-8', { cache: createMemoryCache({ failDelete: true }) })
})
