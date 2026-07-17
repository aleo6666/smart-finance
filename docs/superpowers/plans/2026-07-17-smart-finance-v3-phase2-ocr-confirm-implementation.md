# Smart Finance V3 第二阶段 OCR 人工确认闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现“票据 OCR 只生成待确认候选记录，用户确认后才写入正式账本”的闭环。

**Architecture:** 后端新增 Redis OCR 会话服务和确认入库服务；`/api/records/ocr` 只保存临时会话，`/api/records/ocr/confirm` 才写入 MySQL `records` 与 `ocr_evaluations`。前端复用现有 `ChatWindow.vue` OCR 卡片，改成携带 `ocrSessionId` 的一次性确认保存。

**Tech Stack:** Node.js 22、Express、Knex/MySQL、Redis/ioredis、Qdrant、Vue 3、Vite、Node 内置 test。

---

## 文件结构

- 新增 `server/src/services/ocrSession.js`：OCR Redis 临时会话的 key、保存、读取、删除。
- 新增 `server/src/services/ocrConfirm.js`：确认记录校验、OCR 修正判定、事务入库、评估记录写入、向量和监控触发。
- 修改 `server/src/redis.js`：增加 `cacheDelete(key)`，服务真实 Redis 和内存 fallback。
- 修改 `server/src/routes/records.js`：导出 `createRecordsRouter(deps)` 便于测试；调整 `/ocr`，新增 `/ocr/confirm`、`/ocr/cancel`。
- 修改 `server/src/routes/vision.js`：加鉴权，并复用“识别但不入库”的逻辑或返回同格式临时会话响应。
- 修改 `server/src/services/vision.js`：删除硬编码智谱 Key，修复 OCR prompt 和中文文案。
- 修改 `client/src/utils/api.js`：统一 OCR API 到 `/api/records/ocr`，新增确认/取消方法。
- 修改 `client/src/components/ChatWindow.vue`：保存 `ocrSessionId`，确认时批量调用后端确认接口。
- 新增后端测试：
  - `server/test/ocrSession.test.js`
  - `server/test/ocrConfirm.test.js`
  - `server/test/recordsOcrRoute.test.js`
  - `server/test/vision.test.js`

## Task 1: Redis OCR 会话服务

**Files:**
- Modify: `server/src/redis.js`
- Create: `server/src/services/ocrSession.js`
- Test: `server/test/ocrSession.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/ocrSession.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OCR_SESSION_TTL_SECONDS,
  createOcrSessionKey,
  saveOcrSession,
  readOcrSession,
  clearOcrSession
} from '../src/services/ocrSession.js'

function createFakeCache() {
  const values = new Map()
  return {
    values,
    async set(key, value, ttlSeconds) {
      values.set(key, { value, ttlSeconds })
    },
    async get(key) {
      return values.get(key)?.value || null
    },
    async delete(key) {
      values.delete(key)
    }
  }
}

test('createOcrSessionKey scopes sessions by user id and session id', () => {
  assert.equal(createOcrSessionKey(7, 'abc'), 'ocr:session:7:abc')
})

test('saveOcrSession stores OCR result with 30 minute TTL', async () => {
  const cache = createFakeCache()

  const saved = await saveOcrSession({
    userId: 7,
    file: { path: 'uploads/a.png', mimetype: 'image/png', size: 123 },
    result: {
      summary: '识别到 1 条消费记录',
      totalAmount: 25,
      records: [{ amount: 25, category: '餐饮', date: '2026-07-17' }]
    },
    sessionIdFactory: () => 'session-1',
    now: () => new Date('2026-07-17T00:00:00.000Z'),
    cache
  })

  assert.equal(saved.ocrSessionId, 'session-1')
  assert.equal(saved.expiresInSeconds, OCR_SESSION_TTL_SECONDS)
  assert.equal(cache.values.get('ocr:session:7:session-1').ttlSeconds, 1800)

  const session = await readOcrSession({
    userId: 7,
    ocrSessionId: 'session-1',
    cache
  })

  assert.equal(session.userId, 7)
  assert.equal(session.summary, '识别到 1 条消费记录')
  assert.equal(session.records[0].amount, 25)
  assert.equal(session.createdAt, '2026-07-17T00:00:00.000Z')
})

test('clearOcrSession deletes only the scoped user session', async () => {
  const cache = createFakeCache()
  await saveOcrSession({
    userId: 7,
    file: { path: 'uploads/a.png', mimetype: 'image/png', size: 123 },
    result: { summary: 'ok', totalAmount: 1, records: [{ amount: 1, category: '餐饮', date: '2026-07-17' }] },
    sessionIdFactory: () => 'session-1',
    cache
  })

  await clearOcrSession({ userId: 7, ocrSessionId: 'session-1', cache })

  assert.equal(await readOcrSession({ userId: 7, ocrSessionId: 'session-1', cache }), null)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/ocrSession.test.js
```

