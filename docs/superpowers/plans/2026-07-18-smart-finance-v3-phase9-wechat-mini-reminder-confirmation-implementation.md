# 智能财务 V3 第 9 阶段：微信小程序登录、订阅消息与提醒确认 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可在微信开发者工具中运行的原生小程序，完成真实 `wx.login`、预算提醒订阅、微信推送以及确认/忽略闭环。

**Architecture:** 后端把微信 HTTP 调用、通知编排和路由分成独立单元；MySQL 保存确认状态与发送结果，Redis 缓存 access_token。小程序只持有系统 JWT，通过现有 REST API 工作；自动测试和 Docker 冒烟使用 mock 发送，人工联调切换 live。

**Tech Stack:** Node.js 22、Express 4、Knex/MySQL 8.4、Redis/ioredis、Node Test Runner、原生微信小程序、Docker Compose、微信开发者工具 CLI。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `server/src/config.js` | 读取微信环境变量和发送模式 |
| `server/src/schema.js` | 创建确认记录和微信发送记录表 |
| `server/src/services/wechat.js` | 微信登录、access_token 缓存和订阅消息 HTTP 客户端 |
| `server/src/services/wechatNotifier.js` | 订阅状态消费、模板映射、mock/live 发送和幂等记录 |
| `server/src/services/reminderConfirmation.js` | 提醒确认查询和幂等状态变更 |
| `server/src/routes/auth.js` | 小程序 code 登录和 JWT 签发 |
| `server/src/routes/reminders.js` | 订阅配置、订阅登记、确认列表/详情/动作 |
| `server/src/services/monitorAgent.js` | 预算预警创建确认任务并触发通知 |
| `miniprogram/` | 原生小程序页面、请求层和本地开发配置样例 |

## Task 1：微信配置与 MySQL 表结构

**Files:**
- Modify: `server/src/config.js`
- Modify: `server/src/schema.js`
- Modify: `server/test/config.test.js`
- Modify: `server/test/schema.test.js`

- [ ] **Step 1：先写配置和 schema 失败测试**

在 `server/test/config.test.js` 增加：

```js
test('loadConfig reads wechat mini program settings', () => {
  const config = loadConfig({
    WECHAT_MINI_APPID: 'wx-test-app',
    WECHAT_MINI_SECRET: 'test-secret',
    WECHAT_SUBSCRIBE_TEMPLATE_ID: 'template-test',
    WECHAT_SEND_MODE: 'live'
  })

  assert.deepEqual(config.wechat, {
    miniAppId: 'wx-test-app',
    miniSecret: 'test-secret',
    subscribeTemplateId: 'template-test',
    sendMode: 'live'
  })
})

test('loadConfig defaults invalid wechat send mode to mock', () => {
  assert.equal(loadConfig({ WECHAT_SEND_MODE: 'invalid' }).wechat.sendMode, 'mock')
})
```

在 `server/test/schema.test.js` 增加：

```js
test('schema defines reminder confirmation and wechat delivery tables', () => {
  const sql = getCreateTableStatements().join('\n')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS reminder_confirmations/)
  assert.match(sql, /UNIQUE KEY uniq_reminder_confirmations_reminder \(reminder_id\)/)
  assert.match(sql, /KEY idx_reminder_confirmations_user_status \(user_id, status\)/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS wechat_deliveries/)
  assert.match(sql, /UNIQUE KEY uniq_wechat_deliveries_reminder \(reminder_id\)/)
  assert.match(sql, /KEY idx_wechat_deliveries_user_created \(user_id, created_at\)/)
})
```

- [ ] **Step 2：运行 RED**

Run:

```powershell
cd server
npm test -- test/config.test.js test/schema.test.js
```

Expected: FAIL，`config.wechat` 和两张表尚不存在。

- [ ] **Step 3：实现微信配置**

在 `loadConfig()` 返回对象中加入：

```js
wechat: {
  miniAppId: env.WECHAT_MINI_APPID || '',
  miniSecret: env.WECHAT_MINI_SECRET || '',
  subscribeTemplateId: env.WECHAT_SUBSCRIBE_TEMPLATE_ID || '',
  sendMode: env.WECHAT_SEND_MODE === 'live' ? 'live' : 'mock'
}
```

- [ ] **Step 4：增加两张表**

在 `server/src/schema.js` 的建表数组中加入：

```sql
CREATE TABLE IF NOT EXISTS reminder_confirmations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reminder_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  payload_json JSON NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  action_at DATETIME NULL,
  UNIQUE KEY uniq_reminder_confirmations_reminder (reminder_id),
  KEY idx_reminder_confirmations_user_status (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
```

```sql
CREATE TABLE IF NOT EXISTS wechat_deliveries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reminder_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  template_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  response_json JSON NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME NULL,
  UNIQUE KEY uniq_wechat_deliveries_reminder (reminder_id),
  KEY idx_wechat_deliveries_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
```

- [ ] **Step 5：运行 GREEN 并提交**

Run:

```powershell
cd server
npm test -- test/config.test.js test/schema.test.js
cd ..
git add server/src/config.js server/src/schema.js server/test/config.test.js server/test/schema.test.js
git commit -m "feat: add wechat reminder schema"
```

Expected: PASS；提交只包含四个文件。

## Task 2：可测试的微信 API 客户端

**Files:**
- Replace/Take over: `server/src/services/wechat.js`
- Add: `server/test/wechat.test.js`

- [ ] **Step 1：写微信客户端失败测试**

创建 `server/test/wechat.test.js`，覆盖以下接口：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWechatClient, WechatApiError } from '../src/services/wechat.js'

function response(json, ok = true) {
  return { ok, json: async () => json }
}

