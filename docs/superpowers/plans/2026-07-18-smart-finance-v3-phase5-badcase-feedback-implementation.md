# Smart Finance V3 第五阶段 Bad Case 反馈数据闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 AI insight 反馈写入和 OCR/Insight Bad Case JSONL 导出，让用户纠错沉淀为可复用数据集。

**Architecture:** 新增 `badCaseCollector` 服务，统一从 `ocr_evaluations` 与 `feedback` 聚合 Bad Case 样本；新增 `insights` 路由写入结构化 AI 洞察反馈；新增 `datasets` 路由按当前登录用户导出 JSON 或 JSONL。所有新路由和服务都支持依赖注入，便于 Node 内置测试用 fake DB 验证用户隔离与降级逻辑。

**Tech Stack:** Node.js 22、Express、Knex/MySQL、Node 内置 test、Docker Compose。

---

## 文件结构

- 新增 `server/src/services/badCaseCollector.js`：构建 OCR/Insight Bad Case item，输出数组和 JSONL 文本。
- 新增 `server/test/badCaseCollector.test.js`：验证 OCR、Insight、source 过滤、用户隔离和非法 JSON 降级。
- 新增 `server/src/routes/insights.js`：提供 `POST /api/insights/feedback`，写入 `feedback` 表。
- 新增 `server/test/insightsRoute.test.js`：验证鉴权、字段校验、当前用户写入和 P1/P2 优先级。
- 新增 `server/src/routes/datasets.js`：提供 `GET /api/datasets/bad-cases`，支持 `format=json` 和默认 JSONL。
- 新增 `server/test/datasetsRoute.test.js`：验证当前用户隔离和 JSONL content-type。
- 修改 `server/src/index.js`：注册 `/api/insights` 与 `/api/datasets`。

注意：当前工作区存在已有未提交前端和本地 DB 脏改动。实施提交时只 stage 本阶段明确涉及的后端文件和测试文件，不清理、不格式化、不提交无关文件。

## Task 1: Bad Case Collector 服务

**Files:**
- Create: `server/src/services/badCaseCollector.js`
- Test: `server/test/badCaseCollector.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/badCaseCollector.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBadCaseDataset,
  toJsonl
} from '../src/services/badCaseCollector.js'

function createQuery(table, tables) {
  const state = { where: [], whereRaw: [] }

  function apply() {
    return tables[table].filter(row => {
      for (const condition of state.where) {
        for (const [key, value] of Object.entries(condition)) {
          if (row[key] !== value) return false
        }
      }
      for (const raw of state.whereRaw) {
        if (raw.sql.includes('DATE_FORMAT')) {
          const dateValue = String(row.confirmed_at || row.created_at || '')
          if (dateValue.slice(0, 7) !== raw.bindings[0]) return false
        }
      }
      return true
    })
  }

  const query = {
    where(condition) {
      state.where.push(condition)
      return query
    },
    whereRaw(sql, bindings) {
      state.whereRaw.push({ sql, bindings })
      return query
    },
    orderBy() { return query },
    then(resolve, reject) {
      return Promise.resolve(apply()).then(resolve, reject)
    }
  }
  return query
}

function createFakeDb(seed = {}) {
  const tables = {
    ocr_evaluations: [...(seed.ocr_evaluations || [])],
    feedback: [...(seed.feedback || [])]
  }
  function db(table) {
    return createQuery(table, tables)
  }
  db.tables = tables
  return db
}

test('buildBadCaseDataset creates OCR correction item', async () => {
  const db = createFakeDb({
    ocr_evaluations: [{
      id: 1,
      record_id: 42,
      user_id: 7,
      ocr_result: JSON.stringify({ records: [{ amount: 80, category: '购物', description: '晚餐' }] }),
      user_corrected: 1,
      corrected_category: '餐饮',
      corrected_amount: 88,
      created_at: '2026-07-18 10:00:00'
    }]
  })

  const data = await buildBadCaseDataset({ userId: 7, month: '2026-07', source: 'ocr', dbClient: db })

  assert.equal(data.length, 1)
  assert.equal(data[0].source, 'ocr')
  assert.equal(data[0].metadata.recordId, 42)
  assert.match(data[0].messages[2].content, /餐饮/)
  assert.match(data[0].messages[2].content, /88/)
})

test('buildBadCaseDataset creates insight feedback item', async () => {
  const db = createFakeDb({
    feedback: [{
      id: 5,
      user_id: 7,
      type: 'ai_insight',
      priority: 'P1',
      content: JSON.stringify({
        insightId: 'food-risk',
        reportId: 9,
        isAccurate: false,
        correction: '这是一次性聚餐，不是长期趋势',
        context: { summary: '餐饮异常上升', period: '2026-07' }
      }),
      created_at: '2026-07-18 10:00:00'
    }]
  })

  const data = await buildBadCaseDataset({ userId: 7, month: '2026-07', source: 'insight', dbClient: db })

  assert.equal(data.length, 1)
  assert.equal(data[0].source, 'insight')
  assert.equal(data[0].metadata.feedbackId, 5)
  assert.match(data[0].messages[0].content, /餐饮异常上升/)
  assert.match(data[0].messages[1].content, /避免该判断/)
})

test('buildBadCaseDataset source filter returns only requested source and scopes user', async () => {
  const db = createFakeDb({
    ocr_evaluations: [
      { id: 1, record_id: 1, user_id: 7, ocr_result: '{}', user_corrected: 1, corrected_category: '餐饮', corrected_amount: 10, created_at: '2026-07-18 10:00:00' },
      { id: 2, record_id: 2, user_id: 8, ocr_result: '{}', user_corrected: 1, corrected_category: '购物', corrected_amount: 20, created_at: '2026-07-18 10:00:00' }
    ],
    feedback: [
      { id: 3, user_id: 7, type: 'ai_insight', priority: 'P2', content: '{}', created_at: '2026-07-18 10:00:00' }
    ]
  })

  const data = await buildBadCaseDataset({ userId: 7, month: '2026-07', source: 'ocr', dbClient: db })

  assert.deepEqual(data.map(item => item.source), ['ocr'])
  assert.equal(data[0].metadata.userId, 7)
})

test('buildBadCaseDataset downgrades invalid JSON and toJsonl emits one JSON object per line', async () => {
  const db = createFakeDb({
    feedback: [{
      id: 9,
      user_id: 7,
      type: 'ai_insight',
      priority: 'P1',
      content: '普通文本反馈',
      created_at: '2026-07-18 10:00:00'
    }]
  })

  const data = await buildBadCaseDataset({ userId: 7, month: '2026-07', source: 'all', dbClient: db })
  const jsonl = toJsonl(data)

  assert.equal(data.length, 1)
  assert.match(data[0].messages[0].content, /普通文本反馈/)
  assert.equal(jsonl.split('\n').length, 1)
  assert.equal(JSON.parse(jsonl).source, 'insight')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/badCaseCollector.test.js
```