Expected: FAIL，错误包含 `Cannot find module '../src/services/ocrSession.js'`。

- [ ] **Step 3: 实现 Redis 删除函数**

Modify `server/src/redis.js` and add this export after `cacheGet`:

```js
export async function cacheDelete(key) {
  try {
    const redis = getRedisClient()
    if (redis.status === 'wait') await redis.connect()
    await redis.del(key)
  } catch {
    memoryStore.delete(key)
  }
}
```

- [ ] **Step 4: 实现 OCR 会话服务**

Create `server/src/services/ocrSession.js`:

```js
import { randomUUID } from 'crypto'
import { cacheSet, cacheGet, cacheDelete } from '../redis.js'

export const OCR_SESSION_TTL_SECONDS = 30 * 60

export function createOcrSessionKey(userId, ocrSessionId) {
  return `ocr:session:${userId}:${ocrSessionId}`
}

function normalizeRecords(records) {
  return Array.isArray(records) ? records : []
}

export async function saveOcrSession({
  userId,
  file,
  result,
  sessionIdFactory = randomUUID,
  now = () => new Date(),
  cache = { set: cacheSet }
}) {
  const ocrSessionId = sessionIdFactory()
  const session = {
    userId,
    image: {
      path: file?.path || '',
      mimeType: file?.mimetype || '',
      size: file?.size || 0
    },
    summary: result?.summary || '',
    totalAmount: Number(result?.totalAmount || 0),
    records: normalizeRecords(result?.records),
    createdAt: now().toISOString()
  }

  await cache.set(createOcrSessionKey(userId, ocrSessionId), session, OCR_SESSION_TTL_SECONDS)

  return {
    ocrSessionId,
    expiresInSeconds: OCR_SESSION_TTL_SECONDS,
    session
  }
}

export async function readOcrSession({
  userId,
  ocrSessionId,
  cache = { get: cacheGet }
}) {
  if (!ocrSessionId) return null
  return cache.get(createOcrSessionKey(userId, ocrSessionId))
}

export async function clearOcrSession({
  userId,
  ocrSessionId,
  cache = { delete: cacheDelete }
}) {
  if (!ocrSessionId) return
  await cache.delete(createOcrSessionKey(userId, ocrSessionId))
}
```

- [ ] **Step 5: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/ocrSession.test.js
```

Expected: PASS，3 个 OCR session 测试通过。

- [ ] **Step 6: 提交**

```bash
git add server/src/redis.js server/src/services/ocrSession.js server/test/ocrSession.test.js
git commit -m "feat: add ocr session store"
```

## Task 2: OCR 确认入库服务

**Files:**
- Create: `server/src/services/ocrConfirm.js`
- Test: `server/test/ocrConfirm.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/ocrConfirm.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeOcrRecord,
  isUserCorrected,
  saveConfirmedOcrRecords
} from '../src/services/ocrConfirm.js'

test('normalizeOcrRecord accepts a valid confirmed OCR record', () => {
  const record = normalizeOcrRecord({
    type: 'expense',
    amount: '25.50',
    category: '餐饮',
    description: '午餐',
    date: '2026-07-17',
    merchant: '某某餐厅'
  })

  assert.equal(record.type, 'expense')
  assert.equal(record.amount, 25.5)
  assert.equal(record.category, '餐饮')
  assert.equal(record.description, '午餐')
  assert.equal(record.date, '2026-07-17')
  assert.equal(record.merchant, '某某餐厅')
})

test('normalizeOcrRecord rejects invalid amount and date', () => {
  assert.throws(() => normalizeOcrRecord({ amount: 0, category: '餐饮', date: '2026-07-17' }), /金额必须大于 0/)
  assert.throws(() => normalizeOcrRecord({ amount: 1, category: '餐饮', date: '2026/07/17' }), /日期格式必须是 YYYY-MM-DD/)
})

test('isUserCorrected detects changed key fields', () => {
  const original = { amount: 25, category: '餐饮', date: '2026-07-17', merchant: 'A', description: '午餐' }
  assert.equal(isUserCorrected(original, { ...original }), false)
  assert.equal(isUserCorrected(original, { ...original, amount: 26 }), true)
  assert.equal(isUserCorrected(original, { ...original, category: '购物' }), true)
})

