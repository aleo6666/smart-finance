# Smart Finance V3 第四阶段观测后端闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 AI/OCR 后端观测闭环，让系统能统一记录调用、聚合统计 OCR/AI 指标，并根据成本或失败规则生成站内告警。

**Architecture:** `observeService` 负责无副作用的调用记录和统计聚合，`alertService` 负责基于观测数据写入 `reminders` 告警，`observe` 路由只暴露当前用户的统计读取。所有新服务都支持 `dbClient` 或函数依赖注入，便于 Node 内置 test 使用内存 fake DB 验证。

**Tech Stack:** Node.js 22、Express、Knex/MySQL、Node 内置 test、Docker Compose。

---

## 文件结构

- 修改 `server/src/services/observeService.js`：新增 `recordLlmCall()`、period 解析、summary/byType/byProvider/OCR 聚合，并让 `recordAgentEvent()` 复用统一写入。
- 新增 `server/test/observeService.test.js`：验证调用写入、Agent 默认值、统计聚合和非法 period 回退。
- 新增 `server/src/services/alertService.js`：新增观测告警规则，写入 `reminders`。
- 新增 `server/test/alertService.test.js`：验证高成本、阈值成本、连续失败和同日去重。
- 修改 `server/src/routes/observe.js`：导出 `createObserveRouter()`，固定使用当前登录用户，支持 `period` query。
- 新增 `server/test/observeRoute.test.js`：验证路由鉴权、period 透传和禁止 query userId 越权。

注意：当前工作区存在既有未提交前端和文档脏改动。实施阶段只提交本阶段明确涉及的 `server/src/services/*`、`server/src/routes/observe.js`、`server/test/*` 文件。

## Task 1: 增强 observeService 记录与统计

