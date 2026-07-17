# Smart Finance V3 第三阶段提醒中心增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把预算提醒从后台 JSON 数据增强为用户可读、可处理的提醒中心和消费分析页风险提醒。

**Architecture:** 后端新增 `reminderPresenter` 把 `reminders` 行格式化为统一 `display` 模型，`/api/reminders` 和 `/api/reminders/highlights` 复用该模型。前端在现有顶部铃铛、Pinia store 和消费分析页上做轻量增强，支持单条已读、全部已读和最近预算风险展示。

**Tech Stack:** Node.js 22、Express、Knex/MySQL、Vue 3、Pinia、Vite、Node 内置 test。

---

## 文件结构

- 新增 `server/src/services/reminderPresenter.js`：提醒展示模型格式化、预算提醒解析、highlight 排序。
- 新增 `server/test/reminderPresenter.test.js`：格式化和排序单元测试。
- 修改 `server/src/routes/reminders.js`：导出 `createRemindersRouter(deps)`，列表接口返回 `display`，新增 `GET /highlights`。
- 新增 `server/test/remindersRoute.test.js`：提醒列表、highlights、单条已读路由测试。
- 修改 `client/src/utils/api.js`：补齐提醒接口参数、highlights 接口。
- 修改 `client/src/stores/app.js`：新增 `reminderHighlights`、`refreshReminderHighlights()`、`markReminderRead()`。
- 修改 `client/src/App.vue`：顶部提醒面板展示 `display`，支持单条已读。
- 修改 `client/src/components/ReportPanel.vue`：新增“本月风险提醒”区块。

注意：当前工作区已有许多前端未提交改动。实施提交时只 stage 本阶段明确涉及的 hunks，避免误带无关改动。

## Task 1: 后端提醒展示模型

**Files:**
- Create: `server/src/services/reminderPresenter.js`
- Test: `server/test/reminderPresenter.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/reminderPresenter.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatReminder,
  sortReminderHighlights
} from '../src/services/reminderPresenter.js'

test('formatReminder turns budget warning JSON into display model', () => {
  const reminder = formatReminder({
    id: 1,
    type: 'budget_alert',
    title: '预算提醒',
    message: JSON.stringify({
      month: '2026-07',
      category: '餐饮',
      level: 'warn',
      percent: 86,
      budget: 1000,
      spent: 860
    }),
    status: 'pending',
    created_at: '2026-07-18T10:00:00.000Z'
  })

  assert.equal(reminder.display.kind, 'budget')
  assert.equal(reminder.display.level, 'warn')
  assert.equal(reminder.display.levelText, '接近预算')
  assert.equal(reminder.display.summary, '餐饮预算已使用 86%')
  assert.equal(reminder.display.detail, '2026-07 餐饮预算 ¥1000，已花 ¥860。')
  assert.equal(reminder.display.accent, 'warning')
})

test('formatReminder turns critical total budget into danger display', () => {
  const reminder = formatReminder({
    id: 2,
    type: 'budget_alert',
    title: '预算提醒',
    message: JSON.stringify({
      month: '2026-07',
      category: 'total',
      level: 'critical',
      percent: 103.5,
      budget: 3000,
      spent: 3105
    }),
    status: 'pending',
    created_at: '2026-07-18T10:00:00.000Z'
  })

  assert.equal(reminder.display.levelText, '已超预算')
  assert.equal(reminder.display.summary, '总预算已使用 103.5%')
  assert.equal(reminder.display.detail, '2026-07 总预算 ¥3000，已花 ¥3105。')
  assert.equal(reminder.display.accent, 'danger')
})

test('formatReminder falls back to generic display for non-json message', () => {
  const reminder = formatReminder({
    id: 3,
    type: 'daily',
    title: '每日提醒',
    message: '记得记账',
    status: 'pending',
    created_at: '2026-07-18T10:00:00.000Z'
  })

  assert.equal(reminder.display.kind, 'generic')
  assert.equal(reminder.display.level, 'info')
  assert.equal(reminder.display.summary, '每日提醒')
  assert.equal(reminder.display.detail, '记得记账')
})

test('sortReminderHighlights prioritizes critical then warn then time', () => {
  const reminders = [
    formatReminder({ id: 1, type: 'daily', title: '普通', message: '普通', created_at: '2026-07-18T12:00:00.000Z' }),
    formatReminder({ id: 2, type: 'budget_alert', title: 'warn', message: JSON.stringify({ level: 'warn', category: '餐饮', month: '2026-07', percent: 81, budget: 100, spent: 81 }), created_at: '2026-07-18T09:00:00.000Z' }),
    formatReminder({ id: 3, type: 'budget_alert', title: 'critical', message: JSON.stringify({ level: 'critical', category: '交通', month: '2026-07', percent: 101, budget: 100, spent: 101 }), created_at: '2026-07-18T08:00:00.000Z' })
  ]

  assert.deepEqual(sortReminderHighlights(reminders).map(item => item.id), [3, 2, 1])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/reminderPresenter.test.js
```

