# Smart Finance V3 阶段 7 自然语言账本查询增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/api/chat` 对“本月餐饮花了多少”等自然语言查询返回来自 MySQL `records` 的准确账本统计。

**Architecture:** 新增 `financeQuery` 只读聚合服务负责 MySQL 精确统计；扩展 `chatMemory` 输出 queryKind 与更完整 hints；`chat` 路由在 query intent 下优先调用精确查询，Qdrant 仅作为相关记录补充。所有失败都降级为原 Chat 回复，不阻断主流程。

**Tech Stack:** Node.js 22、Express、Knex/MySQL、node:test、Docker Compose。

---

## 文件结构

- 新增 `server/src/services/financeQuery.js`：只读账本聚合、最近记录、最大一笔、回复生成。
- 新增 `server/test/financeQuery.test.js`：验证查询过滤、userId 隔离、回复生成。
- 修改 `server/src/services/chatMemory.js`：增强 `extractQueryHints()`，返回 `type` 与 `queryKind`。
- 修改 `server/test/chatMemory.test.js`：补充 queryKind/type 测试。
- 修改 `server/src/routes/chat.js`：注入并调用 `queryFinanceSummary()`，MySQL 失败降级。
- 修改 `server/test/chatRoute.test.js`：覆盖精确查账、匿名降级、查询服务失败降级。

## Task 1: financeQuery 只读聚合服务

**Files:**
- Create: `server/src/services/financeQuery.js`
- Create: `server/test/financeQuery.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/financeQuery.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFinanceQueryReply,
  queryFinanceSummary
} from '../src/services/financeQuery.js'

function createRecordsDb(rows) {
  return function db(tableName) {
    assert.equal(tableName, 'records')
    const state = { rows: [...rows], limit: null }
    const api = {
      where(field, value) {
        state.rows = state.rows.filter(row => row[field] === value)
        return api
      },
      whereRaw(sql, bindings) {
        if (sql.includes('DATE_FORMAT')) {
          state.rows = state.rows.filter(row => String(row.date).slice(0, 7) === bindings[0])
        }
        return api
      },
      orderBy(field, direction) {
        const key = field.includes('amount') ? 'amount_cny' : field.replace('r.', '')
        state.rows.sort((a, b) => {
          const av = a[key] ?? a.amount
          const bv = b[key] ?? b.amount
          if (av === bv) return 0
          return direction === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
        })
        return api
      },
      limit(value) {
        state.limit = value
        return api
      },
      async select() {
        const rowsToReturn = state.limit ? state.rows.slice(0, state.limit) : state.rows
        return rowsToReturn.map(row => ({
          ...row,
          amount_cny: row.amount_cny ?? row.amount
        }))
      }
    }
    return api
  }
}

test('queryFinanceSummary filters by user month category and type', async () => {
  const db = createRecordsDb([
    { id: 1, user_id: 7, type: 'expense', category: '餐饮', amount: 20, amount_cny: 20, date: '2026-07-18', description: '午饭' },
    { id: 2, user_id: 7, type: 'expense', category: '餐饮', amount: 30, amount_cny: 30, date: '2026-07-17', description: '晚饭' },
    { id: 3, user_id: 7, type: 'expense', category: '购物', amount: 99, amount_cny: 99, date: '2026-07-16', description: '衣服' },
    { id: 4, user_id: 8, type: 'expense', category: '餐饮', amount: 500, amount_cny: 500, date: '2026-07-18', description: '别人' }
  ])

  const summary = await queryFinanceSummary({
    userId: 7,
    hints: { month: '2026-07', category: '餐饮', type: 'expense', queryKind: 'summary' },
    db
  })

  assert.equal(summary.count, 2)
  assert.equal(summary.total, 50)
  assert.equal(summary.maxRecord.amount, 30)
  assert.equal(summary.records.length, 2)
})

test('queryFinanceSummary supports recent and largest query kinds', async () => {
  const db = createRecordsDb([
    { id: 1, user_id: 7, type: 'expense', category: '餐饮', amount: 20, date: '2026-07-18', description: '午饭' },
    { id: 2, user_id: 7, type: 'expense', category: '餐饮', amount: 88, date: '2026-07-10', description: '聚餐' }
  ])

  const recent = await queryFinanceSummary({ userId: 7, hints: { queryKind: 'recent' }, db })
  const largest = await queryFinanceSummary({ userId: 7, hints: { queryKind: 'largest' }, db })

  assert.equal(recent.records[0].id, 1)
  assert.equal(largest.maxRecord.id, 2)
})

test('buildFinanceQueryReply creates summary recent largest and empty replies', () => {
  const summary = {
    hints: { month: '2026-07', category: '餐饮', type: 'expense', queryKind: 'summary' },
    count: 2,
    total: 50,
    average: 25,
    maxRecord: { amount: 30, date: '2026-07-17', description: '晚饭' },
    records: []
  }

  assert.match(buildFinanceQueryReply(summary), /2026-07 餐饮支出共 50\.00 元/)
  assert.match(buildFinanceQueryReply({ ...summary, hints: { ...summary.hints, queryKind: 'largest' } }), /最大一笔/)
  assert.match(buildFinanceQueryReply({
    ...summary,
    hints: { ...summary.hints, queryKind: 'recent' },
    records: [{ amount: 20, date: '2026-07-18', description: '午饭' }]
  }), /最近找到 1 笔/)
  assert.match(buildFinanceQueryReply({ ...summary, count: 0, total: 0, maxRecord: null }), /没找到/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/financeQuery.test.js
```

