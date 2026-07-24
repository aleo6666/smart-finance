# Smart Finance 微信小程序设计

**日期**: 2026-07-22
**目标**: 开发与网页端功能一致的微信小程序，使用原生框架

## 1. 技术选型

| 项目 | 选择 | 原因 |
|---|---|---|
| 框架 | 原生微信小程序（WXML + WXSS + JS） | 无跨端需求，体积最小 |
| 图表 | echarts-for-weixin（官方版） | 分包懒加载，主包不受影响 |
| 登录 | 手机号授权 + 用户名密码双模式 | 与网页端一致 |
| Tab | 4 个（记账 / 分析 / 目标 / 我的） | 汇率放记账页顶部 |
| OCR | `wx.chooseImage` → 后端智谱识别 | 原生拍照体验 |

## 2. 架构总览

```
┌────────── Smart Finance 微信小程序 ──────────┐
│                                               │
│  App.js ── token check ── 无 → login page     │
│  │                         有 → tabBar         │
│  │                                             │
│  ├─ Tab 1: 💬 记账    pages/chat/chat          │
│  │   ├─ 消息列表 + 消息气泡                     │
│  │   ├─ 输入框 + 快捷操作                       │
│  │   ├─ OCR 拍照识别确认卡片                    │
│  │   └─ 汇率入口（点击展开汇率卡片列表）          │
│  │                                             │
│  ├─ Tab 2: 📊 分析    pages/report/report      │
│  │   ├─ 周期切换（近一周/近一月/近一季）          │
│  │   ├─ 收入/支出/结余统计卡片                   │
│  │   ├─ 支出分类饼图（分包 echarts）             │
│  │   └─ 消费趋势折线图（分包 echarts）           │
│  │                                             │
│  ├─ Tab 3: 🎯 目标    pages/goal/goal          │
│  │   ├─ 月度预算进度条                           │
│  │   ├─ 储蓄目标卡片列表                         │
│  │   └─ 创建目标/设置预算弹窗                     │
│  │                                             │
│  └─ Tab 4: 👤 我的    pages/mine/mine          │
│      ├─ 用户信息展示                             │
│      ├─ 意见反馈入口                             │
│      └─ 退出登录                                │
│                                               │
│  分包 subpackages/chart/                       │
│  ├─ ec-canvas/ (echarts-for-weixin 核心)        │
│  └─ pages/blank/ (占位页面，分包入口)            │
│                                               │
│  公共组件 components/                           │
│  ├─ message-bubble/   消息气泡                  │
│  ├─ ocr-confirm/      OCR 确认卡片              │
│  ├─ progress-bar/     进度条                    │
│  └─ empty-state/      空状态                    │
│                                               │
│  工具 utils/                                   │
│  ├─ api.js           API 请求封装（同网页端）     │
│  └─ auth.js          Token 管理                 │
└───────────────────────────────────────────────┘
```

## 3. 文件结构

```
miniprogram/
├── app.js                    # 启动：读取 token，决定跳登录或首页
├── app.json                  # 窗口配置 + tabBar + 分包声明
├── app.wxss                  # 全局样式（CSS 变量复用 Web 端色值）
├── project.config.json       # 小程序项目配置
├── sitemap.json              # 爬虫规则
│
├── pages/
│   ├── login/                # 登录页
│   │   ├── login.wxml        # 手机号授权按钮 + 用户名密码 Tab 切换
│   │   ├── login.wxss
│   │   └── login.js
│   ├── chat/                 # 记账页（首页 Tab 1）
│   │   ├── chat.wxml         # 消息列表 + 输入区域 + OCR 确认 + 汇率入口
│   │   ├── chat.wxss
│   │   └── chat.js
│   ├── report/               # 分析页（Tab 2）
│   │   ├── report.wxml       # 周期切换 + 统计卡片 + 饼图 + 趋势图 + 记录编辑
│   │   ├── report.wxss
│   │   └── report.js
│   ├── goal/                 # 目标页（Tab 3）
│   │   ├── goal.wxml         # 预算进度 + 目标列表 + 弹窗
│   │   ├── goal.wxss
│   │   └── goal.js
│   └── mine/                 # 我的页（Tab 4）
│       ├── mine.wxml         # 用户信息 + 反馈 + 退出
│       ├── mine.wxss
│       └── mine.js
│
├── components/
│   ├── message-bubble/
│   ├── ocr-confirm/
│   ├── progress-bar/
│   └── empty-state/
│
├── subpackages/
│   └── chart/                # echarts 分包
│       ├── ec-canvas/        # echarts-for-weixin 组件
│       └── pages/
│           └── chart-page    # 用于渲染图表的页面
│
├── utils/
│   ├── api.js                # API 请求（同 Web 端 api.js，适配 wx.request）
│   ├── auth.js               # getToken/setToken/clearToken
│   └── logger.js             # 日志（生产关闭 debug）
│
└── images/                   # Tab icon 等静态资源
```