Expected: FAIL，错误包含 `Cannot find module '../src/services/badCaseCollector.js'`。

- [ ] **Step 3: 实现 badCaseCollector**

Create `server/src/services/badCaseCollector.js`:

```js
import db from '../db.js'

const VALID_SOURCES = new Set(['all', 'ocr', 'insight'])
const MONTH_PATTERN = /^\d{4}-\d{2}$/

function currentMonth() {
  return new Date().toISOString().slice(0, 7)
}

function normalizeMonth(month) {
  return MONTH_PATTERN.test(String(month || '')) ? String(month) : currentMonth()
}

function normalizeSource(source) {
  return VALID_SOURCES.has(source) ? source : 'all'
}

function safeJsonParse(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value || '{}'))
  } catch {
    return { raw: String(value || '') }
  }
}

function stringify(value) {
  return JSON.stringify(value, null, 0)
}

function applyOcrCorrection(original, row) {
  const payload = safeJsonParse(original)
  const records = Array.isArray(payload.records) ? payload.records : [payload]
  const first = records[0] || {}
  return {
    records: [{
      ...first,
      category: row.corrected_category || first.category || '其他',
      amount: row.corrected_amount != null ? Number(row.corrected_amount) : first.amount
    }]
  }
}

function createOcrItem(row, month) {
  const original = safeJsonParse(row.ocr_result)
  return {
    source: 'ocr',
    messages: [
      { role: 'user', content: '请识别以下小票图片中的账单条目' },
      { role: 'assistant', content: stringify(original) },
      { role: 'user', content: `用户修正：分类应为「${row.corrected_category || '其他'}」，金额应为 ${row.corrected_amount ?? '未提供'} 元` },
      { role: 'assistant', content: stringify(applyOcrCorrection(row.ocr_result, row)) }
    ],
    metadata: {
      userId: row.user_id,
      recordId: row.record_id || null,
      evaluationId: row.id,
      month
    }
  }
}

function createInsightItem(row, month) {
  const content = safeJsonParse(row.content)
  const isAccurate = content.isAccurate === true
  const summary = content.context?.summary || content.insightId || 'AI insight'
  const correction = content.correction || content.raw || ''

  return {
    source: 'insight',
    messages: [
      { role: 'user', content: `原洞察：${summary}\n用户反馈：${correction || (isAccurate ? '准确' : '不准确')}` },
      { role: 'assistant', content: isAccurate ? '该洞察被用户确认准确。' : '已收到修正，并在后续分析中避免该判断。' }
    ],
    metadata: {
      userId: row.user_id,
      feedbackId: row.id,
      priority: row.priority || null,
      month
    }
  }
}

async function fetchOcrRows({ userId, month, dbClient }) {
  return dbClient('ocr_evaluations')
    .where({ user_id: userId, user_corrected: 1 })
    .whereRaw("DATE_FORMAT(COALESCE(confirmed_at, created_at), '%Y-%m') = ?", [month])
    .orderBy('created_at', 'desc')
}

async function fetchInsightRows({ userId, month, dbClient }) {
  return dbClient('feedback')
    .where({ user_id: userId, type: 'ai_insight' })
    .whereRaw("DATE_FORMAT(created_at, '%Y-%m') = ?", [month])
    .orderBy('created_at', 'desc')
}

export async function buildBadCaseDataset({
  userId,
  month = currentMonth(),
  source = 'all',
  dbClient = db
} = {}) {
  if (!userId) return []
  const normalizedMonth = normalizeMonth(month)
  const normalizedSource = normalizeSource(source)
  const items = []

  if (normalizedSource === 'all' || normalizedSource === 'ocr') {
    const rows = await fetchOcrRows({ userId, month: normalizedMonth, dbClient })
    items.push(...rows.map(row => createOcrItem(row, normalizedMonth)))
  }

  if (normalizedSource === 'all' || normalizedSource === 'insight') {
    const rows = await fetchInsightRows({ userId, month: normalizedMonth, dbClient })
    items.push(...rows.map(row => createInsightItem(row, normalizedMonth)))
  }

  return items
}

export function toJsonl(items) {
  return items.map(item => JSON.stringify(item)).join('\n')
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/badCaseCollector.test.js
```

