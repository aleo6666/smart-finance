# Smart Finance 微信小程序 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开发与网页端功能一致的微信小程序，4 Tab（记账/分析/目标/我的），手机号授权+密码登录，echarts 图表，OCR 拍照识小票

**Architecture:** 原生微信小程序框架，分包加载 echarts-for-weixin，`wx.request` 封装 API 层同 Web 端 api.js 签名一致，后端新增 `POST /api/auth/wechat-phone` 解密手机号

**Tech Stack:** 原生 WXML/WXSS/JS，echarts-for-weixin v1.0.5，wechat-miniprogram SDK

---

## 文件结构概览

```
miniprogram/
├── app.js              # 新建 - 启动入口，token 检查，路由分发
├── app.json            # 新建 - 窗口/分包/tabBar 配置
├── app.wxss            # 新建 - 全局样式（Web 端 CSS 变量移植）
├── project.config.json # 新建 - 小程序项目配置
├── sitemap.json        # 新建
├── utils/
│   ├── api.js          # 新建 - API 封装（签名同 Web 端 api.js）
│   └── auth.js         # 新建 - token 存取
├── components/
│   ├── message-bubble/ # 新建 - 消息气泡组件
│   ├── ocr-confirm/    # 新建 - OCR 确认卡片组件
│   ├── progress-bar/   # 新建 - 进度条组件
│   └── empty-state/    # 新建 - 空状态组件
├── pages/
│   ├── login/          # 新建 - 登录页
│   ├── chat/           # 新建 - 记账页（Tab 1）
│   ├── report/         # 新建 - 分析页（Tab 2）
│   ├── goal/           # 新建 - 目标页（Tab 3）
│   └── mine/           # 新建 - 我的页（Tab 4）
└── subpackages/
    └── chart/           # 新建 - echarts 分包
        ├── ec-canvas/   # echarts-for-weixin 组件
        └── pages/
            └── blank/   # 分包占位页
```

**修改现有文件：**

| 文件 | 改动 |
|---|---|
| `server/src/routes/auth.js` | 新增 `POST /api/auth/wechat-phone` 路由 |
| `server/src/services/wechat.js` | 新增 `getPhoneNumber(code, encryptedData, iv) → phone` 函数 |
| `server/src/config.js` | 确认 wechat config 已有（上次审计已补 `WECHAT_MINI_*`） |

---

### Task 1: 项目脚手架 + app 配置

**Files:**
- Create: `miniprogram/app.js`
- Create: `miniprogram/app.json`
- Create: `miniprogram/app.wxss`
- Create: `miniprogram/project.config.json`
- Create: `miniprogram/sitemap.json`
- Create: `miniprogram/utils/auth.js`
- Create: `miniprogram/utils/api.js`
- Create: `miniprogram/images/` (tabBar icons 暂时用纯色占位图)

- [ ] **Step 1: 创建 project.config.json**

```json
{
  "miniprogramRoot": "miniprogram/",
  "projectname": "smart-finance",
  "description": "智能财务记账助手",
  "appid": "touristappid",
  "setting": {
    "urlCheck": true,
    "es6": true,
    "enhance": true,
    "postcss": true,
    "minified": true,
    "coverView": true,
    "lazyloadingPlaceholder": true
  },
  "compileType": "miniprogram",
  "libVersion": "3.6.0",
  "condition": {}
}
```

- [ ] **Step 2: 创建 sitemap.json**

```json
{
  "rules": [{
    "action": "allow",
    "page": "*"
  }]
}
```

- [ ] **Step 3: 创建 utils/auth.js**

```js
const TOKEN_KEY = 'auth_token'

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || ''
}

function setToken(token) {
  wx.setStorageSync(TOKEN_KEY, token)
}

function clearToken() {
  wx.removeStorageSync(TOKEN_KEY)
}

function isLoggedIn() {
  return !!getToken()
}

module.exports = { getToken, setToken, clearToken, isLoggedIn }
```

- [ ] **Step 4: 创建 utils/api.js**

```js
const { getToken, clearToken } = require('./auth.js')

function getDeviceId() {
  let id = wx.getStorageSync('device_id')
  if (!id) {
    id = 'wx-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    wx.setStorageSync('device_id', id)
  }
  return id
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const token = getToken()
    const headers = {
      'X-Device-Id': getDeviceId(),
      'Content-Type': 'application/json',
      ...options.header
    }
    if (token) {
      headers['Authorization'] = 'Bearer ' + token
    }

    wx.request({
      url: path,
      method: options.method || 'GET',
      data: options.body,
      header: headers,
      success(res) {
        if (res.statusCode === 401) {
          clearToken()
        }
        resolve(res.data)
      },
      fail(err) {
        reject(err)
      }
    })
  })
}

function uploadFile(path, filePath, formData = {}) {
  return new Promise((resolve, reject) => {
    const token = getToken()
    wx.uploadFile({
      url: path,
      filePath: filePath,
      name: 'image',
      formData,
      header: {
        'Authorization': 'Bearer ' + token,
        'X-Device-Id': getDeviceId()
      },
      success(res) {
        if (res.statusCode === 401) clearToken()
        resolve(JSON.parse(res.data))
      },
      fail(err) {
        reject(err)
      }
    })
  })
}

const BASE = 'https://lisheng666.xyz'

const api = {
  setToken(token) { getToken.setToken || wx.setStorageSync('auth_token', token) },

  // 登录
  register(username, password) {
    return request(BASE + '/api/auth/register', { method: 'POST', body: { username, password } })
  },
  login(username, password) {
    return request(BASE + '/api/auth/login', { method: 'POST', body: { username, password } })
  },
  wechatMiniLogin(code) {
    return request(BASE + '/api/auth/wechat-mini', { method: 'POST', body: { code } })
  },
  wechatPhoneLogin(code, encryptedData, iv) {
    return request(BASE + '/api/auth/wechat-phone', { method: 'POST', body: { code, encryptedData, iv } })
  },
  getMe() {
    return request(BASE + '/api/auth/me')
  },

  // 聊天
  chat(message) {
    return request(BASE + '/api/chat', { method: 'POST', body: { message } })
  },

  // 记录
  getRecords(params = {}) {
    const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&')
    return request(BASE + '/api/records?' + qs)
  },
  updateRecord(id, data) {
    return request(BASE + '/api/records/' + id, { method: 'PUT', body: data })
  },

  // OCR
  ocrReceipt(filePath) {
    return uploadFile(BASE + '/api/records/ocr', filePath)
  },
  confirmOcr(ocrSessionId, records) {
    return request(BASE + '/api/records/ocr/confirm', { method: 'POST', body: { ocrSessionId, records } })
  },
  cancelOcr(ocrSessionId) {
    return request(BASE + '/api/records/ocr/cancel', { method: 'POST', body: { ocrSessionId } })
  },

  // 报表
  getReportTimerange(period = 'month') {
    return request(BASE + '/api/reports/timerange?period=' + period)
  },
  getTodayReport() {
    return request(BASE + '/api/reports/today')
  },
  getMonthlyReport(month) {
    const qs = month ? '?month=' + month : ''
    return request(BASE + '/api/reports/monthly' + qs)
  },

  // 目标
  getGoals() {
    return request(BASE + '/api/goals')
  },
  createGoal(data) {
    return request(BASE + '/api/goals', { method: 'POST', body: data })
  },
  updateGoal(id, data) {
    return request(BASE + '/api/goals/' + id, { method: 'PUT', body: data })
  },
  deleteGoal(id) {
    return request(BASE + '/api/goals/' + id, { method: 'DELETE' })
  },
  getBudgets() {
    return request(BASE + '/api/goals/budgets')
  },
  setBudget(data) {
    return request(BASE + '/api/goals/budgets', { method: 'POST', body: data })
  },

  // 提醒
  getReminders(params = {}) {
    const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&')
    return request(BASE + '/api/reminders?' + qs)
  },
  getReminderCount() {
    return request(BASE + '/api/reminders/count')
  },
  getReminderHighlights(limit = 3) {
    return request(BASE + '/api/reminders/highlights?limit=' + limit)
  },
  markReminderRead(id) {
    return request(BASE + '/api/reminders/' + id + '/read', { method: 'PUT' })
  },
  markAllRead() {
    return request(BASE + '/api/reminders/read-all', { method: 'PUT' })
  },

  // 汇率
  getExchangeRates() {
    return request(BASE + '/api/exchange/latest')
  },
  getExchangeDetail(currency) {
    return request(BASE + '/api/exchange/detail/' + currency)
  },

  // 反馈
  submitFeedback(formData) {
    return request(BASE + '/api/feedback', { method: 'POST', body: formData })
  },
  checkSurvey() {
    return request(BASE + '/api/feedback/survey')
  },
  submitSurvey(rating, comment) {
    return request(BASE + '/api/feedback/survey', { method: 'POST', body: { rating, comment } })
  }
}

module.exports = { api }
```

- [ ] **Step 5: 创建 app.wxss**

```css
/* 全局样式——复用 Web 端 CSS 变量 */
page {
  --primary: #4f46e5;
  --primary-dark: #3730a3;
  --primary-light: #818cf8;
  --success: #10b981;
  --warning: #f59e0b;
  --danger: #ef4444;
  --bg: #f8fafc;
  --bg-card: #ffffff;
  --text: #1e293b;
  --text-secondary: #64748b;
  --border: #e2e8f0;
  --radius: 12px;

  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  height: 100%;
}

/* 卡片 */
.card {
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 20rpx;
  box-shadow: 0 2rpx 12rpx rgba(0,0,0,0.06);
  border: 1rpx solid var(--border);
  margin-bottom: 20rpx;
}

/* 进度条 */
.progress-bar {
  height: 16rpx;
  background: #f1f5f9;
  border-radius: 8rpx;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 8rpx;
  transition: width 0.3s ease;
}

.progress-fill-good { background: var(--success); }
.progress-fill-warn { background: var(--warning); }
.progress-fill-danger { background: var(--danger); }

/* 按钮 */
.btn {
  padding: 16rpx 32rpx;
  border-radius: 16rpx;
  font-size: 28rpx;
  font-weight: 500;
  border: none;
}

.btn-primary {
  background: var(--primary);
  color: #fff;
}

.btn-outline {
  background: transparent;
  border: 1rpx solid var(--border);
  color: var(--text-secondary);
}

.btn-sm {
  padding: 10rpx 20rpx;
  font-size: 24rpx;
}

.btn-full {
  width: 100%;
}

/* 弹窗 */
.modal-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 40rpx;
  width: 85%;
  max-width: 640rpx;
}

.modal-title {
  font-size: 36rpx;
  font-weight: 600;
  margin-bottom: 30rpx;
}

.form-group {
  margin-bottom: 24rpx;
}

.form-label {
  display: block;
  font-size: 26rpx;
  color: var(--text-secondary);
  margin-bottom: 10rpx;
}

.form-input {
  width: 100%;
  padding: 18rpx 24rpx;
  border: 1rpx solid var(--border);
  border-radius: 16rpx;
  font-size: 28rpx;
  box-sizing: border-box;
}

/* 空状态 */
.empty-state {
  text-align: center;
  padding: 80rpx 40rpx;
  color: var(--text-secondary);
}

.empty-icon {
  font-size: 80rpx;
  margin-bottom: 20rpx;
}

/* 错误条 */
.error-banner {
  background: #fef2f2;
  border: 1rpx solid #fecaca;
  border-radius: 16rpx;
  padding: 20rpx 30rpx;
  color: #991b1b;
  font-size: 28rpx;
  margin-bottom: 20rpx;
}

/* Flex 工具 */
.flex-row {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.flex-between {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.flex-1 {
  flex: 1;
}

/* 文本 */
.text-sm { font-size: 24rpx; }
.text-secondary { color: var(--text-secondary); }
.font-bold { font-weight: 600; }
```