Expected: FAIL，错误包含 `Cannot find module '../src/services/financeQuery.js'`。

- [ ] **Step 3: 实现 financeQuery**

Create `server/src/services/financeQuery.js`:

```js
import db from '../db.js'

function amountOf(record) {
  return Number(record.amount_cny ?? record.amount ?? 0)
}

function normalizeRecord(record) {
  return {
    ...record,
    amount: amountOf(record),
    amount_cny: amountOf(record)
  }
}

function applyFilters(query, { userId, hints = {} }) {
  query.where('user_id', userId)
  if (hints.month) query.whereRaw('DATE_FORMAT(date, "%Y-%m") = ?', [hints.month])
  if (hints.category) query.where('category', hints.category)
  if (hints.type) query.where('type', hints.type)
  return query
}

function scopeText(hints = {}) {
  const parts = []
  if (hints.month) parts.push(hints.month)
  if (hints.category) parts.push(hints.category)
  if (hints.type === 'income') parts.push('收入')
  if (hints.type === 'expense') parts.push('支出')
  return parts.join(' ') || '当前条件'
}

export async function queryFinanceSummary({
  userId,
  hints = {},
  db: dbClient = db,
  limit = 5
} = {}) {
  if (!userId) {
    return { hints, count: 0, total: 0, average: 0, maxRecord: null, records: [] }
  }

  const baseQuery = applyFilters(dbClient('records'), { userId, hints })
  const records = (await baseQuery.orderBy('date', 'desc').limit(200).select()).map(normalizeRecord)
  const total = records.reduce((sum, record) => sum + amountOf(record), 0)
  const maxRecord = records.reduce((max, record) => {
    if (!max) return record
    return amountOf(record) > amountOf(max) ? record : max
  }, null)

  const orderedRecords = hints.queryKind === 'largest'
    ? [...records].sort((a, b) => amountOf(b) - amountOf(a)).slice(0, limit)
    : records.slice(0, limit)

  return {
    hints,
    count: records.length,
    total,
    average: records.length ? total / records.length : 0,
    maxRecord,
    records: orderedRecords
  }
}

export function buildFinanceQueryReply(summary) {
  const label = scopeText(summary.hints)
  if (!summary.count) return `没找到${label}记录。你可以先记一笔，例如“今天餐饮花了25元”。`

  if (summary.hints?.queryKind === 'recent') {
    const details = summary.records.map(record => `${record.date} ${Number(record.amount).toFixed(2)} 元${record.description ? `（${record.description}）` : ''}`).join('，')
    return `最近找到 ${summary.records.length} 笔${label}记录：${details}。`
  }

  if (summary.hints?.queryKind === 'largest') {
    const record = summary.maxRecord
    return `${label}最大一笔是 ${Number(record.amount).toFixed(2)} 元，记录在 ${record.date}${record.description ? `（${record.description}）` : ''}。`
  }

  const maxText = summary.maxRecord ? `，最大一笔是 ${Number(summary.maxRecord.amount).toFixed(2)} 元` : ''
  return `${label}共 ${summary.total.toFixed(2)} 元，合计 ${summary.count} 笔，平均每笔 ${summary.average.toFixed(2)} 元${maxText}。`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/financeQuery.test.js
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/financeQuery.js server/test/financeQuery.test.js
git commit -m "feat: add finance query aggregation"
```