**Files:**
- Modify: `server/src/services/observeService.js`
- Test: `server/test/observeService.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/observeService.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getObserveStats,
  recordAgentEvent,
  recordLlmCall
} from '../src/services/observeService.js'

function daysAgo(days) {
  const date = new Date('2026-07-18T12:00:00.000Z')
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

function createTableQuery(rows) {
  const state = {
    where: [],
    whereRaw: [],
    selected: [],
    groupedBy: null,
    inserted: null,
    firstOnly: false
  }

  function applyFilters() {
    return rows.filter(row => {
      for (const condition of state.where) {
        for (const [key, value] of Object.entries(condition)) {
          if (row[key] !== value) return false
        }
      }
      for (const raw of state.whereRaw) {
        if (raw.sql.includes('created_at >=') && new Date(row.created_at) < new Date(raw.bindings[0])) return false
      }
      return true
    })
  }

  const query = {
    state,
    insert(value) {
      rows.push(value)
      state.inserted = value
      return Promise.resolve([rows.length])
    },
    where(condition) {
      state.where.push(condition)
      return query
    },
    whereRaw(sql, bindings) {
      state.whereRaw.push({ sql, bindings })
      return query
    },
    select(...columns) {
      state.selected = columns
      return query
    },
    count() { return query },
    sum() { return query },
    avg() { return query },
    groupBy(column) {
      state.groupedBy = column
      return query
    },
    first() {
      state.firstOnly = true
      return Promise.resolve(applyFilters()[0])
    },
    then(resolve, reject) {
      try {
        const data = applyFilters()
        return Promise.resolve(data).then(resolve, reject)
      } catch (error) {
        return Promise.reject(error).then(resolve, reject)
      }
    }
  }
  return query
}

function createFakeDb(seed) {
  const tables = {
    llm_calls: [...(seed.llm_calls || [])],
    ocr_evaluations: [...(seed.ocr_evaluations || [])]
  }

  function db(table) {
    return createTableQuery(tables[table])
  }

  db.tables = tables
  db.raw = (sql, bindings) => ({ sql, bindings })
  return db
}

test('recordLlmCall writes complete call data', async () => {
  const db = createFakeDb({ llm_calls: [] })

  const result = await recordLlmCall({
    userId: 7,
    conversationId: 'conv-1',
    provider: 'zhipu',
    model: 'glm-4v-flash',
    callType: 'ocr',
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 321,
    costUsd: 0.123456,
    success: false,
    errorMessage: 'timeout',
    dbClient: db
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.success, false)
  assert.equal(db.tables.llm_calls[0].user_id, 7)
  assert.equal(db.tables.llm_calls[0].conversation_id, 'conv-1')
  assert.equal(db.tables.llm_calls[0].provider, 'zhipu')
  assert.equal(db.tables.llm_calls[0].model, 'glm-4v-flash')
  assert.equal(db.tables.llm_calls[0].call_type, 'ocr')
  assert.equal(db.tables.llm_calls[0].input_tokens, 100)
  assert.equal(db.tables.llm_calls[0].output_tokens, 50)
  assert.equal(db.tables.llm_calls[0].latency_ms, 321)
  assert.equal(db.tables.llm_calls[0].cost_usd, 0.123456)
  assert.equal(db.tables.llm_calls[0].success, 0)
  assert.equal(db.tables.llm_calls[0].error_message, 'timeout')
})

test('recordAgentEvent writes local agent defaults through recordLlmCall', async () => {
  const db = createFakeDb({ llm_calls: [] })

  const result = await recordAgentEvent({
    userId: 8,
    callType: 'recorder',
    latencyMs: 44,
    dbClient: db
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(db.tables.llm_calls[0].provider, 'local')
  assert.equal(db.tables.llm_calls[0].model, 'agent')
  assert.equal(db.tables.llm_calls[0].call_type, 'recorder')
  assert.equal(db.tables.llm_calls[0].latency_ms, 44)
  assert.equal(db.tables.llm_calls[0].cost_usd, 0)
})

test('getObserveStats aggregates calls providers and OCR accuracy for user and period', async () => {
  const db = createFakeDb({
    llm_calls: [
      { user_id: 7, provider: 'local', model: 'agent', call_type: 'agent', input_tokens: 0, output_tokens: 0, latency_ms: 20, cost_usd: 0, success: 1, created_at: daysAgo(1) },
      { user_id: 7, provider: 'zhipu', model: 'glm-4v-flash', call_type: 'ocr', input_tokens: 100, output_tokens: 50, latency_ms: 300, cost_usd: 0.12, success: 1, created_at: daysAgo(2) },
      { user_id: 7, provider: 'zhipu', model: 'glm-4v-flash', call_type: 'ocr', input_tokens: 100, output_tokens: 0, latency_ms: 900, cost_usd: 0.2, success: 0, created_at: daysAgo(3) },
      { user_id: 9, provider: 'zhipu', model: 'other', call_type: 'ocr', input_tokens: 100, output_tokens: 0, latency_ms: 100, cost_usd: 9, success: 1, created_at: daysAgo(1) },
      { user_id: 7, provider: 'old', model: 'old', call_type: 'llm', input_tokens: 1, output_tokens: 1, latency_ms: 1, cost_usd: 1, success: 1, created_at: daysAgo(40) }
    ],
    ocr_evaluations: [
      { user_id: 7, user_confirmed: 1, user_corrected: 0, ocr_correct: 1, created_at: daysAgo(1) },
      { user_id: 7, user_confirmed: 1, user_corrected: 1, ocr_correct: 0, created_at: daysAgo(2) },
      { user_id: 7, user_confirmed: 0, user_corrected: 0, ocr_correct: null, created_at: daysAgo(3) },
      { user_id: 9, user_confirmed: 1, user_corrected: 0, ocr_correct: 1, created_at: daysAgo(1) }
    ]
  })

  const stats = await getObserveStats({
    userId: 7,
    period: '30d',
    now: new Date('2026-07-18T12:00:00.000Z'),
    dbClient: db
  })

  assert.deepEqual(stats.period, { key: '30d', days: 30 })
  assert.equal(stats.summary.calls, 3)
  assert.equal(stats.summary.failures, 1)
  assert.equal(stats.summary.successRate, 66.67)
  assert.equal(stats.summary.totalCostUsd, 0.32)
  assert.equal(stats.summary.avgLatencyMs, 407)
  assert.deepEqual(stats.byType.map(row => row.callType), ['agent', 'ocr'])
  assert.equal(stats.byType.find(row => row.callType === 'ocr').failures, 1)
  assert.deepEqual(stats.byProvider.map(row => row.provider), ['local', 'zhipu'])
  assert.deepEqual(stats.ocr, { total: 3, confirmed: 2, corrected: 1, accuracy: 50 })
})

test('getObserveStats falls back invalid period to 30d', async () => {
  const db = createFakeDb({ llm_calls: [], ocr_evaluations: [] })

  const stats = await getObserveStats({
    userId: 7,
    period: 'bad',
    now: new Date('2026-07-18T12:00:00.000Z'),
    dbClient: db
  })

  assert.deepEqual(stats.period, { key: '30d', days: 30 })
  assert.equal(stats.summary.calls, 0)
  assert.equal(stats.summary.successRate, 100)
  assert.equal(stats.ocr.accuracy, null)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/observeService.test.js
```

