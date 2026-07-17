# Smart Finance V3 第六阶段自然语言上下文记忆与历史账单检索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Chat 接入 Redis 短期上下文和 Qdrant 历史账单检索，让查询/建议类自然语言回复能结合用户历史记录，同时保持现有记账链路稳定。

**Architecture:** 新增 `conversationContext` 管理短期对话，新建 `chatMemory` 放置查询 hint 解析和本地增强回复，补全 `vectorMemory.retrieveSimilar()` 负责长期账单检索，最后在 `createChatRouter()` 中通过依赖注入接入这些能力。所有外部依赖失败时都降级为空上下文或空历史记录，不阻断 Chat 主流程。

**Tech Stack:** Node.js 22、Express、Redis/ioredis、Qdrant JS client、Node 内置 test、Docker Compose。

---

## 文件结构

- 新增 `server/src/services/conversationContext.js`：短期上下文读取、追加、摘要裁剪、清理。
- 新增 `server/test/conversationContext.test.js`：验证上下文追加/裁剪/降级。
- 新增 `server/src/services/chatMemory.js`：查询 hint 提取、历史记录聚合、增强回复生成。
- 新增 `server/test/chatMemory.test.js`：验证月份/分类解析、回复生成。
- 修改 `server/src/services/vectorMemory.js`：实现 `retrieveSimilar()`，包括 userId、month、category filter 和失败降级。
- 修改 `server/test/vectorMemory.test.js`：补充历史检索测试。
- 修改 `server/src/routes/chat.js`：接入短期上下文与长期检索，保持记账链路不变。
- 修改 `server/test/chatRoute.test.js`：补充 Chat 查询增强、未登录降级、记账后写上下文测试。

注意：当前工作区存在既有前端、DB、node_modules 等脏改动。实施时只 stage 上述第六阶段文件，不提交无关文件。

## Task 1: 短期上下文服务

**Files:**
- Create: `server/src/services/conversationContext.js`
- Test: `server/test/conversationContext.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/conversationContext.test.js`:

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/conversationContext.test.js
```

Expected: FAIL，错误包含 `Cannot find module '../src/services/conversationContext.js'`。

- [ ] **Step 3: 实现 conversationContext**

Create `server/src/services/conversationContext.js`:

```js
import { cacheDelete, cacheGet, cacheSet } from '../redis.js'

const DEFAULT_TTL_SECONDS = 1800
const DEFAULT_MAX_MESSAGES = 8
const SUMMARY_PREFIX = '[上文摘要]'

function contextKey(identity) {
  return `ctx:${identity}`
}

function normalizeMessage(message) {
  return {
    role: ['user', 'assistant', 'system'].includes(message?.role) ? message.role : 'user',
    content: String(message?.content || '').slice(0, 1000),
    ts: message?.ts || Date.now()
  }
}