test('saveConfirmedOcrRecords inserts records and OCR evaluations', async () => {
  const insertedRecords = []
  const insertedEvaluations = []
  const embedded = []
  const monitored = []

  const repository = {
    async transaction(work) {
      return work('trx')
    },
    async insertRecord(record) {
      insertedRecords.push(record)
      return insertedRecords.length
    },
    async fetchRecord(id) {
      return { ...insertedRecords[id - 1], id }
    },
    async insertEvaluation(evaluation) {
      insertedEvaluations.push(evaluation)
    }
  }

  const result = await saveConfirmedOcrRecords({
    userId: 7,
    deviceId: 'user-7',
    session: {
      records: [{ amount: 25, category: '餐饮', date: '2026-07-17', merchant: 'A', description: '午餐' }]
    },
    confirmedRecords: [{ amount: 26, category: '餐饮', date: '2026-07-17', merchant: 'A', description: '午餐' }],
    repository,
    embedRecordFn: async record => embedded.push(record),
    checkBudgetAfterRecordFn: async input => monitored.push(input)
  })

  assert.equal(result.count, 1)
  assert.equal(result.records[0].id, 1)
  assert.equal(insertedRecords[0].user_id, 7)
  assert.equal(insertedRecords[0].amount, 26)
  assert.equal(insertedEvaluations[0].record_id, 1)
  assert.equal(insertedEvaluations[0].user_corrected, 1)
  assert.equal(insertedEvaluations[0].ocr_correct, 0)
  assert.equal(insertedEvaluations[0].corrected_amount, 26)
  assert.equal(embedded[0].id, 1)
  assert.equal(monitored[0].record.id, 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/ocrConfirm.test.js
```

Expected: FAIL，错误包含 `Cannot find module '../src/services/ocrConfirm.js'`。

- [ ] **Step 3: 实现确认入库服务**

Create `server/src/services/ocrConfirm.js`:

```js
import db from '../db.js'
import { embedRecord } from './vectorMemory.js'
import { checkBudgetAfterRecord } from './monitorAgent.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function cleanText(value) {
  return String(value || '').trim()
}

export function normalizeOcrRecord(input) {
  const amount = Number(input?.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金额必须大于 0')
  if (amount > 100000) throw new Error('金额不能超过 100000')

  const category = cleanText(input?.category)
  if (!category) throw new Error('分类不能为空')

  const date = cleanText(input?.date)
  if (!DATE_PATTERN.test(date)) throw new Error('日期格式必须是 YYYY-MM-DD')

  const type = input?.type === 'income' ? 'income' : 'expense'

  return {
    type,
    amount,
    currency: 'CNY',
    amount_cny: amount,
    category,
    description: cleanText(input?.description) || category,
    merchant: cleanText(input?.merchant) || null,
    date
  }
}

function comparable(record) {
  return {
    amount: Number(record?.amount || 0),
    category: cleanText(record?.category),
    date: cleanText(record?.date),
    merchant: cleanText(record?.merchant),
    description: cleanText(record?.description)
  }
}

export function isUserCorrected(original, confirmed) {
  const left = comparable(original)
  const right = comparable(confirmed)
  return left.amount !== right.amount ||
    left.category !== right.category ||
    left.date !== right.date ||
    left.merchant !== right.merchant ||
    left.description !== right.description
}

export function createOcrConfirmRepository(dbClient = db) {
  return {
    async transaction(work) {
      return dbClient.transaction(work)
    },
    async insertRecord(record, trx) {
      const [id] = await trx('records').insert(record)
      return id
    },
    async fetchRecord(id, userId, trx) {
      return trx('records').where({ id, user_id: userId }).first()
    },
    async insertEvaluation(evaluation, trx) {
      await trx('ocr_evaluations').insert(evaluation)
    }
  }
}

export async function saveConfirmedOcrRecords({
  userId,
  deviceId,
  session,
  confirmedRecords,
  repository = createOcrConfirmRepository(),
  embedRecordFn = embedRecord,
  checkBudgetAfterRecordFn = checkBudgetAfterRecord,
  logger = console
}) {
  const normalizedRecords = (Array.isArray(confirmedRecords) ? confirmedRecords : []).map(normalizeOcrRecord)
  if (normalizedRecords.length === 0) throw new Error('没有可保存的确认记录')

  const savedRecords = []
  const originalRecords = Array.isArray(session?.records) ? session.records : []

  await repository.transaction(async trx => {
    for (const [index, record] of normalizedRecords.entries()) {
      const row = {
        device_id: deviceId || `user-${userId}`,
        user_id: userId,
        ledger_id: null,
        type: record.type,
        amount: record.amount,
        currency: record.currency,
        amount_cny: record.amount_cny,
        category: record.category,
        description: record.description,
        merchant: record.merchant,
        date: record.date
      }

      const id = await repository.insertRecord(row, trx)
      const saved = await repository.fetchRecord(id, userId, trx)
      savedRecords.push(saved)

      const original = originalRecords[index] || {}
      const corrected = isUserCorrected(original, record)
      await repository.insertEvaluation({
        record_id: id,
        user_id: userId,
        ocr_result: JSON.stringify(original),
        user_confirmed: 1,
        user_corrected: corrected ? 1 : 0,
        corrected_category: record.category,
        corrected_amount: record.amount,
        ocr_correct: corrected ? 0 : 1,
        confirmed_at: new Date()
      }, trx)
    }
  })

  for (const record of savedRecords) {
    await embedRecordFn(record).catch(error => logger.warn('[Vector] OCR embed skipped:', error.message))
    await checkBudgetAfterRecordFn({ record }).catch(error => logger.warn('[Monitor] OCR skipped:', error.message))
  }

  return { records: savedRecords, count: savedRecords.length }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/ocrConfirm.test.js
```

Expected: PASS，4 个 OCR confirm 测试通过。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/ocrConfirm.js server/test/ocrConfirm.test.js
git commit -m "feat: add ocr confirmation service"
```

## Task 3: Records OCR 路由闭环

**Files:**
- Modify: `server/src/routes/records.js`
- Test: `server/test/recordsOcrRoute.test.js`

- [ ] **Step 1: 写失败路由测试**

Create `server/test/recordsOcrRoute.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createRecordsRouter } from '../src/routes/records.js'
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

test('POST /api/records/ocr returns OCR session and does not insert records', async () => {
  const calls = { scanned: 0, savedSession: 0, confirmed: 0 }
  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    scanReceiptFn: async imagePath => {
      calls.scanned += 1
      assert.ok(imagePath)
      return {
        summary: '识别到 1 条消费记录',
        totalAmount: 25,
        records: [{ amount: 25, category: '餐饮', date: '2026-07-17', description: '午餐' }]
      }
    },
    ocrSessionService: {
      saveOcrSession: async input => {
        calls.savedSession += 1
        assert.equal(input.userId, 7)
        return { ocrSessionId: 'session-1', expiresInSeconds: 1800, session: input.result }
      },
      readOcrSession: async () => null,
      clearOcrSession: async () => {}
    },
    ocrConfirmService: {
      saveConfirmedOcrRecords: async () => {
        calls.confirmed += 1
        return { records: [], count: 0 }
      }
    }
  }))

  const { server, url } = await listen(app)
  try {
    const formData = new FormData()
    formData.append('image', new Blob(['fake image bytes'], { type: 'image/png' }), 'receipt.png')
    const response = await fetch(`${url}/api/records/ocr`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}` },
      body: formData
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.ocrSessionId, 'session-1')
    assert.equal(json.data.count, 1)
    assert.equal(calls.scanned, 1)
    assert.equal(calls.savedSession, 1)
    assert.equal(calls.confirmed, 0)
  } finally {
    server.close()
  }
})