## 4. 页面对照表（Web → 小程序）

| Web 端 | 小程序端 | 差异处理 |
|---|---|---|
| `LoginPage.vue` | `pages/login` | 新增手机号授权按钮；注册合并到登录 Tab |
| `ChatWindow.vue` | `pages/chat` | `file input + capture` → `wx.chooseImage`；汇率卡折叠嵌入 |
| `MessageBubble.vue` | `components/message-bubble` | `v-html` → `rich-text` 组件 |
| OCR 确认表单 | `components/ocr-confirm` | 输入控件用 `input` / `picker` |
| `ReportPanel.vue` | `pages/report` | echarts 组件用 `ec-canvas`，通过分包页面渲染 |
| `GoalTracker.vue` | `pages/goal` | 弹窗用 `wx.showModal` 或自定义 `<cover-view>` |
| `ExchangePanel.vue` | `pages/chat` 汇率子区域 | 精简为卡片点击展开/折叠，去掉货币详情弹窗 |
| `Sidebar.vue` | `app.json tabBar` | 原生底部 TabBar 替代侧边栏 |
| `FeedbackModal.vue` | `pages/mine` 反馈功能 | `wx.chooseMessageFile` 代替文件上传截图 |
| `LoginPage.vue` 微信入口 | 不需要 | 小程序本身就是微信环境 |
| 提醒面板 | `pages/chat` 顶部铃铛 | `wx.showToast` + 红点 badge |

## 5. 登录流程

```
用户打开小程序
  ↓
App.onLaunch → 检查 storage 是否有 token
  ├─ 有 token → 调用 /api/auth/me 验证
  │   ├─ 有效 → 进入 TabBar 首页
  │   └─ 过期 → 跳转 login 页
  └─ 无 token → 跳转 login 页
       ↓
  login 页面两个入口：
   ① 手机号一键授权：
      wx.login() → 拿 code
      用户点击 <button open-type="getPhoneNumber">
      → 拿 encryptedData + iv
      → POST /api/auth/wechat-phone { code, encryptedData, iv }
      → 得到 JWT → 保存 → 进入首页
   ② 用户名密码登录（Tab 切换）：
      输入用户名 + 密码
      → POST /api/auth/login → JWT → 进入首页
      或 POST /api/auth/register → JWT → 进入首页
```

## 6. API 调用

小程序用 `wx.request` 封装，接口签名保持与 Web 端 `api.js` 完全一致。差异：

| 操作 | Web 端 | 小程序端 |
|---|---|---|
| Network | `fetch()` | `wx.request` |
| Token 存储 | `localStorage` | `wx.setStorageSync` |
| Device ID | `localStorage` uuid | `wx.getStorageSync` uuid |
| 文件下载 | `fetch` blob → download | `wx.downloadFile` |
| 拍照 | `<input type='file' capture>` | `wx.chooseImage` + `wx.uploadFile` |
| 截图上传 | `<input type='file'>` | `wx.chooseMessageFile` |