Expected: PASS，4 个 badCaseCollector 测试通过。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/badCaseCollector.js server/test/badCaseCollector.test.js
git commit -m "feat: collect bad case datasets"
```

## Task 2: Insight 反馈路由

**Files:**
- Create: `server/src/routes/insights.js`
- Test: `server/test/insightsRoute.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/insightsRoute.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createInsightsRouter } from '../src/routes/insights.js'
import { signToken } from '../src/middleware/auth.js'

function listen(app) {
  const server = createServer(app)
  return new Promise(resolve => {
    server.listen(0, () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

function createFakeDb(rows = []) {
  function db(table) {
    assert.equal(table, 'feedback')
    return {
      async insert(value) {
        rows.push({ id: rows.length + 1, ...value })
        return [rows.length]
      },
      where(condition) {
        return {
          first: async () => rows.find(row => Object.entries(condition).every(([key, value]) => row[key] == value))
        }
      }
    }
  }
  db.rows = rows
  return db
}

test('POST /api/insights/feedback writes inaccurate feedback as P1 for current user', async () => {
  const db = createFakeDb()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.deviceId = 'device-1'; next() })
  app.use('/api/insights', createInsightsRouter({ dbClient: db }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/insights/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        insightId: 'food-risk',
        reportId: 12,
        isAccurate: false,
        correction: '这是一次性聚餐',
        context: { summary: '餐饮上升' }
      })
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.priority, 'P1')
    assert.equal(db.rows[0].user_id, 7)
    assert.equal(db.rows[0].device_id, 'device-1')
    assert.equal(db.rows[0].type, 'ai_insight')
    assert.equal(JSON.parse(db.rows[0].content).insightId, 'food-risk')
  } finally {
    server.close()
  }
})

test('POST /api/insights/feedback writes accurate feedback as P2', async () => {
  const db = createFakeDb()
  const app = express()
  app.use(express.json())
  app.use('/api/insights', createInsightsRouter({ dbClient: db }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/insights/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ insightId: 'saving-good', isAccurate: true })
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.data.priority, 'P2')
  } finally {
    server.close()
  }
})