test('POST /api/records/ocr/confirm saves confirmed records and clears session', async () => {
  const calls = { readSession: 0, clearSession: 0, confirmed: 0 }
  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    ocrSessionService: {
      saveOcrSession: async () => ({ ocrSessionId: 'unused', expiresInSeconds: 1800 }),
      readOcrSession: async input => {
        calls.readSession += 1
        assert.equal(input.userId, 7)
        assert.equal(input.ocrSessionId, 'session-1')
        return { records: [{ amount: 25, category: '餐饮', date: '2026-07-17' }] }
      },
      clearOcrSession: async input => {
        calls.clearSession += 1
        assert.equal(input.ocrSessionId, 'session-1')
      }
    },
    ocrConfirmService: {
      saveConfirmedOcrRecords: async input => {
        calls.confirmed += 1
        assert.equal(input.userId, 7)
        assert.equal(input.confirmedRecords[0].amount, 26)
        return { records: [{ id: 99, amount: 26 }], count: 1 }
      }
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/records/ocr/confirm`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signToken(7)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ocrSessionId: 'session-1',
        records: [{ amount: 26, category: '餐饮', date: '2026-07-17' }]
      })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.count, 1)
    assert.equal(calls.readSession, 1)
    assert.equal(calls.confirmed, 1)
    assert.equal(calls.clearSession, 1)
  } finally {
    server.close()
  }
})

test('POST /api/records/ocr/confirm returns 404 for expired sessions', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    ocrSessionService: {
      saveOcrSession: async () => ({ ocrSessionId: 'unused', expiresInSeconds: 1800 }),
      readOcrSession: async () => null,
      clearOcrSession: async () => {}
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/records/ocr/confirm`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signToken(7)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ocrSessionId: 'expired', records: [{ amount: 26, category: '餐饮', date: '2026-07-17' }] })
    })
    const json = await response.json()

    assert.equal(response.status, 404)
    assert.equal(json.success, false)
    assert.match(json.error, /识别结果已过期/)
  } finally {
    server.close()
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/recordsOcrRoute.test.js
```

Expected: FAIL，错误包含 `The requested module '../src/routes/records.js' does not provide an export named 'createRecordsRouter'`。

- [ ] **Step 3: 改造 records 路由为可注入工厂**

Modify the top and bottom of `server/src/routes/records.js`:

```js
import {
  saveOcrSession,
  readOcrSession,
  clearOcrSession
} from '../services/ocrSession.js'
import { saveConfirmedOcrRecords } from '../services/ocrConfirm.js'
```

Wrap existing route creation:

```js
export function createRecordsRouter({
  dbClient = db,
  scanReceiptFn = scanReceipt,
  ocrSessionService = { saveOcrSession, readOcrSession, clearOcrSession },
  ocrConfirmService = { saveConfirmedOcrRecords }
} = {}) {
  const router = Router()
  router.use(authMiddleware)

  async function fetchRecord(id, userId) {
    return dbClient('records').where({ id, user_id: userId }).first()
  }

  return router
}

export default createRecordsRouter()
```

把现有 `router.get('/')`、`router.post('/')`、`router.put('/:id')`、`router.delete('/:id')`、`router.post('/import')` 都放入 `createRecordsRouter()` 内部。`toCny()` 保持在工厂外，因为它没有路由状态。所有直接访问数据库的位置统一使用 `dbClient`。例如原来的查询构造改成：

```js
const query = dbClient('records as r')
  .select('r.*', dbClient.raw('COALESCE(r.amount_cny, r.amount) as amount_cny'))
  .where('r.user_id', req.userId)
```

- [ ] **Step 4: 改造 `/ocr` 为只识别并保存 Redis 会话**

Replace current `router.post('/ocr', ...)` body with:

```js
router.post('/ocr', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: '缺少图片' })
  try {
    const result = await scanReceiptFn(req.file.path, req.userId)
    const records = Array.isArray(result.records) ? result.records : []

    if (records.length === 0) {
      return res.json({
        success: true,
        data: {
          summary: result.summary,
          totalAmount: result.totalAmount || 0,
          records: [],
          count: 0
        }
      })
    }

    const session = await ocrSessionService.saveOcrSession({
      userId: req.userId,
      file: req.file,
      result: { ...result, records }
    })

    res.json({
      success: true,
      data: {
        ocrSessionId: session.ocrSessionId,
        summary: result.summary,
        totalAmount: result.totalAmount || records.reduce((sum, record) => sum + Number(record.amount || 0), 0),
        records,
        count: records.length,
        expiresInSeconds: session.expiresInSeconds
      }
    })
  } catch (error) {
    console.error('[OCR] failed:', error)
    res.status(500).json({ success: false, error: `图片处理失败: ${error.message}` })
  }
})
```

- [ ] **Step 5: 新增确认和取消路由**

Add after `/ocr` route:

```js
router.post('/ocr/confirm', async (req, res) => {
  const { ocrSessionId, records } = req.body || {}
  const session = await ocrSessionService.readOcrSession({ userId: req.userId, ocrSessionId })
  if (!session) return res.status(404).json({ success: false, error: '识别结果已过期，请重新上传图片' })

  try {
    const result = await ocrConfirmService.saveConfirmedOcrRecords({
      userId: req.userId,
      deviceId: `user-${req.userId}`,
      session,
      confirmedRecords: records
    })
    await ocrSessionService.clearOcrSession({ userId: req.userId, ocrSessionId })
    res.json({ success: true, data: result })
  } catch (error) {
    res.status(400).json({ success: false, error: error.message })
  }
})