Expected: FAIL，错误包含 `does not provide an export named 'recordLlmCall'`。

- [ ] **Step 3: 实现 observeService**

Replace `server/src/services/observeService.js` with:

```js
import db from '../db.js'

const PERIODS = {
  '1d': 1,
  '7d': 7,
  '30d': 30
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(normalizeNumber(value) * factor) / factor
}

export function resolvePeriod(period = '30d', now = new Date()) {
  const key = Object.hasOwn(PERIODS, period) ? period : '30d'
  const days = PERIODS[key]
  const since = new Date(now)
  since.setUTCDate(since.getUTCDate() - days)
  return {
    key,
    days,
    since: since.toISOString().slice(0, 19).replace('T', ' ')
  }
}

function filterRows(rows, { userId, since }) {
  return rows.filter(row => {
    if (userId && row.user_id !== userId) return false
    if (since && row.created_at && new Date(row.created_at) < new Date(since)) return false
    return true
  })
}

function groupBy(rows, key) {
  const groups = new Map()
  for (const row of rows) {
    const groupKey = row[key] || 'unknown'
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey).push(row)
  }
  return groups
}

function aggregateCalls(rows) {
  const calls = rows.length
  const failures = rows.filter(row => Number(row.success) === 0).length
  const totalCostUsd = round(rows.reduce((sum, row) => sum + normalizeNumber(row.cost_usd), 0), 6)
  const avgLatencyMs = calls
    ? Math.round(rows.reduce((sum, row) => sum + normalizeNumber(row.latency_ms), 0) / calls)
    : 0
  const successRate = calls ? round(((calls - failures) / calls) * 100, 2) : 100
  return { calls, failures, successRate, totalCostUsd, avgLatencyMs }
}

function aggregateBy(rows, key, outputKey) {
  return [...groupBy(rows, key).entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([groupKey, groupRows]) => {
      const summary = aggregateCalls(groupRows)
      return {
        [outputKey]: groupKey,
        calls: summary.calls,
        failures: summary.failures,
        totalCostUsd: summary.totalCostUsd,
        avgLatencyMs: summary.avgLatencyMs
      }
    })
}

function aggregateOcr(rows) {
  const total = rows.length
  const confirmedRows = rows.filter(row => Number(row.user_confirmed) === 1)
  const confirmed = confirmedRows.length
  const corrected = rows.filter(row => Number(row.user_corrected) === 1).length
  const correct = confirmedRows.filter(row => Number(row.ocr_correct) === 1).length
  return {
    total,
    confirmed,
    corrected,
    accuracy: confirmed ? round((correct / confirmed) * 100, 2) : null
  }
}

async function readRows(dbClient, table, { userId, since }) {
  const query = dbClient(table).where({ user_id: userId })
  if (since) query.whereRaw('created_at >= ?', [since])
  return query
}

export async function recordLlmCall({
  userId = null,
  conversationId = null,
  provider = 'local',
  model = 'unknown',
  callType = 'llm',
  inputTokens = 0,
  outputTokens = 0,
  latencyMs = 0,
  costUsd = 0,
  success = true,
  errorMessage = null,
  dbClient = db
}) {
  await dbClient('llm_calls').insert({
    user_id: userId,
    conversation_id: conversationId,
    provider,
    model,
    call_type: callType,
    input_tokens: Math.max(0, Math.floor(normalizeNumber(inputTokens))),
    output_tokens: Math.max(0, Math.floor(normalizeNumber(outputTokens))),
    latency_ms: Math.max(0, Math.floor(normalizeNumber(latencyMs))),
    cost_usd: round(costUsd, 6),
    success: success ? 1 : 0,
    error_message: errorMessage
  })

  return { status: success ? 'succeeded' : 'failed', success: Boolean(success) }
}

export async function recordAgentEvent({
  userId = null,
  callType = 'agent',
  latencyMs = 0,
  success = true,
  errorMessage = null,
  dbClient = db
}) {
  return recordLlmCall({
    userId,
    provider: 'local',
    model: 'agent',
    callType,
    latencyMs,
    success,
    errorMessage,
    dbClient
  })
}

export async function getObserveStats({
  userId,
  period = '30d',
  now = new Date(),
  dbClient = db
} = {}) {
  const resolved = resolvePeriod(period, now)
  const [llmRows, ocrRows] = await Promise.all([
    readRows(dbClient, 'llm_calls', { userId, since: resolved.since }),
    readRows(dbClient, 'ocr_evaluations', { userId, since: resolved.since })
  ])

  const scopedLlmRows = filterRows(llmRows, { userId, since: resolved.since })
  const scopedOcrRows = filterRows(ocrRows, { userId, since: resolved.since })

  return {
    summary: aggregateCalls(scopedLlmRows),
    byType: aggregateBy(scopedLlmRows, 'call_type', 'callType'),
    byProvider: aggregateBy(scopedLlmRows, 'provider', 'provider'),
    ocr: aggregateOcr(scopedOcrRows),
    period: { key: resolved.key, days: resolved.days }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/observeService.test.js
```