- [ ] **Step 6: 创建 app.json**

```json
{
  "pages": [
    "pages/chat/chat",
    "pages/report/report",
    "pages/goal/goal",
    "pages/mine/mine",
    "pages/login/login"
  ],
  "subpackages": [
    {
      "root": "subpackages/chart",
      "name": "chart",
      "pages": ["pages/blank/blank"]
    }
  ],
  "preloadRule": {
    "pages/report/report": {
      "network": "all",
      "packages": ["chart"]
    }
  },
  "window": {
    "navigationBarTitleText": "智能记账",
    "navigationBarBackgroundColor": "#4f46e5",
    "navigationBarTextStyle": "white"
  },
  "tabBar": {
    "color": "#64748b",
    "selectedColor": "#4f46e5",
    "backgroundColor": "#ffffff",
    "borderStyle": "black",
    "list": [
      {
        "pagePath": "pages/chat/chat",
        "text": "记账",
        "iconPath": "images/tab-chat.png",
        "selectedIconPath": "images/tab-chat-active.png"
      },
      {
        "pagePath": "pages/report/report",
        "text": "分析",
        "iconPath": "images/tab-report.png",
        "selectedIconPath": "images/tab-report-active.png"
      },
      {
        "pagePath": "pages/goal/goal",
        "text": "目标",
        "iconPath": "images/tab-goal.png",
        "selectedIconPath": "images/tab-goal-active.png"
      },
      {
        "pagePath": "pages/mine/mine",
        "text": "我的",
        "iconPath": "images/tab-mine.png",
        "selectedIconPath": "images/tab-mine-active.png"
      }
    ]
  },
  "style": "v2",
  "sitemapLocation": "sitemap.json"
}
```

- [ ] **Step 7: 创建 app.js**

```js
const { getToken } = require('./utils/auth.js')
const { api } = require('./utils/api.js')

App({
  globalData: {
    token: '',
    user: null,
    ledgers: []
  },

  onLaunch() {
    const token = getToken()
    if (token) {
      this.globalData.token = token
      api.setToken(token)
      this.loadUser()
    }
  },

  async loadUser() {
    try {
      const res = await api.getMe()
      if (res.success) {
        this.globalData.user = res.data.user
        this.globalData.ledgers = res.data.ledgers
      }
    } catch {
      this.globalData.token = ''
    }
  }
})
```

- [ ] **Step 8: 创建分包占位页 subpackages/chart/pages/blank/blank.wxml + blank.js + blank.json**

`blank.wxml`:
```xml
<view></view>
```

`blank.js`:
```js
Page({})
```

`blank.json`:
```json
{}
```

- [ ] **Step 9: Commit**

```bash
git add miniprogram/
git commit -m "feat(miniprogram): scaffold project with app config, tabBar, utils"
```

---

### Task 2: 后端 - 微信手机号解密接口

**Files:**
- Modify: `server/src/services/wechat.js` - 新增 `getPhoneNumber(code, encryptedData, iv)`
- Modify: `server/src/routes/auth.js` - 新增 `POST /wechat-phone`

- [ ] **Step 1: 在 wechat.js 中新增 getPhoneNumber 函数**

在 `server/src/services/wechat.js` 末尾追加：

```js
import crypto from 'crypto'

export async function getPhoneNumber(code, encryptedData, iv, miniConfig) {
  // Step 1: 用 code 换 session_key
  const sessionUrl = new URL('https://api.weixin.qq.com/sns/jscode2session')
  sessionUrl.searchParams.set('appid', miniConfig.miniAppId)
  sessionUrl.searchParams.set('secret', miniConfig.miniSecret)
  sessionUrl.searchParams.set('js_code', code)
  sessionUrl.searchParams.set('grant_type', 'authorization_code')

  const sessionRes = await fetch(sessionUrl.toString())
  const session = await sessionRes.json()

  if (session.errcode) {
    throw new Error(`微信 code2session 失败: ${session.errmsg} (errcode=${session.errcode})`)
  }

  const sessionKey = session.session_key

  // Step 2: 用 session_key 解密 encryptedData
  const sessionKeyBuffer = Buffer.from(sessionKey, 'base64')
  const encryptedBuffer = Buffer.from(encryptedData, 'base64')
  const ivBuffer = Buffer.from(iv, 'base64')

  const decipher = crypto.createDecipheriv('aes-128-cbc', sessionKeyBuffer, ivBuffer)
  decipher.setAutoPadding(true)

  let decoded = decipher.update(encryptedBuffer, 'binary', 'utf8')
  decoded += decipher.final('utf8')

  const data = JSON.parse(decoded)

  if (!data.phoneNumber) {
    throw new Error('解密结果中无手机号')
  }

  return {
    phoneNumber: data.phoneNumber,
    countryCode: data.countryCode || '86',
    openid: session.openid,
    unionid: session.unionid || null
  }
}
```

- [ ] **Step 2: 在 auth.js 路由中新增 /wechat-phone 端点**

在 `server/src/routes/auth.js` 中，`/wechat-mini` 路由之后，`/mock-login` 之前插入：

```js
router.post('/wechat-phone', async (req, res) => {
  const { code, encryptedData, iv } = req.body
  if (!code || !encryptedData || !iv) {
    return res.status(400).json({ success: false, error: '缺少必填参数' })
  }

  try {
    const { getPhoneNumber } = await import('../services/wechat.js')
    const { phoneNumber, openid, unionid } = await getPhoneNumber(code, encryptedData, iv, {
      miniAppId: config.wechat?.miniAppId || process.env.WECHAT_MINI_APPID || '',
      miniSecret: config.wechat?.miniSecret || process.env.WECHAT_MINI_SECRET || ''
    })

    // 按手机号查找用户
    const maskedPhone = phoneNumber.slice(0, 3) + '****' + phoneNumber.slice(-4)
    let user = await db('users').where({ phone: phoneNumber }).first()

    if (!user) {
      // 新用户：创建
      const [userId] = await db('users').insert({
        mini_openid: openid,
        unionid: unionid || null,
        phone: phoneNumber,
        nickname: maskedPhone,
        username: maskedPhone
      })
      user = await db('users').where({ id: userId }).first()
      await createDefaultLedger(userId)
      await migrateGuestRecords(userId, req.deviceId)
    } else {
      // 已有用户：更新 openid
      await db('users').where({ id: user.id }).update({
        mini_openid: openid,
        unionid: unionid || user.unionid
      })
    }

    await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() })
    await migrateGuestRecords(user.id, req.deviceId)

    logger.info('手机号登录成功', { userId: user.id, phone: maskedPhone })
    res.json({ success: true, data: { token: signToken(user.id), userId: user.id } })
  } catch (e) {
    logger.warn('手机号登录失败', { error: e.message })
    res.status(500).json({ success: false, error: '登录失败，请稍后重试' })
  }
})
```

- [ ] **Step 3: 确保 config.js 中 wechat 配置已存在**

验证 `server/src/config.js` 中已有（上次审计已补）：
```js
wechat: {
  miniAppId: env.WECHAT_MINI_APPID || '',
  miniSecret: env.WECHAT_MINI_SECRET || '',
  mpAppId: env.WECHAT_MP_APPID || '',
  mpSecret: env.WECHAT_MP_SECRET || ''
}
```

确认 `config` 是在文件顶部 import 的。在 `auth.js` 顶部确认有 `import config from '../config.js'`。

- [ ] **Step 4: Commit**

```bash
git add server/src/services/wechat.js server/src/routes/auth.js
git commit -m "feat(auth): add wechat phone number decryption login endpoint"
```

---

### Task 3: 登录页

**Files:**
- Create: `miniprogram/pages/login/login.wxml`
- Create: `miniprogram/pages/login/login.wxss`
- Create: `miniprogram/pages/login/login.js`
- Create: `miniprogram/pages/login/login.json`

- [ ] **Step 1: 创建 login.json**

```json
{
  "navigationBarTitleText": "登录",
  "usingComponents": {}
}
```

- [ ] **Step 2: 创建 login.wxml**