## Task 2: 扩展 Chat query hints

**Files:**
- Modify: `server/src/services/chatMemory.js`
- Modify: `server/test/chatMemory.test.js`

- [ ] **Step 1: 写失败测试**

Append to `server/test/chatMemory.test.js`:

```js
test('extractQueryHints detects type and query kind', () => {
  assert.deepEqual(extractQueryHints('本月收入多少', { now: new Date(2026, 6, 18) }), {
    month: '2026-07',
    type: 'income',
    queryKind: 'summary'
  })
  assert.deepEqual(extractQueryHints('最近几笔餐饮', { now: new Date(2026, 6, 18) }), {
    category: '餐饮',
    queryKind: 'recent'
  })
  assert.deepEqual(extractQueryHints('本月最大一笔支出', { now: new Date(2026, 6, 18) }), {
    month: '2026-07',
    type: 'expense',
    queryKind: 'largest'
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/chatMemory.test.js
```

Expected: FAIL，`type` 或 `queryKind` 缺失。

- [ ] **Step 3: 实现 hint 扩展**

Modify `server/src/services/chatMemory.js`:

```js
const INCOME_WORDS = ['收入', '工资', '奖金', '收款', '收到']
const EXPENSE_WORDS = ['支出', '花了', '消费', '用了']
const RECENT_WORDS = ['最近', '近几笔', '最近几笔', '明细']
const LARGEST_WORDS = ['最大', '最高', '最贵', '最大一笔']
const SUMMARY_WORDS = ['多少', '合计', '统计', '总共', '一共']

function hasAny(text, words) {
  return words.some(word => text.includes(word))
}
```

Inside `extractQueryHints()` after category extraction:

```js
  if (hasAny(text, INCOME_WORDS)) hints.type = 'income'
  if (hasAny(text, EXPENSE_WORDS)) hints.type = 'expense'

  if (hasAny(text, RECENT_WORDS)) hints.queryKind = 'recent'
  else if (hasAny(text, LARGEST_WORDS)) hints.queryKind = 'largest'
  else if (hasAny(text, SUMMARY_WORDS)) hints.queryKind = 'summary'
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/chatMemory.test.js
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/chatMemory.js server/test/chatMemory.test.js
git commit -m "feat: parse finance query hints"
```

## Task 3: Chat 接入精确账本查询

**Files:**
- Modify: `server/src/routes/chat.js`
- Modify: `server/test/chatRoute.test.js`

- [ ] **Step 1: 写失败测试**

Append to `server/test/chatRoute.test.js`:

```js
test('POST /api/chat answers query with exact finance summary', async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.deviceId = 'device-1'
    next()
  })
  app.use('/api/chat', createChatRouter({
    getUserId: () => 7,
    processMessage: async () => ({ intent: 'query', message: '我可以帮你查看消费统计。', data: null }),
    getConversationContext: async () => [],
    appendConversationMessage: async () => {},
    retrieveSimilar: async () => [],
    queryFinanceSummary: async ({ userId, hints }) => {
      assert.equal(userId, 7)
      assert.equal(hints.month, new Date().toISOString().slice(0, 7))
      assert.equal(hints.category, '餐饮')
      return {
        hints,
        count: 1,
        total: 25,
        average: 25,
        maxRecord: { amount: 25, date: '2026-07-18', description: '午饭' },
        records: []
      }
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
    assert.match(json.data.message, /25\.00 元/)
    assert.equal(json.data.finance.count, 1)
  } finally {
    server.close()
  }
})

test('POST /api/chat degrades when exact finance query fails', async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.deviceId = 'device-1'
    next()
  })
  app.use('/api/chat', createChatRouter({
    getUserId: () => 7,
    processMessage: async () => ({ intent: 'query', message: '我可以帮你查看消费统计。', data: null }),
    getConversationContext: async () => [],
    appendConversationMessage: async () => {},
    retrieveSimilar: async () => [],
    queryFinanceSummary: async () => { throw new Error('mysql down') }
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
    assert.equal(json.data.message, '我可以帮你查看消费统计。')
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

Expected: FAIL，`queryFinanceSummary` 不是可注入依赖或 `finance` 缺失。

- [ ] **Step 3: 实现 Chat 接入**

Modify `server/src/routes/chat.js` imports:

```js
import {
  buildFinanceQueryReply,
  queryFinanceSummary as defaultQueryFinanceSummary
} from '../services/financeQuery.js'
```

Add dependency:

```js
  queryFinanceSummary = defaultQueryFinanceSummary