function uniqueKeywordsFrom(text) {
  const keywords = ['本月', '上月', '餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '预算', '趋势']
  return keywords.filter(keyword => text.includes(keyword))
}

export function buildContextSummary(messages) {
  const text = messages.map(item => item.content).join('；')
  const keywords = uniqueKeywordsFrom(text)
  const clipped = text.replace(/\s+/g, ' ').slice(0, 100)
  const keywordText = keywords.length ? `关键词：${keywords.join('、')}。` : ''
  return `${keywordText}${clipped}`.slice(0, 160)
}

export async function getConversationContext(identity, { cache = { get: cacheGet } } = {}) {
  if (!identity) return []
  try {
    const value = await cache.get(contextKey(identity))
    return Array.isArray(value) ? value : []
  } catch (error) {
    console.warn('[ConversationContext] read skipped:', error.message)
    return []
  }
}

export async function appendConversationMessage(identity, message, {
  cache = { get: cacheGet, set: cacheSet },
  ttlSeconds = DEFAULT_TTL_SECONDS,
  maxMessages = DEFAULT_MAX_MESSAGES
} = {}) {
  if (!identity || !message?.content) return []
  try {
    const current = await getConversationContext(identity, { cache })
    let next = [...current, normalizeMessage(message)]

    if (next.length > maxMessages) {
      const oldMessages = next.slice(0, next.length - (maxMessages - 1))
      const recent = next.slice(-(maxMessages - 1))
      next = [
        { role: 'system', content: `${SUMMARY_PREFIX} ${buildContextSummary(oldMessages)}`, ts: Date.now() },
        ...recent
      ]
    }

    await cache.set(contextKey(identity), next, ttlSeconds)
    return next
  } catch (error) {
    console.warn('[ConversationContext] write skipped:', error.message)
    return []
  }
}

export async function clearConversationContext(identity, { cache = { del: cacheDelete } } = {}) {
  if (!identity) return
  try {
    await cache.del(contextKey(identity))
  } catch (error) {
    console.warn('[ConversationContext] clear skipped:', error.message)
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/conversationContext.test.js
```

Expected: PASS，5 个 conversationContext 测试通过。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/conversationContext.js server/test/conversationContext.test.js
git commit -m "feat: add conversation context memory"
```

## Task 2: Chat 记忆辅助函数

**Files:**
- Create: `server/src/services/chatMemory.js`
- Test: `server/test/chatMemory.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/chatMemory.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMemoryReply,
  extractQueryHints,
  summarizeRecords
} from '../src/services/chatMemory.js'

test('extractQueryHints detects month and category', () => {
  const currentMonth = '2026-07'
  const previousMonth = '2026-06'

  assert.deepEqual(extractQueryHints('本月餐饮花了多少', { now: new Date('2026-07-18') }), {
    month: currentMonth,
    category: '餐饮'
  })
  assert.deepEqual(extractQueryHints('上月购物怎么样', { now: new Date('2026-07-18') }), {
    month: previousMonth,
    category: '购物'
  })
})

test('summarizeRecords totals amount and categories', () => {
  const summary = summarizeRecords([
    { amount: 20, category: '餐饮' },
    { amount: 30, category: '餐饮' },
    { amount: 10, category: '交通' }
  ])

  assert.equal(summary.count, 3)
  assert.equal(summary.total, 60)
  assert.deepEqual(summary.categories, ['餐饮', '交通'])
})

test('buildMemoryReply returns existing message when no records found', () => {
  const reply = buildMemoryReply({
    intent: 'query',
    baseMessage: '我可以帮你查看消费统计。',
    records: []
  })

  assert.equal(reply, '我可以帮你查看消费统计。')
})

test('buildMemoryReply creates query reply from retrieved records', () => {
  const reply = buildMemoryReply({
    intent: 'query',
    baseMessage: '我可以帮你查看消费统计。',
    records: [
      { amount: 20, category: '餐饮' },
      { amount: 30, category: '餐饮' }
    ]
  })

  assert.match(reply, /找到 2 条相关记录/)
  assert.match(reply, /约 50\.00 元/)
  assert.match(reply, /餐饮/)
})

test('buildMemoryReply creates conservative advice from retrieved records', () => {
  const reply = buildMemoryReply({
    intent: 'advice',
    baseMessage: '建议先保持记账。',
    records: [
      { amount: 20, category: '餐饮' },
      { amount: 30, category: '餐饮' }
    ]
  })

  assert.match(reply, /这类支出近期较集中/)
  assert.match(reply, /餐饮/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/chatMemory.test.js
```

Expected: FAIL，错误包含 `Cannot find module '../src/services/chatMemory.js'`。

- [ ] **Step 3: 实现 chatMemory**

Create `server/src/services/chatMemory.js`:

```js
function formatMonth(date) {
  return date.toISOString().slice(0, 7)
}

function previousMonth(date) {
  const d = new Date(date)
  d.setMonth(d.getMonth() - 1)
  return formatMonth(d)
}

const CATEGORY_WORDS = ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物']

export function extractQueryHints(message, { now = new Date() } = {}) {
  const text = String(message || '')
  const hints = {}

  if (text.includes('本月')) hints.month = formatMonth(now)
  if (text.includes('上月')) hints.month = previousMonth(now)

  const category = CATEGORY_WORDS.find(item => text.includes(item))
  if (category) hints.category = category

  return hints
}

export function summarizeRecords(records = []) {
  const total = records.reduce((sum, record) => sum + Number(record.amount || 0), 0)
  const categories = [...new Set(records.map(record => record.category).filter(Boolean))]
  return { count: records.length, total, categories }
}

export function buildMemoryReply({ intent, baseMessage, records = [] }) {
  if (!records.length) return baseMessage

  const summary = summarizeRecords(records)
  const categories = summary.categories.length ? summary.categories.join('、') : '未分类'

  if (intent === 'advice') {
    return `我找到 ${summary.count} 条相关记录，合计约 ${summary.total.toFixed(2)} 元，主要涉及 ${categories}。这类支出近期较集中，可以先设置分类预算，或观察本月占比后再调整。`
  }

  return `我找到 ${summary.count} 条相关记录，总金额约 ${summary.total.toFixed(2)} 元，主要集中在 ${categories}。`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/chatMemory.test.js
```

Expected: PASS，5 个 chatMemory 测试通过。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/chatMemory.js server/test/chatMemory.test.js
git commit -m "feat: add chat memory helpers"
```

## Task 3: Qdrant 历史账单检索

**Files:**
- Modify: `server/src/services/vectorMemory.js`
- Modify: `server/test/vectorMemory.test.js`

- [ ] **Step 1: 写失败测试**

Append to `server/test/vectorMemory.test.js`:

```js
import { retrieveSimilar } from '../src/services/vectorMemory.js'

test('retrieveSimilar searches Qdrant with user month and category filters', async () => {
  const calls = []
  const client = {
    async search(collection, payload) {
      calls.push({ collection, payload })
      return [{
        score: 0.91,
        payload: {
          recordId: 12,
          userId: 7,
          date: '2026-07-18',
          month: '2026-07',
          category: '餐饮',
          amount: 88,
          merchant: '食堂',
          description: '午饭'
        }
      }]
    }
  }

  const records = await retrieveSimilar('本月餐饮', {
    userId: 7,
    month: '2026-07',
    category: '餐饮',
    limit: 3,
    client,
    collection: 'finance_records',
    getEmbedding: async () => [0.1, 0.2]
  })

  assert.equal(records.length, 1)
  assert.equal(records[0].recordId, 12)
  assert.equal(records[0].score, 0.91)
  assert.equal(calls[0].collection, 'finance_records')
  assert.deepEqual(calls[0].payload.vector, [0.1, 0.2])
  assert.equal(calls[0].payload.limit, 3)
  assert.deepEqual(calls[0].payload.filter.must, [
    { key: 'userId', match: { value: 7 } },
    { key: 'month', match: { value: '2026-07' } },
    { key: 'category', match: { value: '餐饮' } }
  ])
})

test('retrieveSimilar returns empty array without userId', async () => {
  let searched = false
  const records = await retrieveSimilar('餐饮', {
    client: { search: async () => { searched = true; return [] } },
    getEmbedding: async () => [0.1]
  })

  assert.deepEqual(records, [])
  assert.equal(searched, false)
})

test('retrieveSimilar degrades to empty array when Qdrant fails', async () => {
  const records = await retrieveSimilar('餐饮', {
    userId: 7,
    client: { search: async () => { throw new Error('qdrant down') } },
    getEmbedding: async () => [0.1]
  })

  assert.deepEqual(records, [])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/vectorMemory.test.js
```

Expected: FAIL，错误显示 `retrieveSimilar` 返回空数组或未调用 Qdrant。

- [ ] **Step 3: 实现 retrieveSimilar**

Modify `server/src/services/vectorMemory.js`:

```js
function createMatchFilter({ userId, month, category }) {
  const must = [{ key: 'userId', match: { value: userId } }]
  if (month) must.push({ key: 'month', match: { value: month } })
  if (category) must.push({ key: 'category', match: { value: category } })
  return { must }
}

function mapSearchResult(item) {
  const payload = item.payload || {}
  return {
    recordId: payload.recordId,
    date: payload.date,
    category: payload.category,
    amount: Number(payload.amount || 0),
    merchant: payload.merchant || '',
    description: payload.description || '',
    score: item.score || 0
  }
}

export async function retrieveSimilar(query, {
  userId,
  month,
  category,
  limit = 5,
  client = createVectorClient(),
  collection = config.vector.collection,
  getEmbedding: embeddingFn = getEmbedding
} = {}) {
  if (!userId || !query) return []
  try {
    const vector = await embeddingFn(query)
    const results = await client.search(collection, {
      vector,
      limit,
      with_payload: true,
      filter: createMatchFilter({ userId, month, category })
    })
    return (results || []).map(mapSearchResult)
  } catch (error) {
    console.warn('[VectorMemory] retrieve skipped:', error.message)
    return []
  }
}
```

Place helper functions near `retrieveSimilar()` and replace the old empty implementation.

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/vectorMemory.test.js
```

Expected: PASS，vectorMemory 测试全部通过。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/vectorMemory.js server/test/vectorMemory.test.js
git commit -m "feat: retrieve similar finance records"
```

## Task 4: Chat 接入上下文和历史检索

**Files:**
- Modify: `server/src/routes/chat.js`
- Modify: `server/test/chatRoute.test.js`

- [ ] **Step 1: 写失败测试**

Append to `server/test/chatRoute.test.js`:

```js
test('POST /api/chat enhances query reply with retrieved records and context', async () => {
  const calls = { getContext: 0, appendContext: [], retrieve: [] }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.deviceId = 'device-1'
    next()
  })
  app.use('/api/chat', createChatRouter({
    getUserId: () => 7,
    processMessage: async () => ({ intent: 'query', message: '我可以帮你查看消费统计。', data: null }),
    getConversationContext: async identity => {
      calls.getContext += 1
      assert.equal(identity, 'user-7')
      return [{ role: 'user', content: '刚才在看餐饮' }]
    },
    appendConversationMessage: async (identity, message) => {
      calls.appendContext.push({ identity, message })
    },
    retrieveSimilar: async (message, options) => {
      calls.retrieve.push({ message, options })
      return [{ recordId: 1, amount: 25, category: '餐饮', date: '2026-07-18' }]
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '本月餐饮花了多少' })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.match(json.data.message, /找到 1 条相关记录/)
    assert.equal(calls.getContext, 1)
    assert.equal(calls.retrieve[0].options.userId, 7)
    assert.equal(calls.retrieve[0].options.category, '餐饮')
    assert.equal(calls.appendContext.length, 2)
  } finally {
    server.close()
  }
})

test('POST /api/chat skips long term retrieval for anonymous users', async () => {
  let retrieveCalled = false
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.deviceId = 'device-1'
    next()
  })
  app.use('/api/chat', createChatRouter({
    getUserId: () => null,
    processMessage: async () => ({ intent: 'query', message: '我可以帮你查看消费统计。', data: null }),
    getConversationContext: async () => [],
    appendConversationMessage: async () => {},
    retrieveSimilar: async () => { retrieveCalled = true; return [] }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '本月餐饮花了多少' })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(retrieveCalled, false)
  } finally {
    server.close()
  }
})

test('POST /api/chat appends context after record intent succeeds', async () => {
  const appended = []
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.deviceId = 'device-1'
    next()
  })
  app.use('/api/chat', createChatRouter({
    getUserId: () => 5,
    processMessage: async () => ({
      intent: 'record',
      message: '已记账',
      data: { type: 'expense', amount: 25, category: '餐饮', description: '午饭', date: '2026-07-17' }
    }),
    createRecordTaskFromNlu: input => ({ taskId: 'task-1', agentType: 'recorder', payload: { userId: 5, deviceId: 'device-1', record: input.nluResult.data } }),
    recordFromPlannerTask: async () => ({ recordIds: [99] }),
    enqueueTask: async () => ({ taskId: 'task-1' }),
    markTaskStatus: async () => {},
    appendConversationMessage: async (identity, message) => appended.push({ identity, message })
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '今天午饭花了25元' })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(appended.length, 2)
    assert.equal(appended[0].identity, 'user-5')
    assert.equal(appended[0].message.role, 'user')
    assert.equal(appended[1].message.role, 'assistant')
  } finally {
    server.close()
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/chatRoute.test.js
```

Expected: FAIL，新增 query 增强测试中 `retrieveSimilar` 未被调用或回复未包含“找到 1 条相关记录”。

- [ ] **Step 3: 改造 chat route**

Modify `server/src/routes/chat.js` imports:

```js
import {
  appendConversationMessage as defaultAppendConversationMessage,
  getConversationContext as defaultGetConversationContext
} from '../services/conversationContext.js'
import {
  buildMemoryReply,
  extractQueryHints
} from '../services/chatMemory.js'
import { retrieveSimilar as defaultRetrieveSimilar } from '../services/vectorMemory.js'
```

Extend `createChatRouter()` dependencies:

```js
  getConversationContext = defaultGetConversationContext,
  appendConversationMessage = defaultAppendConversationMessage,
  retrieveSimilar = defaultRetrieveSimilar
```

Add helper inside `createChatRouter()` before `router.post()`:

```js
  async function appendTurn(identity, userMessage, assistantMessage) {
    await appendConversationMessage(identity, { role: 'user', content: userMessage })
    await appendConversationMessage(identity, { role: 'assistant', content: assistantMessage })
  }
```

Inside `router.post('/')`, after `const identity = ...` and after `processMessage()`:

```js
      const shouldUseMemory = ['query', 'advice', 'chat'].includes(result.intent)
      if (shouldUseMemory) {
        await getConversationContext(identity)
        const hints = extractQueryHints(message)
        const records = userId
          ? await retrieveSimilar(message, { userId, ...hints, limit: 5 })
          : []
        result.message = buildMemoryReply({
          intent: result.intent,
          baseMessage: result.message,
          records
        })
        result.memory = {
          records: records.length,
          hints
        }
      }
```

At the end of the successful try block, before `res.json(...)`:

```js
      await appendTurn(identity, message, result.message).catch(error => {
        console.warn('[Chat] context append skipped:', error.message)
      })
```

Ensure record intent still executes before response and still receives `recordIds` and `agent`.

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/chatRoute.test.js test/chatMemory.test.js test/conversationContext.test.js test/vectorMemory.test.js
```

Expected: PASS，相关测试全部通过。

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/chat.js server/test/chatRoute.test.js
git commit -m "feat: enhance chat with memory retrieval"
```

## Task 5: 集成验证与 Docker smoke

**Files:**
- No source file changes expected unless verification reveals a bug.

- [ ] **Step 1: 运行后端全量测试**

Run:

```bash
cd server
npm test
```

Expected: PASS，所有后端测试通过。

- [ ] **Step 2: 运行前端构建**

Run:

```bash
cd client
npm run build
```

Expected: PASS，允许保留既有 Vite chunk size warning。

- [ ] **Step 3: Docker 重建前后端**

Run from repo root in PowerShell:

```bash
$env:JWT_SECRET='smart-finance-smoke-jwt-secret-20260718-please-replace-in-production'
docker compose up -d --build backend frontend
```

Expected: backend healthy，frontend started。

- [ ] **Step 4: Docker smoke 验证自然语言记账和查询增强**

Run from repo root in PowerShell:

```bash
$env:JWT_SECRET='smart-finance-smoke-jwt-secret-20260718-please-replace-in-production'
@'
const login = await fetch('http://localhost:3000/api/auth/mock-login', { method: 'POST' }).then(r => r.json())
const token = login.data.token

const record = await fetch('http://localhost:3000/api/chat', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: '今天餐饮花了25元' })
}).then(r => r.json())
if (!record.success || !record.data.recordIds?.length) throw new Error(`record failed: ${JSON.stringify(record)}`)