```xml
<view class="login-page">
  <view class="login-card">
    <view class="logo">💰</view>
    <view class="title">智能财务记账</view>
    <view class="subtitle">登录后开始记账之旅</view>

    <!-- 手机号授权按钮 -->
    <button class="btn btn-primary btn-lg btn-full wechat-btn"
      open-type="getPhoneNumber"
      bindgetphonenumber="onGetPhoneNumber">
      📱 手机号一键登录
    </button>

    <view class="divider">
      <view class="divider-line"></view>
      <text class="divider-text">或使用密码登录</text>
      <view class="divider-line"></view>
    </view>

    <!-- Tab 切换 -->
    <view class="tab-bar">
      <view class="tab-item {{mode === 'login' ? 'active' : ''}}" bindtap="switchMode" data-mode="login">登录</view>
      <view class="tab-item {{mode === 'register' ? 'active' : ''}}" bindtap="switchMode" data-mode="register">注册</view>
    </view>

    <view class="form">
      <view class="form-group">
        <view class="form-label">用户名</view>
        <input class="form-input" value="{{username}}" placeholder="请输入用户名" bindinput="onUsernameInput" />
      </view>
      <view class="form-group">
        <view class="form-label">密码</view>
        <input class="form-input" value="{{password}}" type="password" placeholder="请输入密码（至少6位）" bindinput="onPasswordInput" />
      </view>
      <view class="form-group" wx:if="{{mode === 'register'}}">
        <view class="form-label">确认密码</view>
        <input class="form-input" value="{{confirmPassword}}" type="password" placeholder="再次输入密码" bindinput="onConfirmInput" />
      </view>

      <view class="error-msg" wx:if="{{error}}">{{error}}</view>

      <button class="btn btn-primary btn-lg btn-full" bindtap="doSubmit" loading="{{loading}}" disabled="{{loading}}">
        {{mode === 'login' ? '🔐 登录' : '📝 注册'}}
      </button>
    </view>
  </view>
</view>
```

- [ ] **Step 3: 创建 login.wxss**

```css
.login-page {
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40rpx;
}

.login-card {
  background: #fff;
  border-radius: 32rpx;
  padding: 60rpx 50rpx;
  width: 100%;
  max-width: 640rpx;
  text-align: center;
  box-shadow: 0 20rpx 60rpx rgba(0,0,0,0.15);
}

.logo { font-size: 80rpx; margin-bottom: 16rpx; }
.title { font-size: 48rpx; font-weight: 700; color: #333; margin-bottom: 10rpx; }
.subtitle { font-size: 26rpx; color: #888; margin-bottom: 40rpx; }

.wechat-btn {
  background: linear-gradient(135deg, #07c160, #06ad56) !important;
  color: #fff !important;
  border: none !important;
  border-radius: 20rpx !important;
  font-size: 32rpx !important;
  padding: 24rpx !important;
}

.divider {
  display: flex;
  align-items: center;
  margin: 36rpx 0;
}

.divider-line {
  flex: 1;
  height: 1rpx;
  background: #eee;
}

.divider-text {
  padding: 0 24rpx;
  font-size: 24rpx;
  color: #aaa;
}

.tab-bar {
  display: flex;
  margin-bottom: 40rpx;
  border-radius: 16rpx;
  overflow: hidden;
  border: 1rpx solid #e2e8f0;
}

.tab-item {
  flex: 1;
  padding: 20rpx;
  font-size: 30rpx;
  color: #64748b;
  background: #f8fafc;
}

.tab-item.active {
  background: #fff;
  color: #4f46e5;
  font-weight: 600;
}

.form {
  text-align: left;
}

.form-group {
  margin-bottom: 28rpx;
}

.form-label {
  display: block;
  font-size: 26rpx;
  color: #64748b;
  margin-bottom: 8rpx;
}

.form-input {
  width: 100%;
  padding: 22rpx 24rpx;
  border: 1rpx solid #e2e8f0;
  border-radius: 16rpx;
  font-size: 30rpx;
  box-sizing: border-box;
}

.error-msg {
  color: #ef4444;
  font-size: 26rpx;
  text-align: center;
  margin-bottom: 24rpx;
}

.btn { border-radius: 20rpx !important; }
.btn-lg { padding: 24rpx !important; font-size: 32rpx !important; }
.btn-full { width: 100%; }
.btn-primary { background: linear-gradient(135deg, #667eea, #764ba2) !important; color: #fff !important; border: none !important; }
```

- [ ] **Step 4: 创建 login.js**

```js
const { api } = require('../../utils/api.js')
const { setToken, getToken } = require('../../utils/auth.js')

Page({
  data: {
    mode: 'login',
    username: '',
    password: '',
    confirmPassword: '',
    loading: false,
    error: ''
  },

  onLoad() {
    if (getToken()) {
      wx.switchTab({ url: '/pages/chat/chat' })
    }
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({ mode, error: '' })
  },

  onUsernameInput(e) { this.setData({ username: e.detail.value }) },
  onPasswordInput(e) { this.setData({ password: e.detail.value }) },
  onConfirmInput(e) { this.setData({ confirmPassword: e.detail.value }) },

  async onGetPhoneNumber(e) {
    if (e.detail.errMsg !== 'getPhoneNumber:ok') {
      this.setData({ error: '授权已取消' })
      return
    }

    this.setData({ loading: true, error: '' })
    try {
      // 先拿 login code
      const loginRes = await new Promise((resolve, reject) => {
        wx.login({
          success: resolve,
          fail: reject
        })
      })

      const res = await api.wechatPhoneLogin(
        loginRes.code,
        e.detail.encryptedData,
        e.detail.iv
      )

      if (res.success) {
        setToken(res.data.token)
        wx.switchTab({ url: '/pages/chat/chat' })
      } else {
        this.setData({ error: res.error || '登录失败' })
      }
    } catch (err) {
      this.setData({ error: '登录失败，请稍后重试' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async doSubmit() {
    const { mode, username, password, confirmPassword } = this.data

    if (!username.trim() || !password) {
      this.setData({ error: '请填写用户名和密码' })
      return
    }
    if (password.length < 6) {
      this.setData({ error: '密码至少6位' })
      return
    }
    if (mode === 'register' && password !== confirmPassword) {
      this.setData({ error: '两次密码不一致' })
      return
    }

    this.setData({ loading: true, error: '' })
    try {
      const res = mode === 'login'
        ? await api.login(username.trim(), password)
        : await api.register(username.trim(), password)

      if (res.success) {
        setToken(res.data.token)
        wx.switchTab({ url: '/pages/chat/chat' })
      } else {
        this.setData({ error: res.error || '操作失败' })
      }
    } catch (err) {
      this.setData({ error: '网络错误，请稍后重试' })
    } finally {
      this.setData({ loading: false })
    }
  }
})
```

- [ ] **Step 5: Commit**

```bash
git add miniprogram/pages/login/
git commit -m "feat(miniprogram): add login page with phone auth + password login"
```

---

### Task 4: 组件 - message-bubble + empty-state + progress-bar

**Files:**
- Create: `miniprogram/components/message-bubble/message-bubble.wxml`
- Create: `miniprogram/components/message-bubble/message-bubble.wxss`
- Create: `miniprogram/components/message-bubble/message-bubble.js`
- Create: `miniprogram/components/message-bubble/message-bubble.json`
- Create: `miniprogram/components/empty-state/empty-state.wxml`
- Create: `miniprogram/components/empty-state/empty-state.wxss`
- Create: `miniprogram/components/empty-state/empty-state.js`
- Create: `miniprogram/components/empty-state/empty-state.json`
- Create: `miniprogram/components/progress-bar/progress-bar.wxml`
- Create: `miniprogram/components/progress-bar/progress-bar.wxss`
- Create: `miniprogram/components/progress-bar/progress-bar.js`
- Create: `miniprogram/components/progress-bar/progress-bar.json`

- [ ] **Step 1: 创建 message-bubble 组件**

`message-bubble.json`:
```json
{
  "component": true,
  "usingComponents": {}
}
```

`message-bubble.wxml`:
```xml
<view class="msg-wrapper {{msg.role === 'user' ? 'msg-right' : 'msg-left'}}">
  <view class="avatar">{{msg.role === 'user' ? '😊' : '🤖'}}</view>
  <view class="msg-content">
    <view class="bubble {{msg.role === 'user' ? 'bubble-user' : 'bubble-assistant'}}">
      <text>{{msg.content}}</text>
    </view>
    <view class="time">{{msg.time || ''}}</view>
  </view>
</view>
```

`message-bubble.wxss`:
```css
.msg-wrapper { display: flex; gap: 16rpx; margin-bottom: 24rpx; animation: fadeIn 0.3s; }
.msg-right { flex-direction: row-reverse; align-self: flex-end; }
.msg-left { align-self: flex-start; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.avatar { width: 72rpx; height: 72rpx; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 32rpx; flex-shrink: 0; }
.msg-right .avatar { background: var(--primary-light); }
.msg-left .avatar { background: #eef2ff; }
.bubble { padding: 20rpx 28rpx; border-radius: 28rpx; font-size: 28rpx; line-height: 1.6; word-break: break-all; }
.bubble-user { background: var(--primary); color: #fff; border-bottom-right-radius: 8rpx; }
.bubble-assistant { background: var(--bg-card); border: 1rpx solid var(--border); border-bottom-left-radius: 8rpx; }
.time { font-size: 22rpx; color: var(--text-secondary); margin-top: 8rpx; }
.msg-right .time { text-align: right; }
```

`message-bubble.js`:
```js
Component({
  properties: {
    msg: { type: Object, value: {} }
  }
})
```

- [ ] **Step 2: 创建 empty-state 组件**

`empty-state.json`:
```json
{ "component": true, "usingComponents": {} }
```

`empty-state.wxml`:
```xml
<view class="empty-state">
  <view class="empty-icon">{{icon || '📭'}}</view>
  <view class="empty-text">{{text || '暂无数据'}}</view>
  <view class="empty-sub" wx:if="{{subText}}">{{subText}}</view>
  <slot></slot>
</view>
```

`empty-state.wxss`:
```css
.empty-state { text-align: center; padding: 80rpx 40rpx; color: var(--text-secondary); }
.empty-icon { font-size: 80rpx; margin-bottom: 20rpx; }
.empty-text { font-size: 28rpx; }
.empty-sub { font-size: 24rpx; margin-top: 10rpx; }
```

`empty-state.js`:
```js
Component({
  properties: {
    icon: { type: String, value: '📭' },
    text: { type: String, value: '暂无数据' },
    subText: { type: String, value: '' }
  }
})
```

- [ ] **Step 3: 创建 progress-bar 组件**

`progress-bar.json`:
```json
{ "component": true, "usingComponents": {} }
```

`progress-bar.wxml`:
```xml
<view class="progress-bar">
  <view class="progress-fill progress-fill-{{status}}" style="width: {{percent > 100 ? 100 : percent}}%"></view>
</view>
```

`progress-bar.wxss`:
```css
.progress-bar { height: 16rpx; background: #f1f5f9; border-radius: 8rpx; overflow: hidden; }
.progress-fill { height: 100%; border-radius: 8rpx; transition: width 0.3s ease; }
.progress-fill-good { background: var(--success); }
.progress-fill-warn { background: var(--warning); }
.progress-fill-danger { background: var(--danger); }
```