test('code2Session exchanges code without exposing secret in errors', async () => {
  const calls = []
  const client = createWechatClient({
    wechatConfig: { miniAppId: 'wx-app', miniSecret: 'top-secret', subscribeTemplateId: 'tpl', sendMode: 'mock' },
    fetchFn: async url => {
      calls.push(String(url))
      return response({ openid: 'openid-7', unionid: 'union-7' })
    }
  })

  assert.deepEqual(await client.code2Session('login-code'), { openid: 'openid-7', unionid: 'union-7' })
  assert.match(calls[0], /jscode2session/)
  assert.match(calls[0], /js_code=login-code/)
})

test('getAccessToken uses cached token and safe ttl', async () => {
  const cacheCalls = []
  const client = createWechatClient({
    wechatConfig: { miniAppId: 'wx-app', miniSecret: 'secret', subscribeTemplateId: 'tpl', sendMode: 'live' },
    cache: {
      get: async () => null,
      set: async (key, value, ttl) => cacheCalls.push({ key, value, ttl }),
      delete: async () => {}
    },
    fetchFn: async () => response({ access_token: 'token-1', expires_in: 7200 })
  })

  assert.equal(await client.getAccessToken(), 'token-1')
  assert.deepEqual(cacheCalls[0], { key: 'wechat:at:wx-app', value: 'token-1', ttl: 6900 })
})

test('sendSubscribeMessage refreshes an invalid token once', async () => {
  const tokens = []
  let tokenCalls = 0
  const client = createWechatClient({
    wechatConfig: { miniAppId: 'wx-app', miniSecret: 'secret', subscribeTemplateId: 'tpl', sendMode: 'live' },
    cache: { get: async () => null, set: async () => {}, delete: async () => {} },
    fetchFn: async url => {
      if (String(url).includes('/cgi-bin/token')) {
        tokenCalls += 1
        return response({ access_token: `token-${tokenCalls}`, expires_in: 7200 })
      }
      tokens.push(new URL(String(url)).searchParams.get('access_token'))
      return response(tokens.length === 1 ? { errcode: 40001, errmsg: 'invalid credential' } : { errcode: 0, errmsg: 'ok' })
    }
  })

  const result = await client.sendSubscribeMessage({
    openid: 'openid-7',
    templateId: 'tpl',
    page: 'pages/reminders/confirm/index?id=9',
    data: { thing1: { value: '餐饮月度预算' } }
  })

  assert.equal(result.errcode, 0)
  assert.deepEqual(tokens, ['token-1', 'token-2'])
})

test('missing credentials produce a typed safe error', async () => {
  const client = createWechatClient({ wechatConfig: { miniAppId: '', miniSecret: '', subscribeTemplateId: '', sendMode: 'live' } })
  await assert.rejects(client.code2Session('code'), error => {
    assert.ok(error instanceof WechatApiError)
    assert.equal(error.status, 503)
    assert.equal(error.message.includes('secret'), false)
    return true
  })
})
```

- [ ] **Step 2：运行 RED**

Run:

```powershell
cd server
npm test -- test/wechat.test.js
```

Expected: FAIL，旧 `wechat.js` 没有 `createWechatClient` 和 Redis 注入。

- [ ] **Step 3：实现客户端工厂**

用以下公共 API 重写 `server/src/services/wechat.js`：

```js
import config from '../config.js'
import { cacheGet, cacheSet, cacheDelete } from '../redis.js'

const INVALID_TOKEN_CODES = new Set([40001, 40014, 42001])

export class WechatApiError extends Error {
  constructor(message, { code = null, status = 502 } = {}) {
    super(message)
    this.name = 'WechatApiError'
    this.code = code
    this.status = status
  }
}

function requireLoginConfig(wechatConfig) {
  if (!wechatConfig.miniAppId || !wechatConfig.miniSecret) {
    throw new WechatApiError('微信小程序登录配置缺失', { status: 503 })
  }
}

export function createWechatClient({
  wechatConfig = config.wechat,
  cache = { get: cacheGet, set: cacheSet, delete: cacheDelete },
  fetchFn = fetch
} = {}) {
  const tokenKey = `wechat:at:${wechatConfig.miniAppId}`

  async function readJson(url, options) {
    const result = await fetchFn(url, options)
    if (!result.ok) throw new WechatApiError('微信服务暂时不可用')
    return result.json()
  }

  async function code2Session(code) {
    requireLoginConfig(wechatConfig)
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
    url.searchParams.set('appid', wechatConfig.miniAppId)
    url.searchParams.set('secret', wechatConfig.miniSecret)
    url.searchParams.set('js_code', code)
    url.searchParams.set('grant_type', 'authorization_code')
    const json = await readJson(url)
    if (json.errcode) {
      const status = json.errcode === 40029 || json.errcode === 40163 ? 401 : 502
      throw new WechatApiError('微信登录凭证无效', { code: json.errcode, status })
    }
    return { openid: json.openid, unionid: json.unionid || null }
  }

  async function getAccessToken({ forceRefresh = false } = {}) {
    requireLoginConfig(wechatConfig)
    if (!forceRefresh) {
      const cached = await cache.get(tokenKey)
      if (cached) return cached
    }
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token')
    url.searchParams.set('grant_type', 'client_credential')
    url.searchParams.set('appid', wechatConfig.miniAppId)
    url.searchParams.set('secret', wechatConfig.miniSecret)
    const json = await readJson(url)
    if (json.errcode || !json.access_token) throw new WechatApiError('获取微信访问令牌失败', { code: json.errcode })
    await cache.set(tokenKey, json.access_token, Math.max(60, Number(json.expires_in || 7200) - 300))
    return json.access_token
  }

  async function sendOnce(input, token) {
    return readJson(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: input.openid, template_id: input.templateId, page: input.page, data: input.data })
    })
  }

  async function sendSubscribeMessage(input) {
    let token = await getAccessToken()
    let json = await sendOnce(input, token)
    if (INVALID_TOKEN_CODES.has(Number(json.errcode))) {
      await cache.delete(tokenKey)
      token = await getAccessToken({ forceRefresh: true })
      json = await sendOnce(input, token)
    }
    if (json.errcode) throw new WechatApiError('微信订阅消息发送失败', { code: json.errcode })
    return json
  }

  return { code2Session, getAccessToken, sendSubscribeMessage }
}

