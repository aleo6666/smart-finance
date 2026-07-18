# Smart Finance V3 阶段 8 报表导出分享闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将报表生成、Excel/PDF/PNG 导出和报表分享串成可验证闭环，全部基于 MySQL/Knex 并按 `user_id` 隔离。

**Architecture:** 正式接管已有未跟踪的报表/导出文件，把旧 SQLite `db.prepare` 实现迁移为 Knex/MySQL；导出服务返回 buffer，路由负责 Content-Type/下载头；分享逻辑复用 `reports`/`report_shares` 表并补用户归属校验。

**Tech Stack:** Node.js 22、Express、Knex/MySQL、ExcelJS、PDFKit、Canvas、QRCode、node:test、Docker Compose。

---

## 文件结构

- Modify/Add: `server/src/services/reportGenerator.js`：Knex 版报表生成。
- Modify/Add: `server/src/services/exporter.js`：buffer 型 Excel/PDF/PNG/QR 生成。
- Modify/Add: `server/src/routes/export.js`：认证导出接口。
- Modify: `server/src/routes/reports.js`：分享接口补 ownership 校验。
- Add: `server/test/reportGenerator.test.js`。
- Add: `server/test/exporter.test.js`。
- Add: `server/test/exportRoute.test.js`。
- Add: `server/test/reportShare.test.js`。

## Task 1: Knex 报表生成服务

**Files:**
- Modify/Add: `server/src/services/reportGenerator.js`
- Add: `server/test/reportGenerator.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/reportGenerator.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, periodRange } from '../src/services/reportGenerator.js'

function createReportDb(rows) {
  return function db(tableName) {
    assert.equal(tableName, 'records as r')
    const state = { rows: [...rows], limit: null, offset: 0, aggregate: null, groupBy: null }
    const api = {
      where(field, value) {
        const key = field.replace('r.', '')
        state.rows = state.rows.filter(row => row[key] === value)
        return api
      },
      whereRaw(sql, bindings) {
        if (sql.includes('r.date >= ?') && sql.includes('r.date <= ?')) {
          state.rows = state.rows.filter(row => row.date >= bindings[0] && row.date <= bindings[1])
        }
        if (sql.includes('r.merchant LIKE')) {
          const keyword = bindings[0].replaceAll('%', '')
          state.rows = state.rows.filter(row => String(row.merchant || '').includes(keyword))
        }
        return api
      },
      select(...columns) {
        if (columns.includes('r.category')) state.groupBy = 'category'
        if (columns.includes('r.currency')) state.groupBy = 'currency'
        return api
      },
      sum(mapping) {
        state.aggregate = { ...(state.aggregate || {}), ...mapping }
        return api
      },
      count(mapping) {
        state.aggregate = { ...(state.aggregate || {}), ...mapping }
        return api
      },
      groupBy(field) {
        state.groupBy = field.replace('r.', '')
        return api
      },
      orderBy() { return api },
      limit(value) { state.limit = value; return api },
      offset(value) { state.offset = value; return api },
      async first() {
        const rows = await api
        return rows[0]
      },
      then(resolve, reject) {
        try {
          resolve(materialize())
        } catch (error) {
          reject(error)
        }
      }
    }

    function amountOf(row) {
      return Number(row.amount_cny ?? row.amount ?? 0)
    }

    function materialize() {
      if (state.groupBy === 'type') {
        return ['income', 'expense'].map(type => {
          const scoped = state.rows.filter(row => row.type === type)
          return { type, total: scoped.reduce((sum, row) => sum + amountOf(row), 0), count: scoped.length }
        }).filter(row => row.count)
      }
      if (state.groupBy === 'category') {
        const map = new Map()
        for (const row of state.rows.filter(item => item.type === 'expense')) {
          const current = map.get(row.category) || { category: row.category, total: 0, count: 0 }
          current.total += amountOf(row)
          current.count += 1
          map.set(row.category, current)
        }
        return [...map.values()].sort((a, b) => b.total - a.total)
      }
      if (state.groupBy === 'currency') {
        const map = new Map()
        for (const row of state.rows) {
          const current = map.get(row.currency) || { currency: row.currency, total: 0 }
          current.total += Number(row.amount || 0)
          map.set(row.currency, current)
        }
        return [...map.values()]
      }
      return state.rows.slice(state.offset, state.limit ? state.offset + state.limit : undefined).map(row => ({
        ...row,
        amount_cny: amountOf(row)
      }))
    }

    return api
  }
}

test('periodRange supports month quarter year and week', () => {
  assert.deepEqual(periodRange('month', '2026-07'), { start: '2026-07-01', end: '2026-07-31' })
  assert.deepEqual(periodRange('quarter', '2026-Q2'), { start: '2026-04-01', end: '2026-06-30' })
  assert.deepEqual(periodRange('year', '2026'), { start: '2026-01-01', end: '2026-12-31' })
  assert.deepEqual(periodRange('week', '2026-07-13'), { start: '2026-07-13', end: '2026-07-19' })
})

test('buildReport aggregates records by user period category and returns limited details', async () => {
  const db = createReportDb([
    { id: 1, user_id: 7, type: 'income', category: '工资', amount: 500, amount_cny: 500, currency: 'CNY', date: '2026-07-01' },
    { id: 2, user_id: 7, type: 'expense', category: '餐饮', amount: 20, amount_cny: 20, currency: 'CNY', date: '2026-07-18', description: '午饭' },
    { id: 3, user_id: 7, type: 'expense', category: '购物', amount: 80, amount_cny: 80, currency: 'CNY', date: '2026-07-17' },
    { id: 4, user_id: 8, type: 'expense', category: '餐饮', amount: 999, amount_cny: 999, currency: 'CNY', date: '2026-07-18' }
  ])

  const report = await buildReport({
    userId: 7,
    periodType: 'month',
    periodValue: '2026-07',
    filters: { limit: 2 },
    db
  })

  assert.equal(report.income, 500)
  assert.equal(report.expense, 100)
  assert.equal(report.balance, 400)
  assert.equal(report.count, 2)
  assert.deepEqual(report.byCategory.map(item => item.category), ['购物', '餐饮'])
  assert.equal(report.records.length, 2)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/reportGenerator.test.js
```