`progress-bar.js`:
```js
Component({
  properties: {
    percent: { type: Number, value: 0 },
    status: { type: String, value: 'good' }  // good | warn | danger
  }
})
```

- [ ] **Step 4: Commit**

```bash
git add miniprogram/components/
git commit -m "feat(miniprogram): add message-bubble, empty-state, progress-bar components"
```

---

### Task 5: 记账页 (Tab 1)

**Files:**
- Create: `miniprogram/pages/chat/chat.wxml`
- Create: `miniprogram/pages/chat/chat.wxss`
- Create: `miniprogram/pages/chat/chat.js`
- Create: `miniprogram/pages/chat/chat.json`
- Create: `miniprogram/components/ocr-confirm/ocr-confirm.wxml`
- Create: `miniprogram/components/ocr-confirm/ocr-confirm.wxss`
- Create: `miniprogram/components/ocr-confirm/ocr-confirm.js`
- Create: `miniprogram/components/ocr-confirm/ocr-confirm.json`

- [ ] **Step 1: 创建 ocr-confirm 组件**

`ocr-confirm.json`:
```json
{ "component": true, "usingComponents": {} }
```

`ocr-confirm.wxml`:
```xml
<view class="ocr-card">
  <view class="ocr-header">📷 识别到 {{records.length}} 条消费记录</view>
  <view class="ocr-item" wx:for="{{records}}" wx:key="index">
    <view class="ocr-row">
      <input class="ocr-amount" type="digit" value="{{item.amount}}" data-index="{{index}}" data-field="amount" bindinput="onFieldChange" />
      <picker class="ocr-cat" value="{{categoryIndex}}" range="{{categories}}" data-index="{{index}}" bindchange="onCategoryChange">
        <view>{{item.category || '分类'}}</view>
      </picker>
      <input class="ocr-date" type="text" value="{{item.date}}" data-index="{{index}}" data-field="date" bindinput="onFieldChange" placeholder="YYYY-MM-DD" />
    </view>
    <view class="ocr-row">
      <input class="ocr-merchant" value="{{item.merchant || ''}}" data-index="{{index}}" data-field="merchant" bindinput="onFieldChange" placeholder="商家（选填）" />
      <input class="ocr-desc" value="{{item.description || ''}}" data-index="{{index}}" data-field="description" bindinput="onFieldChange" placeholder="描述" />
    </view>
    <view class="ocr-del" data-index="{{index}}" bindtap="onRemove">✕</view>
  </view>
  <view class="ocr-actions">
    <button class="btn btn-outline btn-sm" bindtap="onCancel">取消</button>
    <button class="btn btn-primary btn-sm" bindtap="onConfirm" loading="{{saving}}">{{saving ? '保存中...' : '✓ 确认保存 (' + records.length + '条)'}}</button>
  </view>
</view>
```

`ocr-confirm.wxss`:
```css
.ocr-card { background: #f8fafc; border: 1rpx solid var(--border); border-radius: 20rpx; padding: 24rpx; }
.ocr-header { font-size: 28rpx; font-weight: 600; margin-bottom: 20rpx; }
.ocr-item { position: relative; background: #fff; border: 1rpx solid #e2e8f0; border-radius: 16rpx; padding: 16rpx 56rpx 16rpx 16rpx; margin-bottom: 12rpx; }
.ocr-row { display: flex; gap: 10rpx; margin-bottom: 8rpx; }
.ocr-row:last-child { margin-bottom: 0; }
.ocr-row input, .ocr-row picker { padding: 10rpx 14rpx; border: 1rpx solid #e2e8f0; border-radius: 10rpx; font-size: 26rpx; background: #fff; }
.ocr-amount { width: 140rpx; }
.ocr-cat { width: 130rpx; display: flex; align-items: center; }
.ocr-date { width: 210rpx; }
.ocr-merchant, .ocr-desc { flex: 1; min-width: 140rpx; }
.ocr-del { position: absolute; top: 10rpx; right: 10rpx; font-size: 24rpx; color: var(--danger); padding: 4rpx 10rpx; }
.ocr-actions { display: flex; gap: 16rpx; justify-content: flex-end; margin-top: 16rpx; }
```

`ocr-confirm.js`:
```js
Component({
  properties: {
    records: { type: Array, value: [] },
    ocrSessionId: { type: String, value: '' },
    saving: { type: Boolean, value: false }
  },
  data: {
    categories: ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他']
  },
  methods: {
    onFieldChange(e) {
      const { index, field } = e.currentTarget.dataset
      const records = this.data.records
      records[index][field] = e.detail.value
      this.setData({ records })
    },
    onCategoryChange(e) {
      const index = e.currentTarget.dataset.index
      const records = this.data.records
      records[index].category = this.data.categories[e.detail.value]
      this.setData({ records })
    },
    onRemove(e) {
      this.triggerEvent('remove', { index: e.currentTarget.dataset.index })
    },
    onCancel() { this.triggerEvent('cancel') },
    onConfirm() { this.triggerEvent('confirm') }
  }
})
```

- [ ] **Step 2: 创建 chat.json**

```json
{
  "navigationBarTitleText": "智能记账",
  "usingComponents": {
    "message-bubble": "/components/message-bubble/message-bubble",
    "ocr-confirm": "/components/ocr-confirm/ocr-confirm",
    "empty-state": "/components/empty-state/empty-state"
  }
}
```

- [ ] **Step 3: 创建 chat.wxml**

```xml
<view class="chat-page">
  <!-- 消息列表 -->
  <scroll-view class="msg-list" scroll-y scroll-into-view="{{scrollToId}}" scroll-with-animation>
    <empty-state icon="💬" text="开始记账吧！告诉我你今天花了多少钱~" wx:if="{{messages.length === 0 && !ocrPending}}">
      <view class="quick-actions">
        <view class="quick-action" bindtap="sendQuick" data-text="今天午餐花了25元">🍜 午餐25元</view>
        <view class="quick-action" bindtap="sendQuick" data-text="打车上班花了30元">🚕 打车30元</view>
        <view class="quick-action" bindtap="sendQuick" data-text="我这个月花了多少钱">📊 本月汇总</view>
        <view class="quick-action" bindtap="sendQuick" data-text="有什么省钱建议吗">💡 消费建议</view>
      </view>
    </empty-state>

    <message-bubble wx:for="{{messages}}" wx:key="index" msg="{{item}}" id="msg-{{index}}" />

    <!-- OCR 确认卡片 -->
    <ocr-confirm wx:if="{{ocrPending}}"
      records="{{ocrRecords}}"
      ocrSessionId="{{ocrSessionId}}"
      saving="{{savingOcr}}"
      bind:remove="onOcrRemove"
      bind:cancel="onOcrCancel"
      bind:confirm="onOcrConfirm" />

    <!-- 加载中 -->
    <view class="msg-left" wx:if="{{loading}}">
      <view class="avatar">🤖</view>
      <view class="bubble-assistant" style="color:#64748b">思考中...</view>
    </view>
  </scroll-view>

  <!-- 汇率入口 -->
  <view class="rate-toggle" bindtap="toggleRates">
    <text>🌍 汇率看板</text>
    <text>{{showRates ? '▲' : '▼'}}</text>
  </view>
  <scroll-view class="rate-list" scroll-x wx:if="{{showRates}}">
    <view class="rate-card" wx:for="{{rates}}" wx:key="code">
      <view class="rate-flag">{{item.flag}}</view>
      <view class="rate-name">{{item.code}}</view>
      <view class="rate-value">{{item.rateText || '—'}}</view>
    </view>
  </scroll-view>

  <!-- 输入栏 -->
  <view class="input-bar">
    <view class="input-row">
      <input class="chat-input" value="{{input}}" placeholder="输入消费记录或问题..." bindinput="onInput" confirm-type="send" bindconfirm="send" adjust-position="{{true}}" />
      <button class="btn-upload" bindtap="takePhoto">📷</button>
      <button class="btn-send" bindtap="send" disabled="{{!input || loading}}">↑</button>
    </view>
    <view class="quick-actions">
      <view class="quick-action" bindtap="sendQuick" data-text="今天午餐花了25元">🍜 记账</view>
      <view class="quick-action" bindtap="sendQuick" data-text="这个月花了多少钱">📊 本月</view>
      <view class="quick-action" bindtap="sendQuick" data-text="有什么省钱建议吗">💡 建议</view>
      <view class="quick-action quick-highlight" bindtap="takePhoto">📷 扫小票</view>
    </view>
  </view>
</view>
```

- [ ] **Step 4: 创建 chat.wxss**

```css
.chat-page { display: flex; flex-direction: column; height: 100vh; }
.msg-list { flex: 1; padding: 24rpx; }
.msg-left { display: flex; gap: 16rpx; align-items: flex-start; }
.msg-left .avatar { width: 72rpx; height: 72rpx; border-radius: 50%; background: #eef2ff; display: flex; align-items: center; justify-content: center; font-size: 32rpx; flex-shrink: 0; }
.bubble-assistant { padding: 20rpx 28rpx; background: var(--bg-card); border: 1rpx solid var(--border); border-radius: 28rpx 28rpx 28rpx 8rpx; font-size: 28rpx; }

.rate-toggle { display: flex; justify-content: space-between; padding: 16rpx 30rpx; background: var(--bg-card); border-top: 1rpx solid var(--border); font-size: 26rpx; color: var(--text-secondary); }
.rate-toggle:active { background: #f1f5f9; }
.rate-list { padding: 16rpx 10rpx; background: var(--bg-card); border-top: 1rpx solid var(--border); white-space: nowrap; }
.rate-card { display: inline-block; background: var(--bg); border-radius: 16rpx; padding: 16rpx 24rpx; margin: 0 10rpx; text-align: center; min-width: 140rpx; }
.rate-flag { font-size: 36rpx; }
.rate-name { font-size: 22rpx; color: var(--text-secondary); }
.rate-value { font-size: 30rpx; font-weight: 700; margin-top: 8rpx; font-variant-numeric: tabular-nums; }

.input-bar { background: var(--bg-card); border-top: 1rpx solid var(--border); padding: 20rpx 24rpx; }
.input-row { display: flex; gap: 16rpx; align-items: flex-end; }
.chat-input { flex: 1; border: 1rpx solid var(--border); border-radius: 24rpx; padding: 18rpx 28rpx; font-size: 28rpx; }
.btn-upload { width: 80rpx; height: 80rpx; border-radius: 50%; border: 1rpx solid var(--border); background: var(--bg); font-size: 36rpx; display: flex; align-items: center; justify-content: center; padding: 0; line-height: 1; }
.btn-send { width: 80rpx; height: 80rpx; border-radius: 50%; background: var(--primary); color: #fff; font-size: 36rpx; border: none; display: flex; align-items: center; justify-content: center; padding: 0; line-height: 1; }
.btn-send[disabled] { background: #cbd5e1; }

.quick-actions { display: flex; gap: 12rpx; margin-top: 16rpx; flex-wrap: wrap; justify-content: center; }
.quick-action { padding: 10rpx 24rpx; background: #f1f5f9; border: 1rpx solid var(--border); border-radius: 40rpx; font-size: 24rpx; color: var(--text-secondary); }
.quick-action:active { background: #eef2ff; color: var(--primary); }
.quick-highlight { background: #fef3c7; border-color: var(--warning); color: #92400e; }
```