test('POST /api/insights/feedback validates auth and required fields', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/insights', createInsightsRouter({ dbClient: createFakeDb() }))

  const { server, url } = await listen(app)
  try {
    const noAuth = await fetch(`${url}/api/insights/feedback`, { method: 'POST' })
    assert.equal(noAuth.status, 401)

    const missing = await fetch(`${url}/api/insights/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAccurate: false })
    })
    assert.equal(missing.status, 400)

    const invalid = await fetch(`${url}/api/insights/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ insightId: 'x', isAccurate: 'no' })
    })
    assert.equal(invalid.status, 400)
  } finally {
    server.close()
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/insightsRoute.test.js
```

Expected: FAIL，错误包含 `Cannot find module '../src/routes/insights.js'`。

- [ ] **Step 3: 实现 insights 路由**

Create `server/src/routes/insights.js`:

```js
import { Router } from 'express'
import db from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

function priorityForAccuracy(isAccurate) {
  return isAccurate ? 'P2' : 'P1'
}

export function createInsightsRouter({ dbClient = db } = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.post('/feedback', async (req, res) => {
    const { insightId, reportId = null, isAccurate, correction = '', context = {} } = req.body || {}
    if (!insightId) return res.status(400).json({ success: false, error: '缺少 insightId' })
    if (typeof isAccurate !== 'boolean') return res.status(400).json({ success: false, error: 'isAccurate 必须是 boolean' })

    const priority = priorityForAccuracy(isAccurate)
    const content = JSON.stringify({ insightId, reportId, isAccurate, correction, context })
    const [id] = await dbClient('feedback').insert({
      device_id: req.deviceId || null,
      user_id: req.userId,
      type: 'ai_insight',
      content,
      priority,
      status: 'pending'
    })

    res.json({ success: true, data: { id, priority } })
  })

  return router
}

export default createInsightsRouter()
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/insightsRoute.test.js
```

Expected: PASS，3 个 insightsRoute 测试通过。

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/insights.js server/test/insightsRoute.test.js
git commit -m "feat: collect insight feedback"
```

## Task 3: Dataset 导出路由

**Files:**
- Create: `server/src/routes/datasets.js`
- Test: `server/test/datasetsRoute.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/datasetsRoute.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createDatasetsRouter } from '../src/routes/datasets.js'
import { signToken } from '../src/middleware/auth.js'

function listen(app) {
  const server = createServer(app)
  return new Promise(resolve => {
    server.listen(0, () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

test('GET /api/datasets/bad-cases format=json uses authenticated user only', async () => {
  const calls = []
  const app = express()
  app.use('/api/datasets', createDatasetsRouter({
    buildBadCaseDataset: async input => {
      calls.push(input)
      return [{ source: 'ocr', messages: [], metadata: { userId: input.userId } }]
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/datasets/bad-cases?month=2026-07&source=all&format=json&userId=999`, {
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(calls[0].userId, 7)
    assert.equal(calls[0].month, '2026-07')
    assert.equal(calls[0].source, 'all')
    assert.equal(json.data[0].metadata.userId, 7)
  } finally {
    server.close()
  }
})