## 7. app.json 配置

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
  "tabBar": {
    "list": [
      { "pagePath": "pages/chat/chat",   "text": "记账", "iconPath": "images/chat.png",   "selectedIconPath": "images/chat-active.png" },
      { "pagePath": "pages/report/report", "text": "分析", "iconPath": "images/report.png", "selectedIconPath": "images/report-active.png" },
      { "pagePath": "pages/goal/goal",   "text": "目标", "iconPath": "images/goal.png",   "selectedIconPath": "images/goal-active.png" },
      { "pagePath": "pages/mine/mine",   "text": "我的", "iconPath": "images/mine.png",   "selectedIconPath": "images/mine-active.png" }
    ]
  },
  "window": {
    "navigationBarTitleText": "智能记账",
    "navigationBarBackgroundColor": "#4f46e5",
    "navigationBarTextStyle": "white"
  },
  "preloadRule": {
    "pages/report/report": {
      "network": "all",
      "packages": ["subpackages/chart"]
    }
  }
}
```

## 8. 后端新增接口

### POST /api/auth/wechat-phone

```json
// Request
{
  "code": "wx.login() 返回的 code",
  "encryptedData": "<button open-type='getPhoneNumber'> 回调的 encryptedData",
  "iv": "回调的 iv"
}

// Response (success)
{
  "success": true,
  "data": { "token": "jwt...", "userId": 1 }
}

// Response (error)
{
  "success": false,
  "error": "手机号解密失败"  // 不暴露具体原因给客户端
}
```

**后端逻辑**：
1. 用 code 调微信 API 获取 session_key
2. 用 session_key + iv 解密 encryptedData 得到手机号
3. 按手机号查找用户 → 有则登录，无则创建（用户名 = 脱敏手机号）
4. 创建默认账本、迁移游客记录
5. 返回 JWT

## 9. 图表分包方案

echarts-for-weixin 核心组件 `ec-canvas` 约 700KB，放在分包。report 页通过 `usingComponents` 直接引用分包组件即可（`<ec-canvas>`），分包懒加载不影响主包体积。

```
subpackages/chart/
├── ec-canvas/
│   ├── ec-canvas.js
│   ├── ec-canvas.json
│   ├── ec-canvas.wxml
│   ├── ec-canvas.wxss
│   └── echarts.js        # echarts 核心
└── pages/
    └── blank/             # 占位页面（分包必须有至少一个 page 入口）
        ├── blank.wxml
        ├── blank.wxss
        └── blank.js
```

report 页 `report.json` 中声明：
```json
{
  "usingComponents": {
    "ec-canvas": "/subpackages/chart/ec-canvas/ec-canvas"
  }
}
```

## 10. 样式规范

复用 Web 端 CSS 变量：

```css
--primary: #4f46e5;
--primary-dark: #3730a3;
--success: #10b981;
--warning: #f59e0b;
--danger: #ef4444;
--bg: #f8fafc;
--bg-card: #ffffff;
--text: #1e293b;
--text-secondary: #64748b;
--border: #e2e8f0;
--radius: 12px;
```

字体：`-apple-system, 'PingFang SC', 'Microsoft YaHei'`（微信默认已有这些字体）

## 11. 内存 & 体积预算

| 项目 | 大小 |
|---|---|
| 主包（4 页 + 组件 + 工具） | ~300 KB |
| echarts 分包 | ~750 KB |
| 图片资源 | ~20 KB |
| **主包合计** | **~320 KB** |
| **总提交大小** | **~1,070 KB** |
| 主包限额 | 2 MB ✅ |
| 总分包限额 | 20 MB ✅ |

## 12. 开发阶段

| 阶段 | 内容 | 验证 |
|---|---|---|
| Phase 1 | 项目脚手架 + app 配置 + tabBar + 登录页 | 微信开发者工具能跑通登录 |
| Phase 2 | 记账页（消息列表、发送消息、OCR 拍照确认） | 能和后端聊天记账 |
| Phase 3 | 分析页（统计卡片 + echarts 饼图 + 趋势折线图） | 图表正确渲染 |
| Phase 4 | 目标页（预算进度 + 目标 CRUD） | 目标增删改正常 |
| Phase 5 | 我的页（反馈 + 退出 + 汇率入口） | 反馈提交成功 |
| Phase 6 | 后端新增 wechat-phone 接口 + 测试 | 手机号登录成功 |

## 13. Open Questions（待确认）

1. **echarts-for-weixin 版本**：当前最新是 `v1.0.5`，依赖 echarts `v5.x`。确认用这个版本。
2. **汇率页是否还要保留货币详情弹窗**：小程序端汇率只做卡片列表 + 点击展开趋势迷你图，不弹大窗口。
3. **提醒功能**：小程序端用 `wx.showToast` + 红点 badge 做提醒，不复用 Web 端下拉面板。