- [ ] **Step 5: 创建 chat.js**

```js
const { api } = require('../../utils/api.js')
const { getToken } = require('../../utils/auth.js')

Page({
  data: {
    messages: [],
    input: '',
    loading: false,
    scrollToId: '',

    // OCR
    ocrPending: false,
    ocrRecords: [],
    ocrSessionId: '',
    savingOcr: false,

    // 汇率
    showRates: false,
    rates: []
  },

  onShow() {
    if (!getToken()) {
      wx.redirectTo({ url: '/pages/login/login' })
      return
    }
    this.loadRates()
  },

  onInput(e) { this.setData({ input: e.detail.value }) },

  async send() {
    const text = this.data.input.trim()
    if (!text || this.data.loading) return

    const messages = [...this.data.messages, { role: 'user', content: text, time: this.formatTime() }]
    this.setData({ input: '', messages, loading: true })
    this.scrollBottom()

    try {
      const res = await api.chat(text)
      if (res.success) {
        messages.push({
          role: 'assistant',
          content: res.data.message,
          intent: res.data.intent,
          time: this.formatTime()
        })
      } else {
        messages.push({ role: 'assistant', content: '抱歉，出了点问题，请重试 😅', time: this.formatTime() })
      }
    } catch {
      messages.push({ role: 'assistant', content: '网络错误，请稍后重试 😅', time: this.formatTime() })
    }

    this.setData({ messages, loading: false })
    this.scrollBottom()
  },

  sendQuick(e) {
    this.setData({ input: e.currentTarget.dataset.text })
    this.send()
  },

  formatTime() {
    const d = new Date()
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
  },

  scrollBottom() {
    const len = this.data.messages.length
    if (len > 0) {
      this.setData({ scrollToId: 'msg-' + (len - 1) })
    }
  },

  // 拍照 OCR
  takePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera'],
      success: (res) => this.doOcr(res.tempFiles[0].tempFilePath)
    })
  },

  async doOcr(filePath) {
    this.setData({ loading: true })
    try {
      const res = await api.ocrReceipt(filePath)
      if (res.success && res.data.records && res.data.records.length > 0) {
        this.setData({
          ocrSessionId: res.data.ocrSessionId || '',
          ocrRecords: res.data.records.map(r => ({
            ...r,
            date: r.date || new Date().toISOString().slice(0, 10)
          })),
          ocrPending: true,
          loading: false
        })
      } else {
        const messages = [...this.data.messages, {
          role: 'assistant',
          content: res.data?.summary || '未能识别图片中的消费信息',
          time: this.formatTime()
        }]
        this.setData({ messages, loading: false })
        this.scrollBottom()
      }
    } catch {
      const messages = [...this.data.messages, {
        role: 'assistant',
        content: '图片识别失败，请重试',
        time: this.formatTime()
      }]
      this.setData({ messages, loading: false })
      this.scrollBottom()
    }
  },

  onOcrRemove(e) {
    const records = [...this.data.ocrRecords]
    records.splice(e.detail.index, 1)
    this.setData({ ocrRecords: records })
    if (records.length === 0) this.onOcrCancel()
  },

  async onOcrCancel() {
    const sessionId = this.data.ocrSessionId
    this.setData({ ocrPending: false, ocrRecords: [], ocrSessionId: '' })
    if (sessionId) {
      await api.cancelOcr(sessionId).catch(() => {})
    }
  },

  async onOcrConfirm() {
    const sessionId = this.data.ocrSessionId
    if (!sessionId) {
      this.setData({ ocrPending: false, ocrRecords: [] })
      return
    }

    this.setData({ savingOcr: true })
    try {
      const records = this.data.ocrRecords
        .filter(r => r.amount && r.category && r.date)
        .map(r => ({
          type: r.type || 'expense',
          amount: Number(r.amount),
          category: r.category,
          description: r.description || r.category,
          date: r.date,
          merchant: r.merchant || null
        }))

      const res = await api.confirmOcr(sessionId, records)
      if (res.success) {
        const saved = res.data.records || []
        const total = saved.reduce((s, r) => s + Number(r.amount_cny || r.amount || 0), 0)
        this.data.messages.push({
          role: 'assistant',
          content: '📷 已保存 ' + saved.length + ' 条消费记录，合计 ¥' + total.toFixed(2),
          time: this.formatTime()
        })
      }
    } catch {}

    this.setData({ savingOcr: false, ocrPending: false, ocrRecords: [], ocrSessionId: '' })
    this.scrollBottom()
  },

  // 汇率
  toggleRates() {
    this.setData({ showRates: !this.data.showRates })
    if (!this.data.showRates) return
    if (this.data.rates.length === 0) this.loadRates()
  },

  async loadRates() {
    try {
      const res = await api.getExchangeRates()
      if (res.data) {
        const config = [
          { code: 'USD', flag: '🇺🇸' },
          { code: 'EUR', flag: '🇪🇺' },
          { code: 'JPY', flag: '🇯🇵' },
          { code: 'GBP', flag: '🇬🇧' },
          { code: 'HKD', flag: '🇭🇰' },
          { code: 'KRW', flag: '🇰🇷' }
        ]
        const rates = config.map(c => {
          const d = res.data[c.code]
          return {
            code: c.code,
            flag: c.flag,
            rateText: d ? Number(d.rate).toFixed(4) : '—'
          }
        })
        this.setData({ rates })
      }
    } catch {}
  }
})
```

- [ ] **Step 6: Commit**

```bash
git add miniprogram/pages/chat/ miniprogram/components/ocr-confirm/
git commit -m "feat(miniprogram): add chat page with OCR photo receipt and exchange rate cards"
```

---

### Task 6: 分析页 (Tab 2)

**Files:**
- Create: `miniprogram/pages/report/report.wxml`
- Create: `miniprogram/pages/report/report.wxss`
- Create: `miniprogram/pages/report/report.js`
- Create: `miniprogram/pages/report/report.json`
- Create: `miniprogram/subpackages/chart/ec-canvas/ec-canvas.wxml`
- Create: `miniprogram/subpackages/chart/ec-canvas/ec-canvas.wxss`
- Create: `miniprogram/subpackages/chart/ec-canvas/ec-canvas.js`
- Create: `miniprogram/subpackages/chart/ec-canvas/ec-canvas.json`
- Create: `miniprogram/subpackages/chart/ec-canvas/echarts.js` (官方 echarts-for-weixin 源码)

- [ ] **Step 1: 安装 echarts-for-weixin**

从 GitHub 下载 `ec-canvas` 组件到 `miniprogram/subpackages/chart/ec-canvas/` 目录：
- `ec-canvas.wxml` / `ec-canvas.wxss` / `ec-canvas.js` / `ec-canvas.json`
- 精简版 `echarts.js`（仅引入 pie + line + tooltip + legend + grid）

```bash
# 手动从 https://github.com/ecomfe/echarts-for-weixin 复制 ec-canvas 目录到 subpackages/chart/ec-canvas/
```

注意：`echarts.js` 需放在 `subpackages/chart/ec-canvas/echarts.js`，按需引入 pie/line 模块控制体积。

- [ ] **Step 2: 创建 report.json**

```json
{
  "navigationBarTitleText": "消费分析",
  "usingComponents": {
    "ec-canvas": "/subpackages/chart/ec-canvas/ec-canvas",
    "progress-bar": "/components/progress-bar/progress-bar",
    "empty-state": "/components/empty-state/empty-state"
  }
}
```

- [ ] **Step 3: 创建 report.wxml**