export default createWechatClient()
```

- [ ] **Step 4：运行 GREEN 并提交**

```powershell
cd server
npm test -- test/wechat.test.js
cd ..
git add server/src/services/wechat.js server/test/wechat.test.js
git commit -m "feat: add testable wechat mini client"
```

Expected: PASS；错误输出不包含 AppSecret、session_key 或 access_token。

## Task 3：真实小程序登录路由

**Files:**
- Modify: `server/src/routes/auth.js`
- Add: `server/test/wechatAuthRoute.test.js`

- [ ] **Step 1：写登录路由失败测试**

创建 `server/test/wechatAuthRoute.test.js`，使用 Express 临时端口、真实 JWT 签名和可注入 fake DB。核心断言：

```js
test('POST /api/auth/wechat-mini creates user without exposing wechat errors', async () => {
  const db = createAuthDb()
  const app = express()
  app.use(express.json())
  app.use('/api/auth', createAuthRouter({
    dbClient: db,
    wechatClient: { code2Session: async code => {
      assert.equal(code, 'login-code')
      return { openid: 'mini-openid-7', unionid: 'union-7' }
    } },
    signTokenFn: userId => `jwt-${userId}`
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/auth/wechat-mini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'login-code' })
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.data.token, 'jwt-1')
    assert.equal(db.users[0].mini_openid, 'mini-openid-7')
    assert.equal(db.ledgers.length, 1)
  } finally {
    server.close()
  }
})