```

Add helper:

```js
  async function queryFinanceSafely(userId, hints) {
    return withTimeout(queryFinanceSummary({ userId, hints }), 500).catch(error => {
      console.warn('[Chat] finance query skipped:', error.message)
      return null
    })
  }
```

Inside query memory block after `hints`:

```js
        const financeSummary = userId && result.intent === 'query'
          ? await queryFinanceSafely(userId, hints)
          : null
        if (financeSummary) {
          result.message = buildFinanceQueryReply(financeSummary)
          result.finance = {
            count: financeSummary.count,
            total: financeSummary.total,
            average: financeSummary.average,
            hints: financeSummary.hints
          }
        }
```

Ensure `buildMemoryReply()` does not overwrite exact finance reply. Use:

```js
        if (!financeSummary) {
          result.message = buildMemoryReply({ ... })
        }
```

- [ ] **Step 4: 运行相关测试确认通过**

Run:

```bash
cd server
npm test -- test/chatRoute.test.js test/chatMemory.test.js test/financeQuery.test.js
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/chat.js server/test/chatRoute.test.js
git commit -m "feat: answer chat queries from finance records"
```

## Task 4: 集成验证与 Docker smoke

**Files:**
- No source changes expected unless verification reveals a bug.

- [ ] **Step 1: 后端全量测试**

Run:

```bash
cd server
npm test
```

Expected: PASS。

- [ ] **Step 2: 前端构建**

Run:

```bash
cd client
npm run build
```

Expected: PASS，允许既有 Vite chunk size warning。

- [ ] **Step 3: Docker 重建**

Run from repo root in PowerShell:

```powershell
$env:JWT_SECRET='smart-finance-smoke-jwt-secret-20260718-please-replace-in-production'
docker compose up -d --build backend frontend
```

Expected: backend healthy，frontend started。

- [ ] **Step 4: Docker 自然语言查账冒烟**

Run from repo root in PowerShell:

```powershell
$env:JWT_SECRET='smart-finance-smoke-jwt-secret-20260718-please-replace-in-production'
@'
const recordMessage = '\u4eca\u5929\u9910\u996e\u82b1\u4e8625\u5143'
const queryMessage = '\u672c\u6708\u9910\u996e\u82b1\u4e86\u591a\u5c11'

const login = await fetch('http://localhost:3000/api/auth/mock-login', { method: 'POST' }).then(r => r.json())
const token = login.data.token

const record = await fetch('http://localhost:3000/api/chat', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: recordMessage })
}).then(r => r.json())
if (!record.success || !record.data.recordIds?.length) throw new Error(`record failed: ${JSON.stringify(record)}`)

const query = await fetch('http://localhost:3000/api/chat', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: queryMessage })
}).then(r => r.json())
if (!query.success) throw new Error(`query failed: ${JSON.stringify(query)}`)
if (!query.data.message.includes('25.00')) throw new Error(`unexpected query reply: ${query.data.message}`)

console.log(`record_ids=${record.data.recordIds.join(',')}`)
console.log(`query_message=${query.data.message}`)
console.log(`finance_total=${query.data.finance?.total ?? 0}`)
'@ | node --input-type=module -
```

Expected output includes:

```text
record_ids=
query_message=
finance_total=
```

The `query_message` must contain `25.00` or a larger total including the new record.

- [ ] **Step 5: 范围检查**

Run:

```bash
git status --short -- docs/superpowers server/src/services/financeQuery.js server/test/financeQuery.test.js server/src/services/chatMemory.js server/test/chatMemory.test.js server/src/routes/chat.js server/test/chatRoute.test.js
git diff --cached --stat
git log --oneline -10
```

Expected:

- 阶段 7 文件没有未提交改动。
- 暂存区为空。
- 既有阶段外脏文件可以继续存在，但不能被提交。