```xml
<scroll-view class="report-page" scroll-y>
  <!-- 周期切换 -->
  <view class="period-bar">
    <view class="period-item {{activePeriod === 'week' ? 'active' : ''}}" bindtap="switchPeriod" data-period="week">近一周</view>
    <view class="period-item {{activePeriod === 'month' ? 'active' : ''}}" bindtap="switchPeriod" data-period="month">近一月</view>
    <view class="period-item {{activePeriod === 'quarter' ? 'active' : ''}}" bindtap="switchPeriod" data-period="quarter">近一季</view>
  </view>

  <!-- 加载失败 -->
  <view class="error-banner" wx:if="{{loadError}}">
    ⚠️ {{loadError}}
    <button class="btn btn-outline btn-sm" bindtap="loadAll" style="margin-left: 20rpx;">重试</button>
  </view>

  <!-- 统计卡片 -->
  <view class="card stat-card" wx:if="{{report}}">
    <view class="stat-row">
      <view class="stat-item stat-income">
        <view class="stat-value">¥{{report.incomeText || '0'}}</view>
        <view class="stat-label">收入</view>
      </view>
      <view class="stat-item stat-expense">
        <view class="stat-value">¥{{report.expenseText || '0'}}</view>
        <view class="stat-label">支出</view>
      </view>
      <view class="stat-item stat-balance">
        <view class="stat-value">{{report.balanceText || '0'}}</view>
        <view class="stat-label">结余</view>
      </view>
    </view>
    <view class="stat-meta">共 {{report.count || 0}} 笔 · 储蓄率 {{report.savingsRate || 0}}%</view>
  </view>

  <!-- 饼图 -->
  <view class="card" wx:if="{{hasCategories}}">
    <view class="card-title">🍩 支出分类</view>
    <ec-canvas wx:if="{{pieReady}}" canvas-id="pie-chart" ec="{{pieEc}}"></ec-canvas>
  </view>
  <empty-state icon="🍩" text="暂无支出记录" wx:if="{{!hasCategories}}"></empty-state>

  <!-- 趋势图 -->
  <view class="card" wx:if="{{hasTrends}}">
    <view class="card-title">📈 消费趋势</view>
    <ec-canvas wx:if="{{trendReady}}" canvas-id="trend-chart" ec="{{trendEc}}"></ec-canvas>
  </view>
  <empty-state icon="📈" text="数据不足" wx:if="{{!hasTrends}}"></empty-state>

  <!-- 最近记录 + 编辑 -->
  <view class="card">
    <view class="flex-between">
      <view class="card-title">📝 最近记录</view>
      <view class="text-sm text-secondary">{{records.length}} 条</view>
    </view>
    <view class="record-item" wx:for="{{records}}" wx:key="id">
      <view class="flex-1">
        <view class="record-desc">{{item.description || item.category}}</view>
        <view class="text-sm text-secondary">{{item.date}} · {{item.category}} · {{item.type === 'income' ? '收入' : '支出'}}</view>
      </view>
      <view class="record-amount {{item.type === 'income' ? 'income' : 'expense'}}">
        {{item.type === 'income' ? '+' : '-'}}{{item.amountText}}
      </view>
      <view class="btn-edit" bindtap="openEdit" data-id="{{item.id}}">✎</view>
    </view>
  </view>

  <!-- 编辑弹窗 -->
  <view class="modal-mask" wx:if="{{editRec}}" bindtap="closeEdit">
    <view class="modal" catchtap="">
      <view class="modal-title">✎ 编辑记录</view>
      <view class="form-group">
        <view class="form-label">类型</view>
        <picker value="{{editForm.type === 'income' ? 1 : 0}}" range="{{['支出', '收入']}}" bindchange="onEditTypeChange">
          <view class="form-input">{{editForm.type === 'income' ? '收入' : '支出'}}</view>
        </picker>
      </view>
      <view class="form-group">
        <view class="form-label">金额</view>
        <input class="form-input" type="digit" value="{{editForm.amount}}" bindinput="onEditField" data-field="amount" />
      </view>
      <view class="form-group">
        <view class="form-label">分类</view>
        <picker value="{{categoryIndex}}" range="{{categories}}" bindchange="onEditCategory">
          <view class="form-input">{{editForm.category}}</view>
        </picker>
      </view>
      <view class="form-group">
        <view class="form-label">日期</view>
        <input class="form-input" type="text" value="{{editForm.date}}" bindinput="onEditField" data-field="date" placeholder="YYYY-MM-DD" />
      </view>
      <view class="form-group">
        <view class="form-label">商家</view>
        <input class="form-input" value="{{editForm.merchant}}" bindinput="onEditField" data-field="merchant" placeholder="选填" />
      </view>
      <view class="form-group">
        <view class="form-label">描述</view>
        <input class="form-input" value="{{editForm.description}}" bindinput="onEditField" data-field="description" placeholder="选填" />
      </view>
      <view class="modal-actions">
        <button class="btn btn-outline" bindtap="closeEdit">取消</button>
        <button class="btn btn-primary" bindtap="saveEdit" loading="{{savingEdit}}">保存</button>
      </view>
    </view>
  </view>
</scroll-view>
```

- [ ] **Step 4: 创建 report.js**

```js
const { api } = require('../../utils/api.js')
const { getToken } = require('../../utils/auth.js')

Page({
  data: {
    activePeriod: 'month',
    report: null,
    records: [],
    loadError: '',
    hasCategories: false,
    hasTrends: false,
    pieReady: false,
    trendReady: false,
    pieEc: {
      lazyLoad: true,
      onInit: null
    },
    trendEc: {
      lazyLoad: true,
      onInit: null
    },

    // 编辑
    editRec: null,
    editForm: {},
    savingEdit: false,
    categories: ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他']
  },

  onShow() {
    if (!getToken()) {
      wx.redirectTo({ url: '/pages/login/login' })
      return
    }
    this.loadAll()
  },

  switchPeriod(e) {
    this.setData({ activePeriod: e.currentTarget.dataset.period })
    this.loadAll()
  },

  async loadAll() {
    this.setData({ loadError: '' })
    try {
      const [rRes, recRes] = await Promise.all([
        api.getReportTimerange(this.data.activePeriod),
        api.getRecords({ limit: 50 })
      ])

      if (!rRes.success && rRes.error === '登录已过期') {
        wx.redirectTo({ url: '/pages/login/login' })
        return
      }
      if (!recRes.success && recRes.error === '登录已过期') {
        wx.redirectTo({ url: '/pages/login/login' })
        return
      }

      if (rRes.success) {
        const d = rRes.data
        this.setData({
          report: {
            ...d,
            incomeText: (d.income || 0).toFixed(0),
            expenseText: (d.expense || 0).toFixed(0),
            balanceText: (d.balance >= 0 ? '+' : '') + (d.balance || 0).toFixed(0)
          },
          hasCategories: (d.categories || []).length > 0,
          hasTrends: (d.trends || []).length > 0
        })
        // 渲染图表
        this.renderCharts(d)
      } else {
        this.setData({ loadError: '数据加载失败' })
      }

      if (recRes.success) {
        this.setData({
          records: (recRes.data || []).map(r => ({
            ...r,
            amount: Number(r.amount) || 0,
            amountText: (Number(r.amount) || 0).toFixed(2)
          }))
        })
      }
    } catch {
      this.setData({ loadError: '网络错误，请刷新重试' })
    }
  },

  renderCharts(d) {
    // 饼图
    if ((d.categories || []).length > 0) {
      this.setData({
        pieEc: {
          lazyLoad: true,
          onInit: (canvas, width, height, dpr) => {
            const chart = require('../../subpackages/chart/ec-canvas/echarts.js')
            const pieChart = chart.init(canvas, null, { width, height, devicePixelRatio: dpr })
            canvas.setChart(pieChart)
            pieChart.setOption({
              tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)' },
              series: [{
                type: 'pie', radius: ['45%', '75%'],
                data: d.categories.map(c => ({ name: c.category, value: c.total }))
              }]
            })
            return pieChart
          }
        },
        pieReady: true
      })
    }

    // 趋势图
    if ((d.trends || []).length > 0) {
      this.setData({
        trendEc: {
          lazyLoad: true,
          onInit: (canvas, width, height, dpr) => {
            const chart = require('../../subpackages/chart/ec-canvas/echarts.js')
            const trendChart = chart.init(canvas, null, { width, height, devicePixelRatio: dpr })
            canvas.setChart(trendChart)
            const labels = d.trends.map(t => t.label)
            trendChart.setOption({
              tooltip: { trigger: 'axis' },
              legend: { data: ['支出', '收入'] },
              xAxis: { type: 'category', data: labels.map(l => l.slice(5)) },
              yAxis: { type: 'value' },
              series: [
                { name: '支出', type: 'line', data: d.trends.map(t => t.expense), smooth: true },
                { name: '收入', type: 'line', data: d.trends.map(t => t.income), smooth: true }
              ]
            })
            return trendChart
          }
        },
        trendReady: true
      })
    }
  },

  // 编辑记录
  openEdit(e) {
    const id = e.currentTarget.dataset.id
    const rec = this.data.records.find(r => r.id === id)
    if (!rec) return
    this.setData({
      editRec: rec,
      editForm: {
        type: rec.type,
        amount: rec.amount,
        category: rec.category,
        date: rec.date,
        merchant: rec.merchant || '',
        description: rec.description || ''
      }
    })
  },

  closeEdit() { this.setData({ editRec: null }) },

  onEditTypeChange(e) {
    const editForm = { ...this.data.editForm, type: e.detail.value === '1' ? 'income' : 'expense' }
    this.setData({ editForm })
  },

  onEditField(e) {
    const field = e.currentTarget.dataset.field
    const editForm = { ...this.data.editForm, [field]: e.detail.value }
    this.setData({ editForm })
  },

  onEditCategory(e) {
    const editForm = { ...this.data.editForm, category: this.data.categories[e.detail.value] }
    this.setData({ editForm })
  },

  async saveEdit() {
    if (!this.data.editRec || this.data.savingEdit) return
    this.setData({ savingEdit: true })
    try {
      await api.updateRecord(this.data.editRec.id, this.data.editForm)
      this.setData({ editRec: null, savingEdit: false })
      this.loadAll()
    } catch {
      this.setData({ savingEdit: false })
    }
  }
})
```

- [ ] **Step 5: 创建 report.wxss**

```css
.report-page { height: 100vh; padding: 24rpx; }
.period-bar { display: flex; background: var(--bg-card); border-radius: 20rpx; padding: 8rpx; margin-bottom: 24rpx; }
.period-item { flex: 1; text-align: center; padding: 16rpx; border-radius: 16rpx; font-size: 28rpx; color: var(--text-secondary); }
.period-item.active { background: var(--bg); color: var(--primary); font-weight: 600; box-shadow: 0 2rpx 6rpx rgba(0,0,0,0.08); }

.card { background: var(--bg-card); border-radius: var(--radius); padding: 24rpx; border: 1rpx solid var(--border); margin-bottom: 24rpx; }
.card-title { font-size: 30rpx; font-weight: 600; margin-bottom: 20rpx; }

.stat-row { display: flex; gap: 16rpx; }
.stat-item { flex: 1; text-align: center; padding: 24rpx 16rpx; background: #f8fafc; border-radius: 16rpx; }
.stat-value { font-size: 36rpx; font-weight: 700; }
.stat-label { font-size: 24rpx; color: var(--text-secondary); margin-top: 8rpx; }
.stat-income .stat-value { color: var(--success); }
.stat-expense .stat-value { color: var(--danger); }
.stat-balance .stat-value { color: var(--primary); }
.stat-meta { font-size: 24rpx; color: var(--text-secondary); margin-top: 16rpx; text-align: center; }

.record-item { display: flex; align-items: center; padding: 20rpx 0; border-bottom: 1rpx solid var(--border); }
.record-item:last-child { border-bottom: none; }
.record-desc { font-size: 28rpx; }
.record-amount { font-weight: 600; font-size: 30rpx; margin: 0 16rpx; }
.record-amount.expense { color: var(--danger); }
.record-amount.income { color: var(--success); }
.btn-edit { font-size: 30rpx; color: var(--text-secondary); padding: 8rpx; opacity: 0.4; }

.modal-actions { display: flex; gap: 20rpx; justify-content: flex-end; margin-top: 30rpx; }
```