Expected: FAIL，旧实现使用 `db.prepare` 或 `buildReport` 不是 async/Knex。

- [ ] **Step 3: 实现 Knex 报表服务**

Replace `server/src/services/reportGenerator.js` with an async Knex implementation:

```js
import db from '../db.js'

export function periodRange(type, value) {
  if (type === 'month') {
    const [year, month] = value.split('-').map(Number)
    const end = new Date(year, month, 0).toISOString().slice(0, 10)
    return { start: `${value}-01`, end }
  }
  if (type === 'year') return { start: `${value}-01-01`, end: `${value}-12-31` }
  if (type === 'quarter') {
    const [yearText, quarterText] = value.split('-Q')
    const year = Number(yearText)
    const quarter = Number(quarterText)
    const startMonth = (quarter - 1) * 3 + 1
    const endMonth = quarter * 3
    const end = new Date(year, endMonth, 0).toISOString().slice(0, 10)
    return { start: `${year}-${String(startMonth).padStart(2, '0')}-01`, end }
  }
  if (type === 'week') {
    const start = new Date(`${value}T00:00:00`)
    const end = new Date(start)
    end.setDate(start.getDate() + 6)
    return { start: value, end: end.toISOString().slice(0, 10) }
  }
  return { start: '0000-01-01', end: '9999-12-31' }
}

function applyReportFilters(query, { userId, ledgerId, start, end, filters = {} }) {
  query.where('r.user_id', userId)
  query.whereRaw('r.date >= ? AND r.date <= ?', [start, end])
  if (ledgerId) query.where('r.ledger_id', Number(ledgerId))
  if (filters.category) query.where('r.category', filters.category)
  if (filters.member) query.where('r.member', filters.member)
  if (filters.merchant) query.whereRaw('r.merchant LIKE ?', [`%${filters.merchant}%`])
  if (filters.project) query.where('r.project', filters.project)
  return query
}

function amountOf(row) {
  return Number(row.amount_cny ?? row.amount ?? 0)
}

export async function buildReport({
  userId,
  ledgerId = null,
  periodType = 'month',
  periodValue = new Date().toISOString().slice(0, 7),
  filters = {},
  db: dbClient = db
} = {}) {
  const { start, end } = periodRange(periodType, periodValue)
  const limit = Number(filters.limit || 2000)
  const offset = Number(filters.offset || 0)
  const scoped = () => applyReportFilters(dbClient('records as r'), { userId, ledgerId, start, end, filters })

  const totals = await scoped()
    .select('r.type')
    .sum({ total: dbClient.raw('COALESCE(r.amount_cny, r.amount)') })
    .count({ count: '*' })
    .groupBy('r.type')

  const income = Number(totals.find(row => row.type === 'income')?.total || 0)
  const expense = Number(totals.find(row => row.type === 'expense')?.total || 0)

  const incomeByCurrency = await scoped()
    .where('r.type', 'income')
    .select('r.currency')
    .sum({ total: 'r.amount' })
    .groupBy('r.currency')

  const expenseByCurrency = await scoped()
    .where('r.type', 'expense')
    .select('r.currency')
    .sum({ total: 'r.amount' })
    .groupBy('r.currency')

  const byCategory = await scoped()
    .where('r.type', 'expense')
    .select('r.category')
    .sum({ total: dbClient.raw('COALESCE(r.amount_cny, r.amount)') })
    .count({ count: '*' })
    .groupBy('r.category')
    .orderBy('total', 'desc')

  const sortOrder = filters.sortOrder === 'asc' ? 'asc' : 'desc'
  const sortBy = filters.sortBy === 'amount' ? dbClient.raw('COALESCE(r.amount_cny, r.amount)') : 'r.date'
  const records = await scoped()
    .select('r.*', dbClient.raw('COALESCE(r.amount_cny, r.amount) as amount_cny'))
    .orderBy(sortBy, sortOrder)
    .limit(limit)
    .offset(offset)

  return {
    period: { type: periodType, value: periodValue, start, end },
    income,
    expense,
    balance: income - expense,
    incomeByCurrency,
    expenseByCurrency,
    byCategory,
    count: records.length,
    records: records.map(record => ({ ...record, amount_cny: amountOf(record) }))
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/reportGenerator.test.js
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/reportGenerator.js server/test/reportGenerator.test.js
git commit -m "feat: generate reports with knex"
```