router.post('/ocr/cancel', async (req, res) => {
  const { ocrSessionId } = req.body || {}
  await ocrSessionService.clearOcrSession({ userId: req.userId, ocrSessionId })
  res.json({ success: true })
})
```

- [ ] **Step 6: 运行路由测试确认通过**

Run:

```bash
cd server
npm test -- test/recordsOcrRoute.test.js
```

Expected: PASS，3 个 route 测试通过。

- [ ] **Step 7: 运行已有后端测试**

Run:

```bash
cd server
npm test
```

Expected: PASS，现有测试和新增测试全部通过。

- [ ] **Step 8: 提交**

```bash
git add server/src/routes/records.js server/test/recordsOcrRoute.test.js
git commit -m "feat: add ocr confirmation routes"
```

## Task 4: Vision 服务安全与中文修复

**Files:**
- Modify: `server/src/services/vision.js`
- Modify: `server/src/routes/vision.js`
- Test: `server/test/vision.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/vision.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanReceipt, validateOcrResult } from '../src/services/vision.js'

test('validateOcrResult normalizes valid Chinese OCR categories', () => {
  const result = validateOcrResult({
    records: [{
      type: 'expense',
      amount: '25',
      category: '餐饮',
      description: '午餐',
      date: '2026-07-17',
      merchant: '某某餐厅'
    }],
    summary: '识别到 1 条消费记录'
  })

  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].amount, 25)
  assert.equal(result.records[0].category, '餐饮')
  assert.equal(result.totalAmount, 25)
})