const query = await fetch('http://localhost:3000/api/chat', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: '本月餐饮花了多少' })
}).then(r => r.json())
if (!query.success) throw new Error(`query failed: ${JSON.stringify(query)}`)
if (!/找到|消费统计|相关记录/.test(query.data.message)) throw new Error(`unexpected query reply: ${query.data.message}`)

console.log(`record_ids=${record.data.recordIds.join(',')}`)
console.log(`query_message=${query.data.message}`)
console.log(`memory_records=${query.data.memory?.records ?? 0}`)
'@ | node --input-type=module -
```

Expected output includes:

```text
record_ids=
query_message=
memory_records=
```

`memory_records` may be `0` when Qdrant search has no matching point yet, but the endpoint must respond successfully. If Qdrant returns the just-created record, `memory_records` should be greater than `0`.

- [ ] **Step 5: 检查未提交范围**

Run:

```bash
git status --short
git diff --cached --stat
```

Expected:

- `git diff --cached --stat` has no output。
- 第六阶段文件没有未提交改动。
- 既有无关脏文件可以继续存在。

## 自检清单

- 规格覆盖：计划覆盖 Redis 短期上下文、Qdrant 长期检索、Chat 查询/建议增强、未登录边界、降级策略、测试和 Docker smoke。
- 占位符扫描：计划未使用待填内容；每个代码步骤都有具体测试、实现片段或命令。
- 类型一致性：`getConversationContext()`、`appendConversationMessage()`、`retrieveSimilar()`、`extractQueryHints()`、`buildMemoryReply()` 在测试、实现和路由注入中命名一致。
- 范围控制：不新增前端页面、不改 MySQL 表结构、不接外部 LLM 强分析、不改变 OCR 和 Bad Case 流程。