## Task 2: Buffer 型导出服务

**Files:**
- Modify/Add: `server/src/services/exporter.js`
- Add: `server/test/exporter.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/exporter.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExcelBuffer,
  buildImageBuffer,
  buildPdfBuffer,
  makeShareQr
} from '../src/services/exporter.js'

const report = {
  income: 500,
  expense: 125,
  balance: 375,
  byCategory: [{ category: '餐饮', total: 125, count: 5 }],
  records: [{ date: '2026-07-18', type: 'expense', category: '餐饮', amount: 25, currency: 'CNY', description: '午饭' }]
}

test('buildExcelBuffer creates xlsx buffer', async () => {
  const buffer = await buildExcelBuffer(report)
  assert.ok(Buffer.isBuffer(buffer))
  assert.equal(buffer.subarray(0, 2).toString(), 'PK')
})

test('buildPdfBuffer creates pdf buffer', async () => {
  const buffer = await buildPdfBuffer(report)
  assert.ok(Buffer.isBuffer(buffer))
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF')
})

test('buildImageBuffer creates png buffer', () => {
  const buffer = buildImageBuffer(report)
  assert.ok(Buffer.isBuffer(buffer))
  assert.deepEqual([...buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test('makeShareQr creates png qr buffer', async () => {
  const buffer = await makeShareQr('http://localhost/share/token')
  assert.ok(Buffer.isBuffer(buffer))
  assert.deepEqual([...buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/exporter.test.js
```

Expected: FAIL，`buildExcelBuffer` 等函数未导出。

- [ ] **Step 3: 实现 exporter**

Replace `server/src/services/exporter.js` with buffer based exports:

```js
import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import { createCanvas } from 'canvas'
import QRCode from 'qrcode'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function buildExcelBuffer(report) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('报表')
  sheet.addRow(['收入', report.income, '支出', report.expense, '结余', report.balance])
  sheet.addRow([])
  sheet.addRow(['分类', '金额(CNY)', '笔数'])
  for (const item of report.byCategory || []) sheet.addRow([item.category, Number(item.total || 0), Number(item.count || 0)])
  sheet.addRow([])
  sheet.addRow(['日期', '类型', '分类', '金额', '币种', '商家', '成员', '项目', '描述'])
  for (const record of report.records || []) {
    sheet.addRow([record.date, record.type, record.category, Number(record.amount || 0), record.currency, record.merchant, record.member, record.project, record.description])
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export function buildPdfBuffer(report) {
  return new Promise(resolve => {
    const chunks = []
    const doc = new PDFDocument()
    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    try {
      const fontPath = path.join(__dirname, '..', 'assets', 'NotoSansSC-Regular.ttf')
      doc.registerFont('CJK', fontPath)
      doc.font('CJK')
    } catch {
      doc.font('Helvetica')
    }
    doc.fontSize(18).text('Smart Finance Report')
    doc.fontSize(12).text(`Income: ${report.income}  Expense: ${report.expense}  Balance: ${report.balance}`)
    doc.moveDown()
    doc.text('Categories')
    for (const item of report.byCategory || []) doc.text(`${item.category}: ${item.total} (${item.count})`)
    doc.moveDown()
    doc.text('Records')
    for (const record of (report.records || []).slice(0, 100)) {
      doc.text(`${record.date} ${record.type} ${record.category} ${record.amount}${record.currency || ''} ${record.description || ''}`)
    }
    doc.end()
  })
}

export function buildImageBuffer(report) {
  const canvas = createCanvas(750, 1000)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, 750, 1000)
  ctx.fillStyle = '#111827'
  ctx.font = '30px sans-serif'
  ctx.fillText('Smart Finance Report', 30, 60)
  ctx.font = '24px sans-serif'
  ctx.fillText(`Income ${report.income}  Expense ${report.expense}`, 30, 115)
  ctx.fillText(`Balance ${report.balance}`, 30, 155)
  let y = 220
  ctx.font = '20px sans-serif'
  for (const item of report.byCategory || []) {
    ctx.fillText(`${item.category}: ${item.total}`, 30, y)
    y += 36
  }
  return canvas.toBuffer('image/png')
}

export async function makeShareQr(url) {
  return QRCode.toBuffer(url)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/exporter.test.js
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/exporter.js server/test/exporter.test.js
git commit -m "feat: build report export buffers"
```

## Task 3: 导出路由

**Files:**
- Modify/Add: `server/src/routes/export.js`
- Add: `server/test/exportRoute.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/exportRoute.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
import { createServer } from 'http'
import config from '../src/config.js'
import { createExportRouter } from '../src/routes/export.js'

function listen(app) {
  const server = createServer(app)
  return new Promise(resolve => server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })))
}

function token(userId = 7) {
  return jwt.sign({ userId }, config.auth.jwtSecret)
}

function appWithRouter() {
  const app = express()
  app.use(express.json())
  app.use('/api/export', createExportRouter({
    buildReport: async params => {
      assert.equal(params.userId, 7)
      assert.equal(params.periodType, 'month')
      assert.equal(params.periodValue, '2026-07')
      return { income: 100, expense: 50, balance: 50, byCategory: [], records: [] }
    },
    buildExcelBuffer: async () => Buffer.from('excel'),
    buildPdfBuffer: async () => Buffer.from('%PDF-test'),
    buildImageBuffer: () => Buffer.from([0x89, 0x50, 0x4e, 0x47])
  }))
  return app
}

test('GET /api/export/excel requires auth', async () => {
  const { server, url } = await listen(appWithRouter())
  try {
    const response = await fetch(`${url}/api/export/excel`)
    assert.equal(response.status, 401)
  } finally {
    server.close()
  }
})

test('GET /api/export formats return expected content types', async () => {
  const { server, url } = await listen(appWithRouter())
  try {
    for (const [format, contentType] of [
      ['excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['pdf', 'application/pdf'],
      ['image', 'image/png']
    ]) {
      const response = await fetch(`${url}/api/export/${format}?periodType=month&periodValue=2026-07`, {
        headers: { Authorization: `Bearer ${token()}` }
      })
      assert.equal(response.status, 200)
      assert.ok(response.headers.get('content-type').includes(contentType))
      assert.ok((await response.arrayBuffer()).byteLength > 0)
    }
  } finally {
    server.close()
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/exportRoute.test.js
```