test('POST /api/auth/wechat-mini maps invalid code to safe status', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', createAuthRouter({
    dbClient: createAuthDb(),
    wechatClient: { code2Session: async () => { throw new WechatApiError('微信登录凭证无效', { status: 401 }) } }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/auth/wechat-mini`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'bad' })
    })
    const json = await response.json()
    assert.equal(response.status, 401)
    assert.deepEqual(json, { success: false, error: '微信登录凭证无效' })
  } finally {
    server.close()
  }
})
```

测试辅助 `createAuthDb()` 必须只实现 `users`、`ledgers` 的 `where/first/insert/update`，并把插入结果保存在 `db.users/db.ledgers`，不连接真实 MySQL。

- [ ] **Step 2：运行 RED**

```powershell
cd server
npm test -- test/wechatAuthRoute.test.js
```

Expected: FAIL，`createAuthRouter` 尚未导出。

- [ ] **Step 3：工厂化 auth 路由**

在 `server/src/routes/auth.js` 中：

```js
export function createAuthRouter({
  dbClient = db,
  wechatClient = defaultWechatClient,
  signTokenFn = signToken
} = {}) {
  const router = Router()

  async function createDefaultLedger(userId) {
    const existing = await dbClient('ledgers').where({ user_id: userId }).first()
    if (!existing) await dbClient('ledgers').insert({ user_id: userId, name: '我的账本', base_currency: 'CNY' })
  }

  // 把原有 register/login/mock-login/bind-phone/me 路由移入工厂并使用 dbClient。

  router.post('/wechat-mini', async (req, res) => {
    const code = String(req.body?.code || '').trim()
    if (!code) return res.status(400).json({ success: false, error: '缺少 code' })
    try {
      const { openid, unionid } = await wechatClient.code2Session(code)
      let user = await dbClient('users').where({ mini_openid: openid }).first()
      if (!user) {
        const [userId] = await dbClient('users').insert({ mini_openid: openid, unionid })
        user = await dbClient('users').where({ id: userId }).first()
        await createDefaultLedger(userId)
      }
      await dbClient('users').where({ id: user.id }).update({ last_login_at: dbClient.fn.now() })
      return res.json({ success: true, data: { token: signTokenFn(user.id), userId: user.id } })
    } catch (error) {
      return res.status(error instanceof WechatApiError ? error.status : 502).json({
        success: false,
        error: error instanceof WechatApiError ? error.message : '微信登录失败'
      })
    }
  })

  return router
}

export default createAuthRouter()
```

移除公众号 OAuth 路由和 `mpAuthorizeUrl/mpCode2Session` 引用，因为本阶段已明确不做公众号；不要修改用户名密码登录的行为。

- [ ] **Step 4：运行定向与鉴权回归测试并提交**

```powershell
cd server
npm test -- test/wechatAuthRoute.test.js test/authMiddleware.test.js
cd ..
git add server/src/routes/auth.js server/test/wechatAuthRoute.test.js
git commit -m "feat: add injectable wechat mini login"
```

Expected: PASS；`mock-login` 继续可用于自动化冒烟。

## Task 4：订阅登记和提醒确认 API

**Files:**
- Add: `server/src/services/reminderConfirmation.js`
- Modify: `server/src/routes/reminders.js`
- Add: `server/test/reminderConfirmation.test.js`
- Add: `server/test/reminderConfirmationRoute.test.js`

- [ ] **Step 1：写确认服务失败测试**

创建 `server/test/reminderConfirmation.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createReminderConfirmationService } from '../src/services/reminderConfirmation.js'

test('act scopes reminder to user and is idempotent', async () => {
  const repository = createMemoryConfirmationRepository({
    reminder: { id: 9, user_id: 7, status: 'pending' },
    confirmation: { reminder_id: 9, user_id: 7, status: 'pending', payload_json: '{}' }
  })
  const service = createReminderConfirmationService({ repository, now: () => '2026-07-18 22:30:00' })

  const first = await service.act({ reminderId: 9, userId: 7, action: 'confirmed' })
  const second = await service.act({ reminderId: 9, userId: 7, action: 'ignored' })

  assert.equal(first.status, 'confirmed')
  assert.equal(second.status, 'confirmed')
  assert.equal(repository.actionWrites, 1)
})

test('act rejects invalid action and missing ownership', async () => {
  const service = createReminderConfirmationService({ repository: createMemoryConfirmationRepository() })
  await assert.rejects(service.act({ reminderId: 9, userId: 7, action: 'done' }), /无效确认动作/)
  await assert.rejects(service.act({ reminderId: 9, userId: 8, action: 'confirmed' }), /提醒不存在/)
})
```

`createMemoryConfirmationRepository` 在测试中实现 `listPending/getOwned/applyAction`，并记录 `actionWrites`。

- [ ] **Step 2：写路由失败测试**

创建 `server/test/reminderConfirmationRoute.test.js`，至少覆盖：

```js
test('POST /subscribe derives openid from authenticated user', async () => {
  const calls = []
  const app = express()
  app.use(express.json())
  app.use('/api/reminders', createRemindersRouter({
    dbClient: createSubscriptionDb({ user: { id: 7, mini_openid: 'owned-openid' }, calls }),
    confirmationService: fakeConfirmationService(),
    wechatConfig: { subscribeTemplateId: 'template-test' }
  }))
  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/reminders/subscribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: 'accept', openid: 'forged-openid' })
    })
    assert.equal(response.status, 200)
    assert.equal(calls[0].openid, 'owned-openid')
    assert.equal(calls[0].template_id, 'template-test')
  } finally {
    server.close()
  }
})

test('confirmation routes validate id action and ownership', async () => {
  const service = fakeConfirmationService()
  const app = express()
  app.use(express.json())
  app.use('/api/reminders', createRemindersRouter({ dbClient: createSubscriptionDb(), confirmationService: service }))
  const { server, url } = await listen(app)
  try {
    const invalid = await fetch(`${url}/api/reminders/confirmations/not-a-number`, {
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    assert.equal(invalid.status, 400)

    const action = await fetch(`${url}/api/reminders/confirmations/9/action`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'confirmed' })
    })
    assert.equal(action.status, 200)
    assert.deepEqual(service.actions[0], { reminderId: 9, userId: 7, action: 'confirmed' })
  } finally {
    server.close()
  }
})
```

- [ ] **Step 3：运行 RED**

```powershell
cd server
npm test -- test/reminderConfirmation.test.js test/reminderConfirmationRoute.test.js
```

Expected: FAIL，服务和三个确认路由尚不存在。

- [ ] **Step 4：实现确认服务**

`server/src/services/reminderConfirmation.js` 公共 API：

```js
import db from '../db.js'

export class ReminderConfirmationError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export function createConfirmationRepository(dbClient = db) {
  return {
    listPending: userId => dbClient('reminder_confirmations as c')
      .join('reminders as r', 'r.id', 'c.reminder_id')
      .select('c.*', 'r.title', 'r.message', 'r.created_at')
      .where({ 'c.user_id': userId, 'c.status': 'pending' })
      .orderBy('c.created_at', 'desc'),
    getOwned: (reminderId, userId) => dbClient('reminder_confirmations as c')
      .join('reminders as r', 'r.id', 'c.reminder_id')
      .select('c.*', 'r.title', 'r.message', 'r.created_at')
      .where({ 'c.reminder_id': reminderId, 'c.user_id': userId })
      .first(),
    applyAction: async ({ reminderId, userId, action, actionAt }) => dbClient.transaction(async trx => {
      const current = await trx('reminder_confirmations')
        .where({ reminder_id: reminderId, user_id: userId })
        .forUpdate()
        .first()
      if (!current || current.status !== 'pending') return current
      await trx('reminder_confirmations').where({ id: current.id }).update({ status: action, action_at: actionAt })
      await trx('reminders').where({ id: reminderId, user_id: userId }).update({ status: 'read', read_at: actionAt })
      return { ...current, status: action, action_at: actionAt }
    })
  }
}

export function createReminderConfirmationService({ repository = createConfirmationRepository(), now = () => new Date() } = {}) {
  const normalize = row => row ? { ...row, payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json } : null
  return {
    async listPending(userId) { return (await repository.listPending(userId)).map(normalize) },
    async get({ reminderId, userId }) {
      const row = await repository.getOwned(reminderId, userId)
      if (!row) throw new ReminderConfirmationError('提醒不存在', 404)
      return normalize(row)
    },
    async act({ reminderId, userId, action }) {
      if (!['confirmed', 'ignored'].includes(action)) throw new ReminderConfirmationError('无效确认动作')
      const current = await repository.getOwned(reminderId, userId)
      if (!current) throw new ReminderConfirmationError('提醒不存在', 404)
      if (current.status !== 'pending') return normalize(current)
      const date = now()
      const actionAt = typeof date === 'string' ? date : date.toISOString().slice(0, 19).replace('T', ' ')
      return normalize(await repository.applyAction({ reminderId, userId, action, actionAt }))
    }
  }
}

export default createReminderConfirmationService()
```

- [ ] **Step 5：扩展提醒路由**

在 `createRemindersRouter` 注入参数中增加：

```js
confirmationService = defaultConfirmationService,
wechatConfig = config.wechat
```

增加以下路由，并使用统一 `parsePositiveId()`：

```js
router.get('/subscription-config', (_req, res) => {
  res.json({ success: true, data: { templateId: wechatConfig.subscribeTemplateId } })
})

router.post('/subscribe', async (req, res) => {
  if (req.body?.result !== 'accept') return res.status(400).json({ success: false, error: '订阅未授权' })
  if (!wechatConfig.subscribeTemplateId) return res.status(503).json({ success: false, error: '订阅模板未配置' })
  const user = await dbClient('users').where({ id: req.userId }).first()
  if (!user?.mini_openid) return res.status(409).json({ success: false, error: '当前账号未绑定微信小程序' })
  await dbClient('wechat_subscribe')
    .insert({ user_id: req.userId, openid: user.mini_openid, template_id: wechatConfig.subscribeTemplateId, status: 'authorized', authorized_at: dbClient.fn.now() })
    .onConflict(['user_id', 'template_id'])
    .merge({ openid: user.mini_openid, status: 'authorized', authorized_at: dbClient.fn.now() })
  res.json({ success: true })
})

router.get('/confirmations', async (req, res) => {
  res.json({ success: true, data: await confirmationService.listPending(req.userId) })
})

router.get('/confirmations/:reminderId', async (req, res) => {
  const reminderId = parsePositiveId(req.params.reminderId)
  if (!reminderId) return res.status(400).json({ success: false, error: '无效提醒 ID' })
  try {
    res.json({ success: true, data: await confirmationService.get({ reminderId, userId: req.userId }) })
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.status ? error.message : '提醒查询失败' })
  }
})

router.post('/confirmations/:reminderId/action', async (req, res) => {
  const reminderId = parsePositiveId(req.params.reminderId)
  if (!reminderId) return res.status(400).json({ success: false, error: '无效提醒 ID' })
  try {
    res.json({ success: true, data: await confirmationService.act({ reminderId, userId: req.userId, action: req.body?.action }) })
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.status ? error.message : '提醒处理失败' })
  }
})
```

- [ ] **Step 6：运行 GREEN 与原提醒回归并提交**

```powershell
cd server
npm test -- test/reminderConfirmation.test.js test/reminderConfirmationRoute.test.js test/remindersRoute.test.js
cd ..
git add server/src/services/reminderConfirmation.js server/src/routes/reminders.js server/test/reminderConfirmation.test.js server/test/reminderConfirmationRoute.test.js
git commit -m "feat: add reminder confirmation api"
```

Expected: PASS；旧的列表、红点、已读接口保持不变。

## Task 5：通知编排与预算监控联动

**Files:**
- Add: `server/src/services/wechatNotifier.js`
- Modify: `server/src/services/monitorAgent.js`
- Add: `server/test/wechatNotifier.test.js`
- Modify: `server/test/monitorAgent.test.js`

- [ ] **Step 1：写 notifier 失败测试**

创建 `server/test/wechatNotifier.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBudgetTemplateData, createWechatNotifier } from '../src/services/wechatNotifier.js'

test('buildBudgetTemplateData maps confirmed template fields', () => {
  assert.deepEqual(buildBudgetTemplateData({
    category: '餐饮', level: 'critical', budget: 1000, spent: 1125, createdAt: new Date('2026-07-18T01:57:00Z')
  }), {
    thing1: { value: '餐饮月度预算' },
    amount2: { value: '125.00' },
    time3: { value: '2026-07-18 09:57' },
    thing4: { value: '点击查看并确认处理' }
  })
})

test('mock notifier consumes authorization and records one delivery', async () => {
  const repository = createNotifierMemoryRepository({ subscription: { status: 'authorized', openid: 'openid-7' } })
  const notifier = createWechatNotifier({
    repository,
    wechatClient: { sendSubscribeMessage: async () => { throw new Error('must not call live') } },
    wechatConfig: { subscribeTemplateId: 'template-test', sendMode: 'mock' },
    now: () => '2026-07-18 22:30:00'
  })

  const result = await notifier.notifyBudgetReminder({
    reminder: { id: 9, user_id: 7, created_at: '2026-07-18 09:57:00' },
    payload: { category: '餐饮', level: 'critical', budget: 1000, spent: 1125 }
  })

  assert.equal(result.status, 'mock_sent')
  assert.equal(repository.subscription.status, 'consumed')
  assert.equal(repository.deliveries.length, 1)
})

test('live failure records failed and keeps authorization', async () => {
  const repository = createNotifierMemoryRepository({ subscription: { status: 'authorized', openid: 'openid-7' } })
  const notifier = createWechatNotifier({
    repository,
    wechatClient: { sendSubscribeMessage: async () => { throw new Error('wechat down') } },
    wechatConfig: { subscribeTemplateId: 'template-test', sendMode: 'live' }
  })
  const result = await notifier.notifyBudgetReminder({ reminder: { id: 9, user_id: 7 }, payload: { category: '餐饮', budget: 100, spent: 120 } })
  assert.equal(result.status, 'failed')
  assert.equal(repository.subscription.status, 'authorized')
})
```

测试内存仓库实现 `findDelivery/findAuthorized/createDelivery/updateDelivery/consumeSubscription`，并以 `reminder_id` 阻止重复记录。

- [ ] **Step 2：扩展 monitor RED**

修改 `server/test/monitorAgent.test.js` 的 fake repository，加入：

```js
async createConfirmation(confirmation) {
  confirmations.push(confirmation)
  return confirmation
}
```

调用时注入 notifier：

```js
const notifications = []
const result = await checkBudgetAfterRecord({
  record,
  repository,
  notifier: { notifyBudgetReminder: async input => notifications.push(input) }
})
assert.equal(confirmations[0].reminder_id, 11)
assert.equal(confirmations[0].status, 'pending')
assert.equal(notifications[0].reminder.id, 11)
```

- [ ] **Step 3：运行 RED**

```powershell
cd server
npm test -- test/wechatNotifier.test.js test/monitorAgent.test.js
```

Expected: FAIL，notifier 和确认创建尚未实现。

- [ ] **Step 4：实现 notifier**

`server/src/services/wechatNotifier.js` 导出：

```js
export function buildBudgetTemplateData({ category, budget, spent, createdAt = new Date() }) {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt)
  const local = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date).replaceAll('/', '-').replace(' ', ' ')
  return {
    thing1: { value: `${category === 'total' ? '总额' : category}月度预算`.slice(0, 20) },
    amount2: { value: Math.max(0, Number(spent) - Number(budget)).toFixed(2) },
    time3: { value: local },
    thing4: { value: '点击查看并确认处理' }
  }
}
```

`createWechatNotifier()` 必须按此顺序工作：

1. `findDelivery(reminder.id)`，存在则直接返回。
2. `findAuthorized(user_id, templateId)`，不存在则写 `skipped`。
3. mock 模式写 `mock_sent` 并消费授权。
4. live 模式调用 `wechatClient.sendSubscribeMessage`，页面为 `pages/reminders/confirm/index?id=<id>`。
5. 成功写 `sent` 并消费授权。
6. 失败写脱敏 `{ code, message }`，状态 `failed`，保留授权并返回结果，不向预算记账流程抛错。

默认仓库使用 `wechat_deliveries`、`wechat_subscribe` 和 `users`，并将 `response_json` 用 `JSON.stringify()` 保存；不得保存 openid、access_token 或 session_key。

- [ ] **Step 5：联动 monitorAgent**

在 `createMonitorRepository()` 增加：

```js
async createConfirmation({ reminder, payload }) {
  await dbClient('reminder_confirmations').insert({
    reminder_id: reminder.id,
    user_id: reminder.user_id,
    status: 'pending',
    payload_json: JSON.stringify(payload)
  }).onConflict('reminder_id').ignore()
}
```

把 `checkBudgetAfterRecord` 签名改为：

```js
export async function checkBudgetAfterRecord({
  record,
  repository = createMonitorRepository(),
  notifier = defaultWechatNotifier
})
```

在 `createReminder` 后执行：

```js
const payload = {
  month,
  category,
  level,
  percent: Number(percent.toFixed(1)),
  budget: Number(budget.amount),
  spent
}
await repository.createConfirmation({ reminder, payload })
await notifier.notifyBudgetReminder({ reminder, payload })
alerts.push(reminder)
```

- [ ] **Step 6：运行 GREEN 并提交**

```powershell
cd server
npm test -- test/wechatNotifier.test.js test/monitorAgent.test.js test/agentFlow.test.js test/ocrConfirm.test.js
cd ..
git add server/src/services/wechatNotifier.js server/src/services/monitorAgent.js server/test/wechatNotifier.test.js server/test/monitorAgent.test.js
git commit -m "feat: notify and confirm budget alerts"
```

Expected: PASS；微信失败不会使记账接口失败。

## Task 6：最小原生微信小程序

**Files:**
- Add: `miniprogram/app.js`
- Add: `miniprogram/app.json`
- Add: `miniprogram/app.wxss`
- Add: `miniprogram/sitemap.json`
- Add: `miniprogram/project.config.example.json`
- Add: `miniprogram/utils/request.js`
- Add: `miniprogram/utils/api.js`
- Add: `miniprogram/pages/login/index.{js,json,wxml,wxss}`
- Add: `miniprogram/pages/index/index.{js,json,wxml,wxss}`
- Add: `miniprogram/pages/reminders/index.{js,json,wxml,wxss}`
- Add: `miniprogram/pages/reminders/confirm/index.{js,json,wxml,wxss}`
- Add: `miniprogram/test/request.test.cjs`

- [ ] **Step 1：先写请求层失败测试**

创建 `miniprogram/test/request.test.cjs`：

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequest } = require('../utils/request.js')