Expected: PASS，4 个 observeService 测试通过。

- [ ] **Step 5: 运行现有 Agent 测试防回归**

Run:

```bash
cd server
npm test -- test/agentFlow.test.js test/observeService.test.js
```

Expected: PASS，Agent flow 和 observeService 测试通过。

- [ ] **Step 6: 提交**

```bash
git add server/src/services/observeService.js server/test/observeService.test.js
git commit -m "feat: aggregate observe backend stats"
```

## Task 2: 新增 alertService 观测告警

**Files:**
- Create: `server/src/services/alertService.js`
- Test: `server/test/alertService.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/alertService.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkObserveAlerts } from '../src/services/alertService.js'

function createQuery(table, tables) {
  const state = { where: [], whereNull: [], order: null, limit: null }
  const query = {
    where(condition) {
      state.where.push(condition)
      return query
    },
    whereNull(column) {
      state.whereNull.push(column)
      return query
    },
    orderBy(column, direction = 'asc') {
      state.order = { column, direction }
      return query
    },
    limit(value) {
      state.limit = value
      return query
    },
    async insert(value) {
      tables[table].push({ id: tables[table].length + 1, ...value })
      return [tables[table].length]
    },
    async first() {
      return apply()[0]
    },
    sum() {
      return {
        first: async () => ({
          total: apply().reduce((sum, row) => sum + Number(row.cost_usd || 0), 0)
        })
      }
    },
    then(resolve, reject) {
      return Promise.resolve(apply()).then(resolve, reject)
    }
  }

  function apply() {
    let rows = [...tables[table]]
    for (const condition of state.where) {
      rows = rows.filter(row => Object.entries(condition).every(([key, value]) => row[key] === value))
    }
    for (const column of state.whereNull) {
      rows = rows.filter(row => row[column] == null)
    }
    if (state.order) {
      rows.sort((a, b) => {
        const left = a[state.order.column]
        const right = b[state.order.column]
        if (left === right) return 0
        return state.order.direction === 'desc' ? (left > right ? -1 : 1) : (left > right ? 1 : -1)
      })
    }
    if (state.limit) rows = rows.slice(0, state.limit)
    return rows
  }

  return query
}

function createFakeDb(seed = {}) {
  const tables = {
    llm_calls: [...(seed.llm_calls || [])],
    reminders: [...(seed.reminders || [])],
    cost_alert_rules: [...(seed.cost_alert_rules || [])]
  }

  function db(table) {
    return createQuery(table, tables)
  }

  db.tables = tables
  db.fn = { now: () => 'NOW' }
  return db
}

test('checkObserveAlerts creates cost spike reminder for expensive single call', async () => {
  const db = createFakeDb()

  const result = await checkObserveAlerts({
    userId: 7,
    lastCall: { costUsd: 0.6, success: true },
    now: new Date('2026-07-18T10:00:00.000Z'),
    dbClient: db
  })

  assert.deepEqual(result.created.map(item => item.type), ['alert:cost_spike'])
  assert.equal(db.tables.reminders[0].user_id, 7)
  assert.equal(db.tables.reminders[0].type, 'alert:cost_spike')
  assert.equal(db.tables.reminders[0].status, 'pending')
})

test('checkObserveAlerts creates threshold reminder from user cost rule', async () => {
  const db = createFakeDb({
    llm_calls: [
      { user_id: 7, cost_usd: 0.7, success: 1, created_at: '2026-07-18 09:00:00' },
      { user_id: 7, cost_usd: 0.5, success: 1, created_at: '2026-07-18 08:00:00' }
    ],
    cost_alert_rules: [
      { user_id: 7, threshold_usd: 1, period_days: 1, enabled: 1 }
    ]
  })

  const result = await checkObserveAlerts({
    userId: 7,
    lastCall: { costUsd: 0.1, success: true },
    now: new Date('2026-07-18T10:00:00.000Z'),
    dbClient: db
  })

  assert.equal(result.created.some(item => item.type === 'alert:cost_threshold'), true)
  assert.equal(db.tables.reminders.at(-1).type, 'alert:cost_threshold')
})

test('checkObserveAlerts creates failures reminder after three recent failures', async () => {
  const db = createFakeDb({
    llm_calls: [
      { user_id: 7, cost_usd: 0, success: 0, created_at: '2026-07-18 09:03:00' },
      { user_id: 7, cost_usd: 0, success: 0, created_at: '2026-07-18 09:02:00' },
      { user_id: 7, cost_usd: 0, success: 0, created_at: '2026-07-18 09:01:00' },
      { user_id: 7, cost_usd: 0, success: 1, created_at: '2026-07-18 08:00:00' }
    ]
  })

  const result = await checkObserveAlerts({
    userId: 7,
    lastCall: { costUsd: 0, success: false },
    now: new Date('2026-07-18T10:00:00.000Z'),
    dbClient: db
  })

  assert.deepEqual(result.created.map(item => item.type), ['alert:llm_failures'])
})

test('checkObserveAlerts deduplicates same alert type during same day', async () => {
  const db = createFakeDb({
    reminders: [
      { user_id: 7, type: 'alert:cost_spike', status: 'pending', created_at: '2026-07-18 08:00:00' }
    ]
  })

  const result = await checkObserveAlerts({
    userId: 7,
    lastCall: { costUsd: 0.7, success: true },
    now: new Date('2026-07-18T10:00:00.000Z'),
    dbClient: db
  })

  assert.deepEqual(result.created, [])
  assert.equal(db.tables.reminders.length, 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/alertService.test.js
```