test('scanReceipt returns empty OCR result when ZHIPU_API_KEY is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-ocr-'))
  const file = join(dir, 'receipt.png')
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(300).fill(1)]))

  try {
    const result = await scanReceipt(file, 7, {
      zhipuApiKey: '',
      fetchImpl: async () => {
        throw new Error('fetch should not be called without key')
      }
    })

    assert.deepEqual(result.records, [])
    assert.match(result.summary, /未配置图片识别服务/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/vision.test.js
```

Expected: FAIL，错误包含 `does not provide an export named 'validateOcrResult'`，或在缺少 key 时仍尝试调用硬编码 Key。

- [ ] **Step 3: 修复 `vision.js`**

Modify `server/src/services/vision.js` to use this structure:

```js
import fs from 'fs'
import config from '../config.js'

const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const VALID_CATEGORIES = ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他']

const OCR_PROMPT = `你是一个财务记账 OCR 助手。请读取图片中的支付、消费、小票或收据文字，提取消费记录。

只输出严格 JSON，不要 markdown：
{"records":[{"type":"expense","amount":数字,"category":"分类","description":"简短描述","date":"YYYY-MM-DD","merchant":"商家名称"}],"summary":"一句话总结"}

规则：
- amount 必须来自图片中的真实金额。
- category 只能从 餐饮/交通/购物/娱乐/住房/医疗/教育/通讯/礼物/其他 中选择。
- date 转为 YYYY-MM-DD；缺失时使用当前日期。
- 图片不是消费凭证时返回 {"records":[],"summary":"未识别到消费记录"}。
- 不要把“商家名称”“描述”等占位词当成真实数据。`

function detectMediaType(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif'
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp'
  return 'image/jpeg'
}

export async function scanReceipt(imagePath, _userId, {
  zhipuApiKey = config.ai.zhipuApiKey,
  fetchImpl = fetch
} = {}) {
  try {
    const imageBuffer = fs.readFileSync(imagePath)
    if (imageBuffer.length < 200) {
      return { records: [], summary: '图片文件过小，请上传清晰完整的截图。', totalAmount: 0 }
    }

    if (!zhipuApiKey) {
      return { records: [], summary: '未配置图片识别服务，请配置 ZHIPU_API_KEY 后重试。', totalAmount: 0 }
    }

    const mediaType = detectMediaType(imageBuffer)
    const base64 = imageBuffer.toString('base64')
    const zhipuResult = await callZhipu({ base64, mediaType, apiKey: zhipuApiKey, fetchImpl })
    return zhipuResult || {
      records: [],
      summary: '图片识别失败。请确认图片清晰完整，或手动输入消费记录。',
      totalAmount: 0
    }
  } catch (error) {
    console.error('[Vision] 异常:', error.message)
    return { records: [], summary: `识别出错: ${error.message?.slice(0, 80) || '未知错误'}`, totalAmount: 0 }
  }
}

async function callZhipu({ base64, mediaType, apiKey, fetchImpl }) {
  const body = {
    model: 'glm-4v-flash',
    max_tokens: 800,
    temperature: 0.1,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        { type: 'text', text: OCR_PROMPT }
      ]
    }]
  }

  try {
    const res = await fetchImpl(ZHIPU_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    })

    if (!res.ok) return null

    const json = await res.json()
    const text = json.choices?.[0]?.message?.content || ''
    const mdMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const bracketMatch = text.match(/\{[\s\S]*\}/)
    const jsonStr = mdMatch ? mdMatch[1] : (bracketMatch ? bracketMatch[0] : text)
    return validateOcrResult(JSON.parse(jsonStr))
  } catch (error) {
    console.error('[Vision] 智谱解析失败:', error.message)
    return null
  }
}