Expected: FAIL，`createExportRouter` 未导出或旧路由不支持依赖注入。

- [ ] **Step 3: 实现导出路由**

Replace `server/src/routes/export.js` with:

```js
import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { buildReport as defaultBuildReport } from '../services/reportGenerator.js'
import {
  buildExcelBuffer as defaultBuildExcelBuffer,
  buildImageBuffer as defaultBuildImageBuffer,
  buildPdfBuffer as defaultBuildPdfBuffer
} from '../services/exporter.js'

function getReportParams(req) {
  const { periodType = 'month', periodValue, ledgerId, category, member, merchant, project } = req.query
  return {
    userId: req.userId,
    ledgerId: ledgerId ? Number(ledgerId) : null,
    periodType,
    periodValue: periodValue || new Date().toISOString().slice(0, 7),
    filters: { category, member, merchant, project }
  }
}

function setDownloadHeaders(res, contentType, filename) {
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
}

export function createExportRouter({
  buildReport = defaultBuildReport,
  buildExcelBuffer = defaultBuildExcelBuffer,
  buildPdfBuffer = defaultBuildPdfBuffer,
  buildImageBuffer = defaultBuildImageBuffer
} = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.get('/excel', async (req, res) => {
    const report = await buildReport(getReportParams(req))
    const buffer = await buildExcelBuffer(report)
    setDownloadHeaders(res, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `report-${Date.now()}.xlsx`)
    res.send(buffer)
  })

  router.get('/pdf', async (req, res) => {
    const report = await buildReport(getReportParams(req))
    const buffer = await buildPdfBuffer(report)
    setDownloadHeaders(res, 'application/pdf', `report-${Date.now()}.pdf`)
    res.send(buffer)
  })

  router.get('/image', async (req, res) => {
    const report = await buildReport(getReportParams(req))
    const buffer = buildImageBuffer(report)
    setDownloadHeaders(res, 'image/png', `report-${Date.now()}.png`)
    res.send(buffer)
  })

  return router
}

export default createExportRouter()
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/exportRoute.test.js
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/export.js server/test/exportRoute.test.js
git commit -m "feat: add authenticated report export routes"
```

## Task 4: 报表分享 ownership 校验

**Files:**
- Modify: `server/src/routes/reports.js`
- Add: `server/test/reportShare.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/reportShare.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
import { createServer } from 'http'
import config from '../src/config.js'
import { createReportsRouter } from '../src/routes/reports.js'

function listen(app) {
  const server = createServer(app)
  return new Promise(resolve => server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })))
}

function token(userId = 7) {
  return jwt.sign({ userId }, config.auth.jwtSecret)
}

function createDb({ reportOwner = 7 } = {}) {
  const inserted = []
  function db(tableName) {
    if (tableName === 'reports') {
      return {
        where(conditions) {
          return {
            first: async () => conditions.user_id === reportOwner ? { id: conditions.id, user_id: reportOwner } : null
          }
        }
      }
    }
    if (tableName === 'report_shares') {
      return {
        insert: async row => {
          inserted.push(row)
          return [1]
        }
      }
    }
    throw new Error(`unexpected table ${tableName}`)
  }
  db.inserted = inserted
  return db
}

test('POST /api/reports/share/:id rejects reports owned by another user', async () => {
  const db = createDb({ reportOwner: 8 })
  const app = express()
  app.use(express.json())
  app.use('/api/reports', createReportsRouter({ dbClient: db }))
  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/reports/share/10`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(7)}` }
    })
    assert.equal(response.status, 404)
    assert.equal(db.inserted.length, 0)
  } finally {
    server.close()
  }
})

test('POST /api/reports/share/:id creates share token for own report', async () => {
  const db = createDb({ reportOwner: 7 })
  const app = express()
  app.use(express.json())
  app.use('/api/reports', createReportsRouter({ dbClient: db, createToken: () => 'share-token' }))
  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/reports/share/10`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(7)}` }
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.match(json.data.url, /share-token/)
    assert.equal(db.inserted[0].report_id, 10)
    assert.equal(db.inserted[0].token, 'share-token')
  } finally {
    server.close()
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/reportShare.test.js
```