Expected: FAIL，错误包含 `Cannot find module` 或 `does not provide an export named 'checkObserveAlerts'`。

- [ ] **Step 3: 实现 alertService**

Create `server/src/services/alertService.js`:

```js
import db from '../db.js'

const COST_SPIKE_THRESHOLD = 0.5

function money(value) {
  return Number(value || 0).toFixed(4)
}

function dateText(date) {
  return date.toISOString().slice(0, 10)
}

function sinceDate(now, days) {
  const since = new Date(now)
  since.setUTCDate(since.getUTCDate() - days)
  return since.toISOString().slice(0, 19).replace('T', ' ')
}

async function hasPendingToday({ userId, type, now, dbClient }) {
  const rows = await dbClient('reminders')
    .where({ user_id: userId, type, status: 'pending' })
  const today = dateText(now)
  return rows.some(row => String(row.created_at || '').slice(0, 10) === today)
}

async function createReminder({ userId, type, title, message, severity, dbClient }) {
  await dbClient('reminders').insert({
    user_id: userId,
    type,
    title,
    message,
    channel: 'inapp',
    status: 'pending'
  })
  return { type, severity }
}

async function createOnceToday(input) {
  if (await hasPendingToday(input)) return null
  return createReminder(input)
}

async function getActiveRule({ userId, dbClient }) {
  const userRule = await dbClient('cost_alert_rules')
    .where({ user_id: userId, enabled: 1 })
    .first()
  if (userRule) return userRule
  return dbClient('cost_alert_rules')
    .where({ enabled: 1 })
    .whereNull('user_id')
    .first()
}

async function sumPeriodCost({ userId, periodDays, now, dbClient }) {
  const since = sinceDate(now, periodDays)
  const rows = await dbClient('llm_calls').where({ user_id: userId })
  return rows
    .filter(row => !row.created_at || new Date(row.created_at) >= new Date(since))
    .reduce((sum, row) => sum + Number(row.cost_usd || 0), 0)
}

async function recentFailures({ userId, dbClient }) {
  const rows = await dbClient('llm_calls')
    .where({ user_id: userId })
    .orderBy('created_at', 'desc')
    .limit(3)
  return rows.length === 3 && rows.every(row => Number(row.success) === 0)
}

export async function checkObserveAlerts({
  userId,
  lastCall = {},
  now = new Date(),
  dbClient = db
}) {
  const created = []
  if (!userId) return { created }

  const costUsd = Number(lastCall.costUsd ?? lastCall.cost_usd ?? 0)
  if (costUsd > COST_SPIKE_THRESHOLD) {
    const alert = await createOnceToday({
      userId,
      type: 'alert:cost_spike',
      title: '[WARNING] AI 成本告警',
      message: `AI 单次调用成本较高：$${money(costUsd)}`,
      severity: 'warning',
      now,
      dbClient
    })
    if (alert) created.push(alert)
  }

  const rule = await getActiveRule({ userId, dbClient })
  if (rule) {
    const total = await sumPeriodCost({ userId, periodDays: Number(rule.period_days || 1), now, dbClient })
    const threshold = Number(rule.threshold_usd || 0)
    if (threshold > 0 && total > threshold) {
      const alert = await createOnceToday({
        userId,
        type: 'alert:cost_threshold',
        title: '[CRITICAL] AI 成本告警',
        message: `AI 成本已超过阈值：$${money(total)} / $${money(threshold)}`,
        severity: 'critical',
        now,
        dbClient
      })
      if (alert) created.push(alert)
    }
  }

  if (await recentFailures({ userId, dbClient })) {
    const alert = await createOnceToday({
      userId,
      type: 'alert:llm_failures',
      title: '[CRITICAL] AI 调用失败',
      message: 'AI 调用连续失败 3 次，请检查服务配置',
      severity: 'critical',
      now,
      dbClient
    })
    if (alert) created.push(alert)
  }

  return { created }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/alertService.test.js
```