test('request attaches jwt and resolves api data', async () => {
  const calls = []
  const wxApi = {
    getStorageSync: key => key === 'token' ? 'jwt-7' : '',
    removeStorageSync: () => {},
    reLaunch: () => {},
    request: options => {
      calls.push(options)
      options.success({ statusCode: 200, data: { success: true, data: { id: 7 } } })
    }
  }
  const request = createRequest({ wxApi, apiBase: 'http://127.0.0.1:3000' })
  assert.deepEqual(await request({ path: '/api/auth/me' }), { success: true, data: { id: 7 } })
  assert.equal(calls[0].header.Authorization, 'Bearer jwt-7')
})

test('request clears jwt and returns login on 401', async () => {
  const events = []
  const wxApi = {
    getStorageSync: () => 'expired',
    removeStorageSync: key => events.push(`remove:${key}`),
    reLaunch: input => events.push(`launch:${input.url}`),
    request: options => options.success({ statusCode: 401, data: { success: false, error: '登录已过期' } })
  }
  const request = createRequest({ wxApi, apiBase: 'http://127.0.0.1:3000' })
  await assert.rejects(request({ path: '/api/auth/me' }), /登录已过期/)
  assert.deepEqual(events, ['remove:token', 'launch:/pages/login/index'])
})
```

- [ ] **Step 2：运行 RED**

```powershell
node --test miniprogram/test/request.test.cjs
```

Expected: FAIL，`utils/request.js` 尚不存在。

- [ ] **Step 3：实现小程序请求与 API 封装**

`miniprogram/utils/request.js`：

```js
function createRequest({ wxApi = wx, apiBase = 'http://127.0.0.1:3000' } = {}) {
  return function request({ path, method = 'GET', data }) {
    return new Promise((resolve, reject) => {
      const token = wxApi.getStorageSync('token')
      wxApi.request({
        url: `${apiBase}${path}`,
        method,
        data,
        header: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        success(response) {
          if (response.statusCode === 401) {
            wxApi.removeStorageSync('token')
            wxApi.reLaunch({ url: '/pages/login/index' })
          }
          if (response.statusCode >= 200 && response.statusCode < 300 && response.data?.success) resolve(response.data)
          else reject(new Error(response.data?.error || `请求失败 (${response.statusCode})`))
        },
        fail: error => reject(new Error(error.errMsg || '网络请求失败'))
      })
    })
  }
}