Expected: FAIL，`createReportsRouter` 未导出或分享未校验 ownership。

- [ ] **Step 3: 改造 reports 路由注入与分享校验**

Modify `server/src/routes/reports.js`:

- Export `createReportsRouter({ dbClient = db, createToken = uuid } = {})`。
- Replace direct `db` references inside the factory with `dbClient`。
- In `POST /share/:id`:

```js
    const report = await dbClient('reports').where({ id: Number(req.params.id), user_id: req.userId }).first()
    if (!report) return res.status(404).json({ success: false, error: '报表不存在' })
    const token = createToken()
    const exp = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 19).replace('T', ' ')
    await dbClient('report_shares').insert({ report_id: Number(req.params.id), token, expire_at: exp })
    res.json({ success: true, data: { url: `${req.protocol}://${req.get('host')}/api/share/${token}` } })
```

Keep `export default createReportsRouter()` at the end.

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/reportShare.test.js
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/reports.js server/test/reportShare.test.js
git commit -m "fix: scope report sharing to owner"
```

## Task 5: 集成验证与 Docker smoke

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

- [ ] **Step 4: Docker 冒烟**

Run from repo root in PowerShell:

```powershell
$env:JWT_SECRET='smart-finance-smoke-jwt-secret-20260718-please-replace-in-production'
@'
const token = (await fetch('http://localhost:3000/api/auth/mock-login', { method: 'POST' }).then(r => r.json())).data.token
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const record = await fetch('http://localhost:3000/api/chat', {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: '\u4eca\u5929\u9910\u996e\u82b1\u4e8625\u5143' })
}).then(r => r.json())
if (!record.success || !record.data.recordIds?.length) throw new Error(`record failed: ${JSON.stringify(record)}`)

for (const [format, expected] of [
  ['excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pdf', 'application/pdf'],
  ['image', 'image/png']
]) {
  const response = await fetch(`http://localhost:3000/api/export/${format}?periodType=month&periodValue=2026-07`, { headers })
  if (!response.ok) throw new Error(`${format} export failed: ${response.status}`)
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes(expected)) throw new Error(`${format} content-type unexpected: ${contentType}`)
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength === 0) throw new Error(`${format} export empty`)
  console.log(`${format}_bytes=${bytes.byteLength}`)
}

const generated = await fetch('http://localhost:3000/api/reports/generate', {
  method: 'POST',
  headers,
  body: JSON.stringify({ periodType: 'month', periodValue: '2026-07' })
}).then(r => r.json())
if (!generated.success) throw new Error(`generate failed: ${JSON.stringify(generated)}`)

const shared = await fetch(`http://localhost:3000/api/reports/share/${generated.data.reportId}`, {
  method: 'POST',
  headers
}).then(r => r.json())
if (!shared.success || !shared.data.url) throw new Error(`share failed: ${JSON.stringify(shared)}`)
console.log(`share_url=${shared.data.url}`)
'@ | node --input-type=module -
```

Expected output includes `excel_bytes=`, `pdf_bytes=`, `image_bytes=`, `share_url=`.

- [ ] **Step 5: 范围检查**

Run:

```bash
git status --short -- docs/superpowers server/src/services/reportGenerator.js server/src/services/exporter.js server/src/routes/export.js server/src/routes/reports.js server/test/reportGenerator.test.js server/test/exporter.test.js server/test/exportRoute.test.js server/test/reportShare.test.js
git diff --cached --stat
git log --oneline -12
```

Expected:

- 阶段 8 文件没有未提交改动。
- 暂存区为空。
- 阶段外既有脏文件可以继续存在，但不能被提交。