export function validateOcrResult(result) {
  if (!result || !Array.isArray(result.records)) return null
  if (result.records.length === 0) {
    return { records: [], summary: result.summary || '未识别到消费记录', totalAmount: 0 }
  }

  const clean = []
  for (const input of result.records) {
    const record = { ...input }
    if (typeof record.amount === 'string') record.amount = parseFloat(record.amount)
    if (!record.amount || record.amount <= 0 || record.amount > 100000 || Number.isNaN(record.amount)) continue
    if (!record.date) record.date = new Date().toISOString().slice(0, 10)
    if (!record.category || !VALID_CATEGORIES.includes(record.category)) record.category = '其他'

    const description = String(record.description || '').trim()
    const merchant = String(record.merchant || '').trim()
    clean.push({
      type: record.type === 'income' ? 'income' : 'expense',
      amount: Number(record.amount),
      category: record.category,
      description: description || record.category,
      date: String(record.date).slice(0, 10),
      merchant
    })
  }

  if (clean.length === 0) return { records: [], summary: '图片中未识别到有效的消费记录', totalAmount: 0 }
  const total = clean.reduce((sum, record) => sum + record.amount, 0)
  return {
    records: clean,
    summary: result.summary || `识别到 ${clean.length} 条消费记录，合计 ¥${total.toFixed(2)}`,
    totalAmount: Math.round(total * 100) / 100
  }
}
```

- [ ] **Step 4: 给 `/api/vision` 加鉴权并保持兼容**

Modify `server/src/routes/vision.js`:

```js
import { authMiddleware } from '../middleware/auth.js'

const router = Router()
router.use(authMiddleware)
```

Inside the route, call:

```js
const result = await scanReceipt(req.file.path, req.userId)
```

- [ ] **Step 5: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/vision.test.js
npm test
```

Expected: PASS，vision 测试和全量后端测试通过。

- [ ] **Step 6: 提交**

```bash
git add server/src/services/vision.js server/src/routes/vision.js server/test/vision.test.js
git commit -m "fix: secure ocr vision service"
```

## Task 5: 前端 OCR 确认卡片接入会话确认

**Files:**
- Modify: `client/src/utils/api.js`
- Modify: `client/src/components/ChatWindow.vue`

- [ ] **Step 1: 修改前端 API**

Modify OCR methods in `client/src/utils/api.js`:

```js
  // OCR 识别（不自动保存，返回识别结果供用户确认）
  ocrImage(file) {
    return this.ocrReceipt(file)
  },
  ocrReceipt(file) {
    const formData = new FormData()
    formData.append('image', file)
    return request('/api/records/ocr', {
      method: 'POST',
      body: formData
    })
  },
  confirmOcr(ocrSessionId, records) {
    return request('/api/records/ocr/confirm', {
      method: 'POST',
      body: JSON.stringify({ ocrSessionId, records })
    })
  },
  cancelOcr(ocrSessionId) {
    return request('/api/records/ocr/cancel', {
      method: 'POST',
      body: JSON.stringify({ ocrSessionId })
    })
  },
```

Remove the old `fetch('/api/records/ocr', ...)` implementation so all OCR requests share `request()` headers.

- [ ] **Step 2: 保存 OCR session id**

Modify `client/src/components/ChatWindow.vue` state:

```js
const ocrPending = ref(false)
const ocrRecords = ref([])
const ocrSessionId = ref('')
const savingOcr = ref(false)
```

In `onFileChange`, after successful OCR:

```js
ocrSessionId.value = res.data.ocrSessionId || ''
ocrRecords.value = res.data.records.map(r => ({
  ...r,
  date: r.date || new Date().toISOString().slice(0, 10)
}))
ocrPending.value = true
```

- [ ] **Step 3: 修改取消逻辑**

Replace `cancelOcr()`:

```js
async function cancelOcr() {
  const sessionId = ocrSessionId.value
  ocrPending.value = false
  ocrRecords.value = []
  ocrSessionId.value = ''
  if (sessionId) {
    await api.cancelOcr(sessionId).catch(() => {})
  }
}
```