const request = createRequest()
module.exports = { createRequest, request }
```

`miniprogram/utils/api.js`：

```js
const { request } = require('./request.js')
module.exports = {
  login: code => request({ path: '/api/auth/wechat-mini', method: 'POST', data: { code } }),
  me: () => request({ path: '/api/auth/me' }),
  subscriptionConfig: () => request({ path: '/api/reminders/subscription-config' }),
  subscribe: () => request({ path: '/api/reminders/subscribe', method: 'POST', data: { result: 'accept' } }),
  confirmations: () => request({ path: '/api/reminders/confirmations' }),
  confirmation: id => request({ path: `/api/reminders/confirmations/${id}` }),
  act: (id, action) => request({ path: `/api/reminders/confirmations/${id}/action`, method: 'POST', data: { action } })
}
```

- [ ] **Step 4：实现应用配置和登录页**

`app.json` 注册四个页面，窗口标题为“智能财务”；`app.js` 在 `onLaunch` 中没有 token 时跳转登录页；`project.config.example.json` 使用：

```json
{
  "description": "Smart Finance mini program",
  "compileType": "miniprogram",
  "miniprogramRoot": "./",
  "appid": "touristappid",
  "setting": { "urlCheck": false, "es6": true, "postcss": true, "minified": true }
}
```

登录页 `pages/login/index.js`：

```js
const api = require('../../utils/api.js')
Page({
  data: { loading: false, error: '' },
  login() {
    this.setData({ loading: true, error: '' })
    wx.login({
      success: async ({ code }) => {
        try {
          const result = await api.login(code)
          wx.setStorageSync('token', result.data.token)
          wx.reLaunch({ url: '/pages/index/index' })
        } catch (error) {
          this.setData({ error: error.message, loading: false })
        }
      },
      fail: error => this.setData({ error: error.errMsg || '微信登录失败', loading: false })
    })
  }
})
```

WXML 只包含标题、说明、错误文字和绑定 `login` 的绿色按钮；WXSS 使用白色卡片和微信绿色 `#07c160`。