test('GET /api/datasets/bad-cases returns JSONL content type by default', async () => {
  const app = express()
  app.use('/api/datasets', createDatasetsRouter({
    buildBadCaseDataset: async () => [{ source: 'insight', messages: [], metadata: { feedbackId: 1 } }]
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/datasets/bad-cases`, {
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/jsonl/)
    assert.equal(JSON.parse(text).source, 'insight')
  } finally {
    server.close()
  }
})

test('GET /api/datasets/bad-cases requires auth', async () => {
  const app = express()
  app.use('/api/datasets', createDatasetsRouter({
    buildBadCaseDataset: async () => []
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/datasets/bad-cases`)
    assert.equal(response.status, 401)
  } finally {
    server.close()
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/datasetsRoute.test.js
```

Expected: FAIL，错误包含 `Cannot find module '../src/routes/datasets.js'`。

- [ ] **Step 3: 实现 datasets 路由**

Create `server/src/routes/datasets.js`:

```js
import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import {
  buildBadCaseDataset as defaultBuildBadCaseDataset,
  toJsonl
} from '../services/badCaseCollector.js'

export function createDatasetsRouter({
  buildBadCaseDataset = defaultBuildBadCaseDataset
} = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.get('/bad-cases', async (req, res) => {
    const data = await buildBadCaseDataset({
      userId: req.userId,
      month: req.query.month,
      source: req.query.source
    })

    if (req.query.format === 'json') {
      return res.json({ success: true, data })
    }

    res.setHeader('Content-Type', 'application/jsonl; charset=utf-8')
    res.send(toJsonl(data))
  })

  return router
}

export default createDatasetsRouter()
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/datasetsRoute.test.js test/badCaseCollector.test.js
```

Expected: PASS，datasets route 和 badCaseCollector 测试通过。

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/datasets.js server/test/datasetsRoute.test.js
git commit -m "feat: export bad case datasets"
```

## Task 4: 注册新路由并做后端全量验证

**Files:**
- Modify: `server/src/index.js`

- [ ] **Step 1: 注册路由**

Modify `server/src/index.js` imports:

```js
import insightsRouter from './routes/insights.js'
import datasetsRouter from './routes/datasets.js'
```

Add after existing API route registration:

```js
app.use('/api/insights', insightsRouter)
app.use('/api/datasets', datasetsRouter)
```

- [ ] **Step 2: 运行新路由相关测试**

Run:

```bash
cd server
npm test -- test/insightsRoute.test.js test/datasetsRoute.test.js test/badCaseCollector.test.js
```

Expected: PASS，相关测试通过。

- [ ] **Step 3: 运行后端全量测试**

Run:

```bash
cd server
npm test
```

Expected: PASS，所有后端测试通过。

- [ ] **Step 4: 提交**

```bash
git add server/src/index.js
git commit -m "feat: register bad case routes"
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

Expected: PASS。

- [ ] **Step 2: 运行前端构建**

Run:

```bash
cd client
npm run build
```

Expected: PASS，允许保留 Vite chunk size warning。

- [ ] **Step 3: Docker 重建前后端**

Run:

```bash
docker compose up -d --build backend frontend
```

Expected: backend healthy，frontend started。

- [ ] **Step 4: Docker smoke 验证 feedback 与 dataset**

Run from repo root in PowerShell:

```bash
@'
import { execFileSync } from 'node:child_process'

function mysql(sql) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'mysql', 'mysql', '--default-character-set=utf8mb4', '-ufinance', '-pFinancePass2026!', 'smart_finance', '-N', '-e', sql], { encoding: 'utf8' }).trim()
}

const login = await fetch('http://localhost:3000/api/auth/mock-login', { method: 'POST' }).then(r => r.json())
const token = login.data.token
const userId = login.data.user?.id || login.data.userId

const feedback = await fetch('http://localhost:3000/api/insights/feedback', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    insightId: 'smoke-insight',
    isAccurate: false,
    correction: '这是一条 smoke 修正',
    context: { summary: 'smoke 洞察' }
  })
}).then(r => r.json())
if (!feedback.success || feedback.data.priority !== 'P1') throw new Error('insight feedback failed')

mysql(`INSERT INTO ocr_evaluations (user_id,ocr_result,user_confirmed,user_corrected,corrected_category,corrected_amount,ocr_correct) VALUES (${userId},'{\"records\":[{\"amount\":8,\"category\":\"购物\"}]}',1,1,'餐饮',9,0);`)

const dataset = await fetch('http://localhost:3000/api/datasets/bad-cases?source=all&format=json', {
  headers: { Authorization: `Bearer ${token}` }
}).then(r => r.json())

if (!dataset.success) throw new Error('dataset export failed')
if (!dataset.data.some(item => item.source === 'ocr')) throw new Error('missing ocr bad case')
if (!dataset.data.some(item => item.source === 'insight')) throw new Error('missing insight bad case')

console.log(`feedback_priority=${feedback.data.priority}`)
console.log(`dataset_items=${dataset.data.length}`)
console.log(`sources=${[...new Set(dataset.data.map(item => item.source))].join(',')}`)
'@ | node --input-type=module -
```

Expected output includes:

```text
feedback_priority=P1
sources=ocr,insight
```

and `dataset_items` is at least `2`.

- [ ] **Step 5: 检查未提交范围**

Run:

```bash
git status --short
git diff --cached --stat
```

Expected:

- `git diff --cached --stat` has no output.
- 本阶段文件没有未提交改动。
- 既有用户脏文件可以继续存在。

## 自检清单

- 规格覆盖：计划覆盖 Insight 反馈、P1/P2 优先级、OCR Bad Case、Insight Bad Case、JSONL 导出、当前用户隔离、测试和 Docker smoke。
- 占位符扫描：未使用待填内容；所有代码步骤都给出具体片段或命令。
- 类型一致性：`buildBadCaseDataset()`、`toJsonl()`、`createInsightsRouter()`、`createDatasetsRouter()`、`source`、`format=json` 在测试、实现和路由中命名一致。
- 范围控制：不新增前端页面、不上传微调平台、不改表结构、不改 OCR 确认流程。