- [ ] **Step 6: Commit**

```bash
git add miniprogram/pages/report/ miniprogram/subpackages/chart/
git commit -m "feat(miniprogram): add report page with echarts pie chart and trend line"
```

---

### Task 7: 目标页 (Tab 3)

**Files:**
- Create: `miniprogram/pages/goal/goal.wxml`
- Create: `miniprogram/pages/goal/goal.wxss`
- Create: `miniprogram/pages/goal/goal.js`
- Create: `miniprogram/pages/goal/goal.json`

- [ ] **Step 1: 创建 goal.json**

```json
{
  "navigationBarTitleText": "目标规划",
  "usingComponents": {
    "progress-bar": "/components/progress-bar/progress-bar",
    "empty-state": "/components/empty-state/empty-state"
  }
}
```

- [ ] **Step 2: 创建 goal.wxml**

```xml
<scroll-view class="goal-page" scroll-y>
  <!-- 错误 -->
  <view class="error-banner" wx:if="{{error}}">
    ⚠️ {{error}}
    <button class="btn btn-outline btn-sm" bindtap="loadData" style="margin-left:20rpx;">重试</button>
  </view>

  <!-- 加载中 -->
  <view class="empty-state" wx:if="{{loading}}">
    <view class="empty-icon">⏳</view>
    <view>加载中...</view>
  </view>

  <view wx:if="{{!loading && !error}}">
    <!-- 月度预算 -->
    <view class="card">
      <view class="card-title">💰 月度预算</view>
      <view class="budget-item" wx:for="{{budgets}}" wx:key="id">
        <view class="flex-between" style="margin-bottom:10rpx;">
          <text>{{item.category || '总预算'}}</text>
          <text class="text-sm text-secondary">¥{{item.spentText}} / ¥{{item.amountText}}</text>
        </view>
        <progress-bar percent="{{item.percent}}" status="{{item.percent > 80 ? 'danger' : item.percent > 60 ? 'warn' : 'good'}}" />
      </view>
      <button class="btn btn-outline btn-sm" bindtap="showBudgetForm" style="margin-top:24rpx;">+ 设置预算</button>
    </view>

    <!-- 储蓄目标列表 -->
    <view class="flex-between" style="margin-bottom:28rpx;">
      <view class="card-title" style="margin:0;">🎯 储蓄目标</view>
      <button class="btn btn-primary btn-sm" bindtap="showGoalForm">+ 新建目标</button>
    </view>

    <view class="goal-card" wx:for="{{goals}}" wx:key="id">
      <view class="flex-between" style="margin-bottom:16rpx;">
        <text class="font-bold">{{item.name}}</text>
        <text class="text-sm text-secondary">¥{{item.currentText}} / ¥{{item.targetText}}</text>
      </view>
      <progress-bar percent="{{item.percent}}" status="{{item.percent >= 100 ? 'good' : 'warn'}}" />
      <view class="flex-between" style="margin:10rpx 0;">
        <text class="text-sm text-secondary">进度 {{item.percent}}%</text>
        <text class="text-sm text-secondary" wx:if="{{item.deadline}}">截止: {{item.deadline}}</text>
      </view>
      <view class="flex-row" style="gap:16rpx;">
        <button class="btn btn-outline btn-sm" bindtap="addProgress" data-id="{{item.id}}">+ 存入</button>
        <button class="btn btn-outline btn-sm" bindtap="completeGoal" data-id="{{item.id}}" wx:if="{{!item.completed}}">{{item.percent >= 100 ? '✓ 完成' : '标记完成'}}</button>
        <button class="btn btn-outline btn-sm" bindtap="deleteGoal" data-id="{{item.id}}" style="color:var(--danger);">删除</button>
      </view>
    </view>
    <empty-state wx:if="{{goals.length === 0}}" icon="🎯" text="还没有储蓄目标" subText="设定一个目标，开始你的储蓄计划吧！"></empty-state>
  </view>

  <!-- 新建目标弹窗 -->
  <view class="modal-mask" wx:if="{{showGoalModal}}" bindtap="closeGoalModal">
    <view class="modal" catchtap="">
      <view class="modal-title">新建储蓄目标</view>
      <view class="form-group">
        <view class="form-label">目标名称</view>
        <input class="form-input" value="{{goalForm.name}}" placeholder="如：买新手机" bindinput="onGoalField" data-field="name" />
      </view>
      <view class="form-group">
        <view class="form-label">目标金额 (元)</view>
        <input class="form-input" type="digit" value="{{goalForm.target_amount}}" placeholder="5000" bindinput="onGoalField" data-field="target_amount" />
      </view>
      <view class="form-group">
        <view class="form-label">截止日期</view>
        <input class="form-input" type="text" value="{{goalForm.deadline}}" placeholder="YYYY-MM-DD" bindinput="onGoalField" data-field="deadline" />
      </view>
      <view class="modal-actions">
        <button class="btn btn-outline" bindtap="closeGoalModal">取消</button>
        <button class="btn btn-primary" bindtap="createGoal">确认创建</button>
      </view>
    </view>
  </view>

  <!-- 存入进度弹窗 -->
  <view class="modal-mask" wx:if="{{showProgressModal}}" bindtap="closeProgressModal">
    <view class="modal" catchtap="">
      <view class="modal-title">存入金额 - {{progressGoalName}}</view>
      <view class="form-group">
        <view class="form-label">金额 (元)</view>
        <input class="form-input" type="digit" value="{{progressAmount}}" placeholder="500" bindinput="onProgressAmount" />
      </view>
      <view class="modal-actions">
        <button class="btn btn-outline" bindtap="closeProgressModal">取消</button>
        <button class="btn btn-primary" bindtap="saveProgress">确认存入</button>
      </view>
    </view>
  </view>

  <!-- 设置预算弹窗 -->
  <view class="modal-mask" wx:if="{{showBudgetModal}}" bindtap="closeBudgetModal">
    <view class="modal" catchtap="">
      <view class="modal-title">设置预算</view>
      <view class="form-group">
        <view class="form-label">类别（留空为总预算）</view>
        <picker value="{{budgetForm.categoryIndex}}" range="{{budgetCategories}}" bindchange="onBudgetCategory">
          <view class="form-input">{{budgetCategories[budgetForm.categoryIndex] || '总预算'}}</view>
        </picker>
      </view>
      <view class="form-group">
        <view class="form-label">预算金额 (元/月)</view>
        <input class="form-input" type="digit" value="{{budgetForm.amount}}" placeholder="2000" bindinput="onBudgetField" data-field="amount" />
      </view>
      <view class="modal-actions">
        <button class="btn btn-outline" bindtap="closeBudgetModal">取消</button>
        <button class="btn btn-primary" bindtap="saveBudget">确认设置</button>
      </view>
    </view>
  </view>
</scroll-view>
```

- [ ] **Step 3: 创建 goal.js**

```js
const { api } = require('../../utils/api.js')
const { getToken } = require('../../utils/auth.js')

Page({
  data: {
    goals: [],
    budgets: [],
    loading: true,
    error: '',
    showGoalModal: false,
    showProgressModal: false,
    showBudgetModal: false,
    goalForm: { name: '', target_amount: '', deadline: '' },
    progressGoalId: null,
    progressGoalName: '',
    progressAmount: '',
    budgetForm: { categoryIndex: 0, amount: '' },
    budgetCategories: ['总预算', '餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他']
  },

  onShow() {
    if (!getToken()) {
      wx.redirectTo({ url: '/pages/login/login' })
      return
    }
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const [gRes, bRes] = await Promise.all([api.getGoals(), api.getBudgets()])

      if (!gRes.success && gRes.error === '登录已过期') { wx.redirectTo({ url: '/pages/login/login' }); return }

      if (gRes.success) {
        const goals = (gRes.data || []).map(g => ({
          ...g,
          current_amount: Number(g.current_amount) || 0,
          target_amount: Number(g.target_amount) || 0,
          currentText: (Number(g.current_amount) || 0).toFixed(0),
          targetText: (Number(g.target_amount) || 0).toFixed(0),
          percent: g.target_amount > 0 ? Math.round(Number(g.current_amount) / Number(g.target_amount) * 100) : 0
        }))
        this.setData({ goals })
      }

      if (bRes.success) {
        const budgets = (bRes.data || []).map(b => {
          const amount = Number(b.amount) || 0
          const spent = Number(b.spent) || 0
          return { ...b, amount, spent, amountText: amount.toFixed(0), spentText: spent.toFixed(0), percent: amount > 0 ? Math.round(spent / amount * 100) : 0 }
        })
        this.setData({ budgets })
      }
    } catch {
      this.setData({ error: '网络错误，请刷新重试' })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 目标
  showGoalForm() { this.setData({ showGoalModal: true, goalForm: { name: '', target_amount: '', deadline: '' } }) },
  closeGoalModal() { this.setData({ showGoalModal: false }) },

  onGoalField(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['goalForm.' + field]: e.detail.value })
  },

  async createGoal() {
    const { name, target_amount, deadline } = this.data.goalForm
    if (!name || !target_amount) return
    await api.createGoal({ name, target_amount: Number(target_amount), deadline })
    this.closeGoalModal()
    this.loadData()
  },

  addProgress(e) {
    const goal = this.data.goals.find(g => g.id === e.currentTarget.dataset.id)
    if (!goal) return
    this.setData({ showProgressModal: true, progressGoalId: goal.id, progressGoalName: goal.name, progressAmount: '' })
  },

  closeProgressModal() { this.setData({ showProgressModal: false }) },

  onProgressAmount(e) { this.setData({ progressAmount: e.detail.value }) },

  async saveProgress() {
    const { progressGoalId, progressAmount } = this.data
    const goal = this.data.goals.find(g => g.id === progressGoalId)
    if (!goal || !progressAmount) return
    const newAmount = Number(goal.current_amount) + Number(progressAmount)
    await api.updateGoal(progressGoalId, { current_amount: newAmount })
    this.setData({ showProgressModal: false })
    this.loadData()
  },

  async completeGoal(e) {
    await api.updateGoal(e.currentTarget.dataset.id, { completed: 1 })
    this.loadData()
  },

  async deleteGoal(e) {
    await api.deleteGoal(e.currentTarget.dataset.id)
    this.loadData()
  },

  // 预算
  showBudgetForm() { this.setData({ showBudgetModal: true, budgetForm: { categoryIndex: 0, amount: '' } }) },
  closeBudgetModal() { this.setData({ showBudgetModal: false }) },

  onBudgetCategory(e) {
    this.setData({ 'budgetForm.categoryIndex': e.detail.value })
  },

  onBudgetField(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['budgetForm.' + field]: e.detail.value })
  },

  async saveBudget() {
    const { categoryIndex, amount } = this.data.budgetForm
    if (!amount) return
    const category = categoryIndex > 0 ? this.data.budgetCategories[categoryIndex] : null
    await api.setBudget({ category, amount: Number(amount) })
    this.setData({ showBudgetModal: false })
    this.loadData()
  }
})
```