- [ ] **Step 5：实现首页与订阅动作**

首页加载 `/api/auth/me` 和 `/api/reminders/subscription-config`，订阅按钮执行：

```js
async subscribe() {
  try {
    const templateId = this.data.templateId
    if (!templateId) throw new Error('订阅模板未配置')
    const result = await new Promise((resolve, reject) => {
      wx.requestSubscribeMessage({ tmplIds: [templateId], success: resolve, fail: reject })
    })
    if (result[templateId] !== 'accept') throw new Error('你没有允许接收预算提醒')
    await api.subscribe()
    wx.showToast({ title: '订阅成功', icon: 'success' })
  } catch (error) {
    wx.showModal({ title: '订阅失败', content: error.message || error.errMsg, showCancel: false })
  }
}
```

首页还提供“查看待确认提醒”按钮，跳转 `/pages/reminders/index/index`。

- [ ] **Step 6：实现提醒列表与确认页**

提醒列表 `onShow` 调用 `api.confirmations()`，点击项目跳转：

```js
wx.navigateTo({ url: `/pages/reminders/confirm/index?id=${event.currentTarget.dataset.id}` })
```

确认页：

```js
const api = require('../../../utils/api.js')
Page({
  data: { reminder: null, loading: true, submitting: false, error: '' },
  onLoad(query) {
    const id = Number(query.id)
    if (!Number.isSafeInteger(id) || id <= 0) return this.setData({ loading: false, error: '无效提醒 ID' })
    this.reminderId = id
    this.load()
  },
  async load() {
    try {
      const result = await api.confirmation(this.reminderId)
      this.setData({ reminder: result.data, loading: false })
    } catch (error) {
      this.setData({ error: error.message, loading: false })
    }
  },
  confirm() { this.submit('confirmed') },
  ignore() { this.submit('ignored') },
  async submit(action) {
    if (this.data.submitting || this.data.reminder?.status !== 'pending') return
    this.setData({ submitting: true })
    try {
      const result = await api.act(this.reminderId, action)
      this.setData({ reminder: result.data, submitting: false })
      wx.showToast({ title: action === 'confirmed' ? '已确认' : '已忽略', icon: 'success' })
    } catch (error) {
      this.setData({ error: error.message, submitting: false })
    }
  }
})
```

WXML 显示 `payload.category/budget/spent/percent` 和状态；仅 `pending` 时显示“确认处理”“忽略提醒”按钮。

- [ ] **Step 7：运行小程序请求测试并提交**

```powershell
node --test miniprogram/test/request.test.cjs
git add miniprogram
git commit -m "feat: add wechat mini reminder client"
```

Expected: 2 tests PASS；提交中不得出现真实 AppID、AppSecret 或模板 ID。

## Task 7：本地配置、Docker 与完整联调

**Files:**
- Add: `.env.example`
- Modify: `.gitignore`
- Modify: `docker-compose.yml`
- Add locally, do not commit: `.env`
- Add locally, do not commit: `miniprogram/project.config.json`

- [ ] **Step 1：写 Docker 配置失败检查**

先运行：