Expected: PASS，4 个 alertService 测试通过。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/alertService.js server/test/alertService.test.js
git commit -m "feat: add observe alert service"
```

## Task 3: observe 路由按当前用户输出完整统计

**Files:**
- Modify: `server/src/routes/observe.js`
- Test: `server/test/observeRoute.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/observeRoute.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createObserveRouter } from '../src/routes/observe.js'
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

test('GET /api/observe/stats uses authenticated user and period query', async () => {
  const calls = []
  const app = express()
  app.use('/api/observe', createObserveRouter({
    getObserveStats: async input => {
      calls.push(input)
      return { summary: { calls: 1 }, period: { key: input.period, days: 7 } }
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/observe/stats?period=7d&userId=999`, {
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(calls[0].userId, 7)
    assert.equal(calls[0].period, '7d')
    assert.equal(json.data.summary.calls, 1)
  } finally {
    server.close()
  }
})

test('GET /api/observe/stats requires auth', async () => {
  const app = express()
  app.use('/api/observe', createObserveRouter({
    getObserveStats: async () => ({ summary: { calls: 0 } })
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/observe/stats`)
    const json = await response.json()
    assert.equal(response.status, 401)
    assert.equal(json.success, false)
  } finally {
    server.close()
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/observeRoute.test.js
```

Expected: FAIL，错误包含 `does not provide an export named 'createObserveRouter'`。

- [ ] **Step 3: 改造 observe 路由**

Replace `server/src/routes/observe.js` with:

```js
import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { getObserveStats as defaultGetObserveStats } from '../services/observeService.js'

export function createObserveRouter({
  getObserveStats = defaultGetObserveStats
} = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.get('/stats', async (req, res) => {
    const data = await getObserveStats({
      userId: req.userId,
      period: req.query.period
    })
    res.json({ success: true, data })
  })

  return router
}

export default createObserveRouter()
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/observeRoute.test.js test/observeService.test.js
```

Expected: PASS，observe route 和 observeService 测试通过。

- [ ] **Step 5: 运行后端全量测试**

Run:

```bash
cd server
npm test
```

Expected: PASS，所有后端测试通过。

- [ ] **Step 6: 提交**

```bash
git add server/src/routes/observe.js server/test/observeRoute.test.js
git commit -m "feat: scope observe stats route"
```

## Task 4: 集成验证与 Docker smoke

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

- [ ] **Step 4: Docker smoke 验证 observe stats**

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

mysql(`INSERT INTO llm_calls (user_id,provider,model,call_type,input_tokens,output_tokens,latency_ms,cost_usd,success) VALUES (${userId},'local','agent','agent',0,0,12,0,1);`)
mysql(`INSERT INTO ocr_evaluations (user_id,ocr_result,user_confirmed,user_corrected,ocr_correct) VALUES (${userId},'{\"records\":[]}',1,0,1);`)

const stats = await fetch('http://localhost:3000/api/observe/stats?period=30d', {
  headers: { Authorization: `Bearer ${token}` }
}).then(r => r.json())

if (!stats.success) throw new Error('observe stats failed')
if (stats.data.summary.calls < 1) throw new Error('missing llm call stats')
if (stats.data.ocr.total < 1) throw new Error('missing ocr stats')

console.log(`calls=${stats.data.summary.calls}`)
console.log(`ocr_total=${stats.data.ocr.total} ocr_accuracy=${stats.data.ocr.accuracy}`)
'@ | node --input-type=module -
```

Expected output includes:

```text
calls=<number at least 1>
ocr_total=<number at least 1> ocr_accuracy=<number or null>
```

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

- 规格覆盖：计划覆盖统一记录、Agent 兼容、完整统计、OCR 正确率、告警服务、路由用户隔离、测试和 Docker smoke。
- 占位符扫描：未发现红旗占位表述，所有代码步骤都给出具体片段或命令。
- 类型一致性：`recordLlmCall()`、`recordAgentEvent()`、`getObserveStats()`、`checkObserveAlerts()`、`summary/byType/byProvider/ocr/period` 在测试、实现和路由中命名一致。
- 范围控制：不新增前端观测面板、不新增表、不接真实微信推送、不改变自然语言记账和 OCR 确认流程。