- [ ] **Step 4: 修改确认逻辑为一次性后端确认**

Replace `confirmOcr()`:

```js
async function confirmOcr() {
  if (!ocrSessionId.value) {
    store.messages.push({
      role: 'assistant',
      content: '识别结果已过期，请重新上传图片。',
      intent: 'chat',
      time: new Date()
    })
    ocrPending.value = false
    ocrRecords.value = []
    scrollToBottom()
    return
  }

  savingOcr.value = true
  try {
    const records = ocrRecords.value
      .filter(rec => rec.amount && rec.category && rec.date)
      .map(rec => ({
        type: rec.type || 'expense',
        amount: rec.amount,
        category: rec.category,
        description: rec.description || rec.category,
        date: rec.date,
        merchant: rec.merchant || null
      }))

    const res = await api.confirmOcr(ocrSessionId.value, records)
    if (!res.success) throw new Error(res.error || '保存失败')

    const saved = res.data.records || []
    const total = saved.reduce((sum, record) => sum + Number(record.amount_cny || record.amount || 0), 0)
    store.messages.push({
      role: 'assistant',
      content: `📷 已保存 ${saved.length} 条消费记录，合计 ¥${total.toFixed(2)}`,
      intent: 'record',
      time: new Date()
    })

    store.refreshToday()
    store.refreshMonthly()
  } catch (e) {
    store.messages.push({
      role: 'assistant',
      content: e.message?.includes('过期') ? '识别结果已过期，请重新上传图片。' : '保存失败，请重试 😅',
      intent: 'chat',
      time: new Date()
    })
  } finally {
    savingOcr.value = false
    ocrPending.value = false
    ocrRecords.value = []
    ocrSessionId.value = ''
  }
  scrollToBottom()
}
```

- [ ] **Step 5: 运行前端构建**

Run:

```bash
cd client
npm run build
```

Expected: PASS，允许保留 Vite chunk size warning。

- [ ] **Step 6: 提交**

```bash
git add client/src/utils/api.js client/src/components/ChatWindow.vue
git commit -m "feat: confirm ocr records from chat"
```

## Task 6: 集成验证与收尾

**Files:**
- No source file changes expected unless verification reveals a bug.

- [ ] **Step 1: 运行后端全量测试**

Run:

```bash
cd server
npm test
```

Expected: PASS，包含 OCR session、confirm、route、vision 新测试。

- [ ] **Step 2: 运行前端构建**

Run:

```bash
cd client
npm run build
```

Expected: PASS。

- [ ] **Step 3: Docker 服务健康检查**

Run:

```bash
docker compose ps
```

Expected: `backend`、`mysql` healthy；`redis`、`qdrant`、`frontend` running。

- [ ] **Step 4: Docker 内跑后端测试或最小接口验证**

Run:

```bash
docker compose exec backend npm test
```

Expected: PASS。

- [ ] **Step 5: 验证 OCR 确认不会提前入库**

Run this PowerShell script from repo root:

```powershell
$login = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/mock-login
$token = $login.data.token
$before = docker compose exec -T mysql mysql -ufinance -pFinancePass2026! smart_finance -N -e "SELECT COUNT(*) FROM records;"
Write-Output "records_before=$before"
```

Expected: prints a numeric `records_before` value. If no real image fixture is available, skip the upload call and use the automated route tests as the no-prewrite proof.

- [ ] **Step 6: 验证没有硬编码智谱 Key**

Run:

```bash
git grep -n "2871e1b0f70f4e61be27b5657873c1c9" -- server/src || true
```

Expected: no output。

- [ ] **Step 7: 最终提交验证修复**

Task 6 默认不产生源码变更。如果验证暴露 bug，回到对应 Task 的失败测试步骤，先补失败测试，再修实现，并使用该 Task 的提交命令提交；不要创建空提交。

Expected: `git status --short` 中没有本阶段未提交文件。

## 自检清单

- 规格覆盖：计划覆盖 Redis OCR 会话、上传不入库、确认入库、取消、`ocr_evaluations`、鉴权、Vision Key、前端确认卡片、测试和 Docker 验证。
- 占位符扫描：计划中不使用未定义的待填内容；验证阶段如发现 bug，回到对应 Task 按 TDD 修复。
- 类型一致性：`ocrSessionId`、`records`、`expiresInSeconds`、`saveOcrSession`、`readOcrSession`、`clearOcrSession`、`saveConfirmedOcrRecords` 在所有任务中命名一致。
- 范围控制：不新增独立页面、不做微信深链、不做 OCR 历史后台。