```powershell
Select-String -Path docker-compose.yml -Pattern 'WECHAT_MINI_APPID|WECHAT_MINI_SECRET|WECHAT_SUBSCRIBE_TEMPLATE_ID|WECHAT_SEND_MODE'
```

Expected: 没有四个完整变量映射。

- [ ] **Step 2：提交安全配置样例**

`.env.example`：

```dotenv
JWT_SECRET=
WECHAT_MINI_APPID=
WECHAT_MINI_SECRET=
WECHAT_SUBSCRIBE_TEMPLATE_ID=
WECHAT_SEND_MODE=mock
```

`.gitignore` 增加：

```gitignore
miniprogram/project.config.json
miniprogram/project.private.config.json
```

`docker-compose.yml` backend 环境增加：

```yaml
WECHAT_MINI_APPID: ${WECHAT_MINI_APPID:-}
WECHAT_MINI_SECRET: ${WECHAT_MINI_SECRET:-}
WECHAT_SUBSCRIBE_TEMPLATE_ID: ${WECHAT_SUBSCRIBE_TEMPLATE_ID:-}
WECHAT_SEND_MODE: ${WECHAT_SEND_MODE:-mock}
```

- [ ] **Step 3：创建本机私有配置**

在 PowerShell 中执行：

```powershell
Copy-Item .env.example .env
Copy-Item miniprogram/project.config.example.json miniprogram/project.config.json
```

使用本地编辑器把已提供的真实 AppID、AppSecret、模板 ID 写入 `.env`；把真实 AppID 写入 `miniprogram/project.config.json`。执行：

```powershell
git status --short -- .env miniprogram/project.config.json
git check-ignore -v .env miniprogram/project.config.json
```

Expected: 两个文件均被 ignore，不出现在可提交列表。

- [ ] **Step 4：提交 Docker 配置**

```powershell
git add .env.example .gitignore docker-compose.yml
git commit -m "chore: configure wechat mini environment"
```

- [ ] **Step 5：后端、小程序和 Web 全量验证**

```powershell
cd server
npm test
cd ..
node --test miniprogram/test/request.test.cjs
cd client
npm run build
cd ..
```

Expected: 后端全部 PASS，小程序测试 PASS，Vue 构建成功；允许既有 Vite chunk size warning。

- [ ] **Step 6：Docker mock 闭环**

确保 `.env` 中 `WECHAT_SEND_MODE=mock`，然后：

```powershell
docker compose up -d --build backend frontend
```

使用 Node 冒烟脚本完成：

1. `/api/auth/mock-login` 获取 JWT。
2. `/api/reminders/subscribe` 登记 mock 用户订阅。
3. `/api/goals/budgets` 创建一个唯一测试分类的 100 元预算。
4. `/api/records` 写入同分类 85 元支出，触发 80% 预警。
5. `/api/reminders/confirmations` 获取对应提醒。
6. `/api/reminders/confirmations/:id/action` 提交 `confirmed`。
7. 直接查询 MySQL，确认 `wechat_deliveries.status='mock_sent'`、订阅为 `consumed`、确认状态为 `confirmed`。

Expected: 所有响应 `success=true`，backend healthy。

- [ ] **Step 7：微信开发者工具真实登录**

先确认已登录开发者工具：

```powershell
& 'D:\weixinkf\微信web开发者工具\cli.bat' islogin
& 'D:\weixinkf\微信web开发者工具\cli.bat' open --project 'E:\Smart Finance\miniprogram' --lang zh
```

在开发者工具详情中确认“不校验合法域名”开启。点击小程序登录按钮，验证：

- 后端日志不出现 AppSecret、session_key 或 access_token。
- `/api/auth/wechat-mini` 返回 JWT。
- 首页能显示当前用户。

- [ ] **Step 8：真实订阅与消息跳转人工验收**

1. 把 `.env` 的 `WECHAT_SEND_MODE` 改为 `live`。
2. 执行 `docker compose up -d --force-recreate backend`。
3. 在小程序点击“订阅预算提醒”并选择允许。
4. 从开发者工具 Storage 复制本次 JWT，仅保存在当前 PowerShell 变量中。
5. 用该 JWT 调用预算和记录 API，触发一次新的预算预警。
6. 确认微信服务通知到达，四个字段正确。
7. 点击消息进入对应确认页，执行确认或忽略。
8. 验证 `wechat_deliveries.status='sent'`、订阅为 `consumed`。
9. 验收后把 `.env` 恢复为 `WECHAT_SEND_MODE=mock`。

- [ ] **Step 9：范围与凭据检查**

```powershell
git status --short -- docs/superpowers server/src server/test miniprogram .env.example .gitignore docker-compose.yml
git diff --cached --stat
git log --oneline -12
```

再执行敏感值扫描，但只输出布尔结果，不打印命中内容：

```powershell
$tracked = git ls-files
$content = $tracked | ForEach-Object { if (Test-Path $_) { Get-Content -Raw -ErrorAction SilentlyContinue $_ } }
if (($content -join "`n") -match '实际 AppSecret 值') { throw 'AppSecret leaked into tracked files' }
```

Expected: 阶段文件均已提交，暂存区为空，`.env` 和真实 `project.config.json` 被忽略，真实凭据未进入 Git。

- [ ] **Step 10：最终代码审查**

对设计提交之后的全部阶段 9 提交进行审查，重点检查：

- openid 不可由客户端伪造。
- AppSecret/access_token/session_key 不落库、不进日志。
- 订阅一次只消费一次。
- 同一提醒的微信发送幂等。
- 微信失败不影响站内提醒。
- 确认接口按用户隔离并幂等。
- mock 测试不调用真实微信。

修复全部 Critical/Important 后，重新运行 Step 5 至 Step 9。