Expected: FAIL，错误包含 `Cannot find module '../src/services/reminderPresenter.js'`。

- [ ] **Step 3: 实现提醒 presenter**

Create `server/src/services/reminderPresenter.js`:

```js
function safeJsonParse(value) {
  if (!value || typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function money(value) {
  const number = Number(value || 0)
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, '')
}

function percentText(value) {
  const number = Number(value || 0)
  return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, '')
}

function budgetCategory(category) {
  return category === 'total' || !category ? '总预算' : String(category)
}

function createGenericDisplay(reminder) {
  return {
    kind: 'generic',
    level: 'info',
    levelText: '提醒',
    summary: reminder.title || '提醒',
    detail: reminder.message || '',
    accent: 'primary'
  }
}

function createBudgetDisplay(reminder) {
  const payload = safeJsonParse(reminder.message)
  if (!payload) return createGenericDisplay(reminder)

  const category = budgetCategory(payload.category)
  const level = payload.level === 'critical' ? 'critical' : 'warn'
  const levelText = level === 'critical' ? '已超预算' : '接近预算'
  const accent = level === 'critical' ? 'danger' : 'warning'
  const percent = Number(payload.percent || 0)
  const budget = Number(payload.budget || 0)
  const spent = Number(payload.spent || 0)
  const month = payload.month || ''

  return {
    kind: 'budget',
    level,
    levelText,
    summary: `${category}已使用 ${percentText(percent)}%`,
    detail: `${month} ${category} ¥${money(budget)}，已花 ¥${money(spent)}。`.trim(),
    category,
    month,
    percent,
    budget,
    spent,
    accent
  }
}

export function formatReminder(reminder) {
  const display = reminder?.type === 'budget_alert'
    ? createBudgetDisplay(reminder)
    : createGenericDisplay(reminder || {})

  return {
    ...reminder,
    display
  }
}

function priority(reminder) {
  if (reminder.display?.kind === 'budget' && reminder.display.level === 'critical') return 0
  if (reminder.display?.kind === 'budget' && reminder.display.level === 'warn') return 1
  return 2
}

export function sortReminderHighlights(reminders) {
  return [...reminders].sort((a, b) => {
    const byPriority = priority(a) - priority(b)
    if (byPriority !== 0) return byPriority
    return new Date(b.created_at || 0) - new Date(a.created_at || 0)
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/reminderPresenter.test.js
```

Expected: PASS，4 个 presenter 测试通过。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/reminderPresenter.js server/test/reminderPresenter.test.js
git commit -m "feat: format reminder display data"
```

## Task 2: Reminders 路由增强

**Files:**
- Modify: `server/src/routes/reminders.js`
- Test: `server/test/remindersRoute.test.js`

- [ ] **Step 1: 写失败路由测试**

Create `server/test/remindersRoute.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createRemindersRouter } from '../src/routes/reminders.js'
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