- [ ] **Step 4: 创建 goal.wxss**

```css
.goal-page { height: 100vh; padding: 24rpx; }
.budget-item { margin-bottom: 28rpx; }
.goal-card { background: var(--bg-card); border-radius: var(--radius); padding: 28rpx; border: 1rpx solid var(--border); margin-bottom: 24rpx; }
```

- [ ] **Step 5: Commit**

```bash
git add miniprogram/pages/goal/
git commit -m "feat(miniprogram): add goal page with budget progress and savings goals"
```

---

### Task 8: 我的页 (Tab 4)

**Files:**
- Create: `miniprogram/pages/mine/mine.wxml`
- Create: `miniprogram/pages/mine/mine.wxss`
- Create: `miniprogram/pages/mine/mine.js`
- Create: `miniprogram/pages/mine/mine.json`

- [ ] **Step 1: 创建 mine.json**

```json
{
  "navigationBarTitleText": "我的",
  "usingComponents": {}
}
```

- [ ] **Step 2: 创建 mine.wxml**

```xml
<scroll-view class="mine-page" scroll-y>
  <!-- 用户信息 -->
  <view class="user-card">
    <view class="user-avatar">👤</view>
    <view class="user-info">
      <view class="user-name">{{user.nickname || '用户'}}</view>
      <view class="text-sm text-secondary">{{user.phone || '未绑定手机号'}}</view>
    </view>
  </view>

  <!-- 菜单 -->
  <view class="menu-list">
    <view class="menu-item" bindtap="showFeedback">
      <text>💡 意见反馈</text>
      <text class="menu-arrow">›</text>
    </view>
    <view class="menu-item" bindtap="showAbout">
      <text>ℹ️ 关于我们</text>
      <text class="menu-arrow">›</text>
    </view>
  </view>

  <!-- 退出登录 -->
  <view class="logout-area">
    <button class="btn btn-outline btn-full" bindtap="logout">退出登录</button>
  </view>

  <!-- 反馈弹窗 -->
  <view class="modal-mask" wx:if="{{showFeedbackModal}}" bindtap="closeFeedback">
    <view class="modal" catchtap="">
      <view class="modal-title">💬 意见反馈</view>
      <view class="form-group">
        <view class="form-label">详细描述</view>
        <textarea class="form-textarea" value="{{feedbackContent}}" placeholder="请描述你的问题或建议..." bindinput="onFeedbackInput" />
      </view>
      <view class="label-row">
        <view class="label-item {{feedbackType === 'suggestion' ? 'active' : ''}}" bindtap="setFeedbackType" data-type="suggestion">💡 建议</view>
        <view class="label-item {{feedbackType === 'bug' ? 'active' : ''}}" bindtap="setFeedbackType" data-type="bug">🐛 Bug</view>
        <view class="label-item {{feedbackType === 'ux' ? 'active' : ''}}" bindtap="setFeedbackType" data-type="ux">😕 体验</view>
        <view class="label-item {{feedbackType === 'other' ? 'active' : ''}}" bindtap="setFeedbackType" data-type="other">💬 其他</view>
      </view>
      <view class="modal-actions">
        <button class="btn btn-outline" bindtap="closeFeedback">取消</button>
        <button class="btn btn-primary" bindtap="submitFeedback" loading="{{submitting}}">{{submitting ? '提交中...' : '提交反馈'}}</button>
      </view>
      <view class="submit-result success" wx:if="{{submitOk}}">反馈已提交！感谢你的宝贵意见 🙏</view>
    </view>
  </view>

  <!-- 关于弹窗 -->
  <view class="modal-mask" wx:if="{{showAboutModal}}" bindtap="closeAbout">
    <view class="modal" catchtap="">
      <view class="modal-title" style="text-align:center;">💰 智能财务记账助手</view>
      <view class="text-sm text-secondary" style="text-align:center;margin-bottom:20rpx;">版本 1.0.0</view>
      <view class="text-sm text-secondary" style="text-align:center;">智能记账，轻松理财</view>
      <view style="text-align:center;margin-top:30rpx;">
        <button class="btn btn-outline" bindtap="closeAbout">关闭</button>
      </view>
    </view>
  </view>
</scroll-view>
```

- [ ] **Step 3: 创建 mine.js**

```js
const { api } = require('../../utils/api.js')
const { clearToken } = require('../../utils/auth.js')

const app = getApp()

Page({
  data: {
    user: {},
    showFeedbackModal: false,
    showAboutModal: false,
    feedbackContent: '',
    feedbackType: 'suggestion',
    submitting: false,
    submitOk: false
  },

  onShow() {
    this.setData({ user: app.globalData.user || {} })
  },

  showFeedback() { this.setData({ showFeedbackModal: true, submitOk: false }) },
  closeFeedback() { this.setData({ showFeedbackModal: false }) },
  showAbout() { this.setData({ showAboutModal: true }) },
  closeAbout() { this.setData({ showAboutModal: false }) },

  onFeedbackInput(e) { this.setData({ feedbackContent: e.detail.value }) },
  setFeedbackType(e) { this.setData({ feedbackType: e.currentTarget.dataset.type }) },

  async submitFeedback() {
    if (!this.data.feedbackContent.trim()) return
    this.setData({ submitting: true })
    try {
      await api.submitFeedback({
        type: this.data.feedbackType,
        content: this.data.feedbackContent.trim()
      })
      this.setData({ submitOk: true, submitting: false, feedbackContent: '' })
      setTimeout(() => this.closeFeedback(), 1500)
    } catch {
      this.setData({ submitting: false })
    }
  },

  logout() {
    clearToken()
    app.globalData.user = null
    app.globalData.token = ''
    wx.reLaunch({ url: '/pages/login/login' })
  }
})
```

- [ ] **Step 4: 创建 mine.wxss**

```css
.mine-page { height: 100vh; padding: 24rpx; }
.user-card { display: flex; align-items: center; gap: 24rpx; background: var(--bg-card); border-radius: var(--radius); padding: 40rpx; margin-bottom: 24rpx; }
.user-avatar { width: 100rpx; height: 100rpx; border-radius: 50%; background: #eef2ff; display: flex; align-items: center; justify-content: center; font-size: 50rpx; }
.user-name { font-size: 36rpx; font-weight: 600; }

.menu-list { background: var(--bg-card); border-radius: var(--radius); overflow: hidden; margin-bottom: 24rpx; }
.menu-item { display: flex; justify-content: space-between; align-items: center; padding: 32rpx; border-bottom: 1rpx solid var(--border); font-size: 30rpx; }
.menu-item:last-child { border-bottom: none; }
.menu-item:active { background: #f8fafc; }
.menu-arrow { font-size: 36rpx; color: #cbd5e1; }

.logout-area { padding: 0 40rpx; }

.form-textarea { width: 100%; padding: 20rpx; border: 1rpx solid var(--border); border-radius: 16rpx; font-size: 28rpx; min-height: 160rpx; box-sizing: border-box; }

.label-row { display: flex; gap: 16rpx; margin: 20rpx 0; flex-wrap: wrap; }
.label-item { padding: 12rpx 24rpx; border: 1rpx solid var(--border); border-radius: 40rpx; font-size: 24rpx; }
.label-item.active { background: #eef2ff; border-color: var(--primary-light); color: var(--primary); font-weight: 600; }

.submit-result.success { margin-top: 20rpx; padding: 20rpx; background: #ecfdf5; border-radius: 16rpx; color: var(--success); font-size: 26rpx; text-align: center; }
```

- [ ] **Step 5: Commit**

```bash
git add miniprogram/pages/mine/
git commit -m "feat(miniprogram): add mine page with feedback and logout"
```

---

### Task 9: 端到端验证 + 修复

**Files:**
- 无新建，修问题

- [ ] **Step 1: 用微信开发者工具打开 miniprogram 目录**

- [ ] **Step 2: 验证登录** — 打开小程序 → 跳转 login 页 → 输入用户名密码登录 → 成功进入 chat 页

- [ ] **Step 3: 验证记账** — 在 chat 页发送"今天午餐花了 25 元" → 返回记账成功 → 发送"这个月花了多少钱" → 返回统计数据

- [ ] **Step 4: 验证分析页** — 切换到 Tab 2 → 显示统计卡片和图表

- [ ] **Step 5: 验证目标页** — 切换到 Tab 3 → 创建目标 → 存入金额 → 验证进度条

- [ ] **Step 6: 验证我的页** — 切换到 Tab 4 → 提交反馈 → 退出登录

- [ ] **Step 7: 验证 OCR** — 回到 chat 页 → 点击相册里的小票图片 → 识别 + 确认保存

- [ ] **Step 8: 验证手机号登录** — 退出 → 点击手机号授权 → 后端解密成功 → 自动登录

- [ ] **Step 9: 修复发现的问题**

- [ ] **Step 10: Commit**

```bash
git add miniprogram/
git commit -m "fix(miniprogram): end-to-end verification fixes"
```

---

### Task 10: TabBar 图标

**Files:**
- Create: `miniprogram/images/tab-chat.png`
- Create: `miniprogram/images/tab-chat-active.png`
- Create: `miniprogram/images/tab-report.png`
- Create: `miniprogram/images/tab-report-active.png`
- Create: `miniprogram/images/tab-goal.png`
- Create: `miniprogram/images/tab-goal-active.png`
- Create: `miniprogram/images/tab-mine.png`
- Create: `miniprogram/images/tab-mine-active.png`

- [ ] **Step 1: 生成 8 张 Tab 图标**

用简单的 SVG/PNG 生成 40x40 像素的 Tab 图标（灰色）和选中态图标（紫色 #4f46e5）。也可暂时用微信小程序文档中的示例图标占位。

- [ ] **Step 2: Commit**

```bash
git add miniprogram/images/
git commit -m "feat(miniprogram): add tabBar icons"
```