function createQuery(rows) {
  const state = { table: '', where: {}, limit: null, updates: null }
  const query = {
    where(input) {
      Object.assign(state.where, input)
      return query
    },
    orderBy() { return query },
    limit(value) {
      state.limit = value
      return query
    },
    async update(values) {
      state.updates = values
      return 1
    },
    async first() {
      if (state.count) return { count: rows.filter(row => row.user_id === state.where.user_id && row.status === state.where.status).length }
      return rows[0]
    },
    count() {
      state.count = true
      return query
    },
    then(resolve, reject) {
      const result = rows
        .filter(row => state.where.user_id == null || row.user_id === state.where.user_id)
        .filter(row => state.where.status == null || row.status === state.where.status)
        .slice(0, state.limit || rows.length)
      return Promise.resolve(result).then(resolve, reject)
    },
    state
  }
  return query
}

function createFakeDb(rows, states = []) {
  function db(table) {
    const query = createQuery(rows)
    query.state.table = table
    states.push(query.state)
    return query
  }
  db.fn = { now: () => 'NOW' }
  return db
}

test('GET /api/reminders returns formatted display data', async () => {
  const rows = [{
    id: 1,
    user_id: 7,
    type: 'budget_alert',
    title: '预算提醒',
    message: JSON.stringify({ month: '2026-07', category: '餐饮', level: 'warn', percent: 86, budget: 1000, spent: 860 }),
    status: 'pending',
    created_at: '2026-07-18T10:00:00.000Z'
  }]
  const app = express()
  app.use(express.json())
  app.use('/api/reminders', createRemindersRouter({ dbClient: createFakeDb(rows) }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/reminders`, {
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.data[0].display.kind, 'budget')
    assert.equal(json.data[0].display.summary, '餐饮已使用 86%')
  } finally {
    server.close()
  }
})

test('GET /api/reminders/highlights returns priority limited reminders', async () => {
  const rows = [
    { id: 1, user_id: 7, type: 'daily', title: '普通', message: '普通', status: 'pending', created_at: '2026-07-18T12:00:00.000Z' },
    { id: 2, user_id: 7, type: 'budget_alert', title: 'warn', message: JSON.stringify({ level: 'warn', category: '餐饮', month: '2026-07', percent: 81, budget: 100, spent: 81 }), status: 'pending', created_at: '2026-07-18T09:00:00.000Z' },
    { id: 3, user_id: 7, type: 'budget_alert', title: 'critical', message: JSON.stringify({ level: 'critical', category: '交通', month: '2026-07', percent: 101, budget: 100, spent: 101 }), status: 'pending', created_at: '2026-07-18T08:00:00.000Z' }
  ]
  const app = express()
  app.use(express.json())
  app.use('/api/reminders', createRemindersRouter({ dbClient: createFakeDb(rows) }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/reminders/highlights?limit=2`, {
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()
    assert.deepEqual(json.data.map(item => item.id), [3, 2])
  } finally {
    server.close()
  }
})

test('PUT /api/reminders/:id/read scopes update to current user', async () => {
  const states = []
  const app = express()
  app.use(express.json())
  app.use('/api/reminders', createRemindersRouter({ dbClient: createFakeDb([], states) }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/reminders/9/read`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.deepEqual(states.at(-1).where, { id: '9', user_id: 7 })
  } finally {
    server.close()
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server
npm test -- test/remindersRoute.test.js
```

Expected: FAIL，错误包含 `does not provide an export named 'createRemindersRouter'`。

- [ ] **Step 3: 改造 reminders 路由**

Modify `server/src/routes/reminders.js`:

```js
import { Router } from 'express'
import db from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { formatReminder, sortReminderHighlights } from '../services/reminderPresenter.js'

function limitFromQuery(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

export function createRemindersRouter({ dbClient = db } = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.get('/', async (req, res) => {
    const limit = limitFromQuery(req.query.limit, 20, 50)
    const reminders = await dbClient('reminders')
      .where({ user_id: req.userId, status: 'pending' })
      .orderBy('created_at', 'desc')
      .limit(limit)
    res.json({ success: true, data: reminders.map(formatReminder) })
  })

  router.get('/highlights', async (req, res) => {
    const limit = limitFromQuery(req.query.limit, 3, 5)
    const reminders = await dbClient('reminders')
      .where({ user_id: req.userId, status: 'pending' })
      .orderBy('created_at', 'desc')
      .limit(50)
    const data = sortReminderHighlights(reminders.map(formatReminder)).slice(0, limit)
    res.json({ success: true, data })
  })

  router.get('/count', async (req, res) => {
    const row = await dbClient('reminders').where({ user_id: req.userId, status: 'pending' }).count({ count: '*' }).first()
    res.json({ success: true, data: Number(row?.count || 0) })
  })

  router.put('/read-all', async (req, res) => {
    await dbClient('reminders').where({ user_id: req.userId, status: 'pending' }).update({ status: 'read', read_at: dbClient.fn.now() })
    res.json({ success: true, message: '全部已标记为已读' })
  })

  router.put('/:id/read', async (req, res) => {
    await dbClient('reminders').where({ id: req.params.id, user_id: req.userId }).update({ status: 'read', read_at: dbClient.fn.now() })
    res.json({ success: true, message: '已标记为已读' })
  })

  router.post('/subscribe', async (req, res) => {
    const { templateId = process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID, openid } = req.body
    if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' })
    await dbClient('wechat_subscribe')
      .insert({ user_id: req.userId, openid, template_id: templateId, status: 'authorized', authorized_at: dbClient.fn.now() })
      .onConflict(['user_id', 'template_id'])
      .merge({ openid, status: 'authorized', authorized_at: dbClient.fn.now() })
    res.json({ success: true })
  })

  return router
}

export default createRemindersRouter()
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd server
npm test -- test/reminderPresenter.test.js test/remindersRoute.test.js
```

Expected: PASS，presenter 和 reminders route 测试通过。

- [ ] **Step 5: 运行后端全量测试**

Run:

```bash
cd server
npm test
```

Expected: PASS，所有后端测试通过。

- [ ] **Step 6: 提交**

```bash
git add server/src/routes/reminders.js server/test/remindersRoute.test.js
git commit -m "feat: add reminder display routes"
```

## Task 3: 前端 API 与 Store 增强

**Files:**
- Modify: `client/src/utils/api.js`
- Modify: `client/src/stores/app.js`

- [ ] **Step 1: 修改 API 方法**

Modify reminder methods in `client/src/utils/api.js`:

```js
  getReminders(params = {}) {
    const qs = new URLSearchParams(params).toString()
    return request(`/api/reminders${qs ? `?${qs}` : ''}`)
  },
  getReminderCount() {
    return request('/api/reminders/count')
  },
  getReminderHighlights(limit = 3) {
    return request(`/api/reminders/highlights?limit=${limit}`)
  },
  markReminderRead(id) {
    return request(`/api/reminders/${id}/read`, { method: 'PUT' })
  },
  markAllRead() {
    return request('/api/reminders/read-all', { method: 'PUT' })
  },
```

If the file contains broader uncommitted API work, stage only the reminder-related hunks for this task.

- [ ] **Step 2: 修改 store 状态和 actions**

Modify `client/src/stores/app.js` state:

```js
reminderCount: 0,
reminders: [],
reminderHighlights: [],
showReminderPanel: false,
```

Add actions:

```js
async refreshReminderHighlights(limit = 3) {
  try {
    const res = await api.getReminderHighlights(limit)
    this.reminderHighlights = res.data || []
  } catch {
    this.reminderHighlights = []
  }
},

async markReminderRead(id) {
  await api.markReminderRead(id)
  this.reminders = this.reminders.filter(item => item.id !== id)
  this.reminderHighlights = this.reminderHighlights.filter(item => item.id !== id)
  await this.refreshReminders()
  await this.refreshReminderHighlights()
},
```

Keep existing `refreshReminders()` and `markAllRead()`, but update `markAllRead()`:

```js
async markAllRead() {
  await api.markAllRead()
  this.reminderCount = 0
  this.reminders = []
  this.reminderHighlights = []
},
```

- [ ] **Step 3: 运行前端构建**

Run:

```bash
cd client
npm run build
```

Expected: PASS，允许保留 Vite chunk size warning。

- [ ] **Step 4: 提交**

```bash
git add client/src/utils/api.js client/src/stores/app.js
git commit -m "feat: add reminder frontend data actions"
```

## Task 4: 顶部提醒面板增强

**Files:**
- Modify: `client/src/App.vue`

- [ ] **Step 1: 修改提醒面板模板**

In `client/src/App.vue`, replace the reminder item block:

```vue
<div v-for="r in store.reminders" :key="r.id" class="reminder-item" :class="[r.type, r.display?.accent]">
  <div class="reminder-item-main">
    <div class="reminder-title-row">
      <span class="reminder-title">{{ r.display?.summary || r.title }}</span>
      <span class="reminder-level">{{ r.display?.levelText || '提醒' }}</span>
    </div>
    <div class="reminder-msg">{{ r.display?.detail || r.message }}</div>
    <div class="reminder-time">{{ r.created_at }}</div>
  </div>
  <button class="reminder-read-btn" @click.stop="store.markReminderRead(r.id)">已读</button>
</div>
```

- [ ] **Step 2: 添加样式**

Add scoped styles to `client/src/App.vue`:

```css
.reminder-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  border-left: 3px solid var(--primary);
}
.reminder-item.warning { border-left-color: var(--warning); }
.reminder-item.danger { border-left-color: var(--danger); }
.reminder-item-main { flex: 1; min-width: 0; }
.reminder-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.reminder-level {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 10px;
}
.reminder-read-btn {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
}
.reminder-read-btn:hover { text-decoration: underline; }
```

- [ ] **Step 3: 运行前端构建**

Run:

```bash
cd client
npm run build
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add client/src/App.vue
git commit -m "feat: improve reminder panel display"
```

## Task 5: 消费分析页风险提醒区块

**Files:**
- Modify: `client/src/components/ReportPanel.vue`

- [ ] **Step 1: 添加风险提醒区块模板**

In `client/src/components/ReportPanel.vue`, insert after the top `.report-grid` block and before “消费趋势”:

```vue
<div class="report-card risk-card" style="margin-bottom:20px;">
  <div style="display:flex;justify-content:space-between;align-items:center;">
    <h3>⚠️ 本月风险提醒</h3>
    <button v-if="store.reminderHighlights.length > 0" class="btn btn-sm btn-outline" @click="store.refreshReminderHighlights()">刷新</button>
  </div>
  <div v-if="store.reminderHighlights.length > 0" class="risk-list">
    <div v-for="r in store.reminderHighlights" :key="r.id" class="risk-item" :class="r.display?.accent">
      <div style="flex:1">
        <div class="risk-summary">{{ r.display?.summary || r.title }}</div>
        <div class="risk-detail">{{ r.display?.detail || r.message }}</div>
      </div>
      <button class="btn btn-sm btn-outline" @click="store.markReminderRead(r.id)">已读</button>
    </div>
  </div>
  <div v-else class="empty-state" style="padding:18px;">
    <p>暂无预算风险，继续保持 ✨</p>
  </div>
</div>
```

- [ ] **Step 2: 加载 highlights**

Modify `loadAll()` Promise list:

```js
const [rRes, recRes] = await Promise.all([
  api.getReportTimerange(activePeriod.value),
  api.getRecords({ limit: 50 }),
  store.refreshReminderHighlights()
])
```

Keep `rRes` and `recRes` handling unchanged.

- [ ] **Step 3: 添加样式**

Add to scoped style in `client/src/components/ReportPanel.vue`:

```css
.risk-list{display:flex;flex-direction:column;gap:10px}
.risk-item{display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--border);border-left:4px solid var(--primary);border-radius:10px;background:#fff}
.risk-item.warning{border-left-color:var(--warning);background:#fffbeb}
.risk-item.danger{border-left-color:var(--danger);background:#fef2f2}
.risk-summary{font-weight:600;font-size:14px;color:var(--text)}
.risk-detail{font-size:12px;color:var(--text-secondary);margin-top:4px}
```

- [ ] **Step 4: 运行前端构建**

Run:

```bash
cd client
npm run build
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add client/src/components/ReportPanel.vue
git commit -m "feat: show budget risk reminders in reports"
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

Expected: PASS。

- [ ] **Step 2: 运行前端构建**

Run:

```bash
cd client
npm run build
```

Expected: PASS。

- [ ] **Step 3: Docker 重建前后端**

Run:

```bash
docker compose up -d --build backend frontend
```

Expected: backend healthy，frontend running。

- [ ] **Step 4: Docker smoke 验证提醒接口**

Run this Node script from repo root:

```bash
node - <<'NODE'
import { execFileSync } from 'node:child_process'

function mysql(sql) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'mysql', 'mysql', '-ufinance', '-pFinancePass2026!', 'smart_finance', '-N', '-e', sql], { encoding: 'utf8' }).trim()
}

const login = await fetch('http://localhost:3000/api/auth/mock-login', { method: 'POST' }).then(r => r.json())
const token = login.data.token
const userId = login.data.user?.id || login.data.userId
const message = JSON.stringify({ month: '2026-07', category: '餐饮', level: 'warn', percent: 88, budget: 1000, spent: 880 }).replaceAll("'", "''")

mysql(`INSERT INTO reminders (device_id,user_id,type,title,message,channel,status) VALUES ('user-${userId}',${userId},'budget_alert','预算提醒','${message}','inapp','pending');`)

const list = await fetch('http://localhost:3000/api/reminders', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
const item = list.data.find(row => row.type === 'budget_alert')
if (!item?.display || item.display.kind !== 'budget') throw new Error('missing budget display')

const highlights = await fetch('http://localhost:3000/api/reminders/highlights?limit=3', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
if (!highlights.data.some(row => row.id === item.id)) throw new Error('highlight missing inserted reminder')

const before = await fetch('http://localhost:3000/api/reminders/count', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
await fetch(`http://localhost:3000/api/reminders/${item.id}/read`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } })
const after = await fetch('http://localhost:3000/api/reminders/count', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())

console.log(`display=${item.display.summary}`)
console.log(`count_before=${before.data} count_after=${after.data}`)
NODE
```

Expected:

```text
display=餐饮已使用 88%
count_after is one less than count_before
```

- [ ] **Step 5: 检查未提交范围**

Run:

```bash
git status --short
```

Expected: 本阶段文件没有未提交改动；既有用户脏文件可以继续存在。

## 自检清单

- 规格覆盖：计划覆盖后端格式化、列表 display、highlights、单条已读、顶部面板、报表风险区块、测试和 Docker smoke。
- 占位符扫描：未发现红旗占位表述，所有代码步骤都给出具体片段或命令。
- 类型一致性：`display.kind`、`display.level`、`display.levelText`、`display.summary`、`display.detail`、`display.accent` 在后端、前端和测试中命名一致。
- 范围控制：不新增独立洞察中心、不接入大模型建议、不改预算生成逻辑。
