# 智能财务 V3 第 9 阶段：微信小程序登录、订阅消息与提醒确认设计

## 1. 背景与目标

当前项目已经具备 JWT 登录、站内提醒、预算预警、MySQL、Redis 和 Docker 基础设施，也存在初步的微信接口代码，但还没有原生小程序客户端、可靠的订阅消息消费记录和预算提醒确认闭环。

本阶段交付以下能力：

1. 新增最小原生微信小程序，通过 `wx.login` 完成真实小程序登录。
2. 用户主动授权一次性订阅消息，后端安全登记授权状态。
3. 预算超支提醒同时生成站内提醒和待确认任务。
4. 后端按已确认模板发送微信订阅消息。
5. 用户点击消息进入小程序确认页，选择“确认处理”或“忽略提醒”。
6. 开发环境支持 `mock/live` 两种发送模式，在没有 HTTPS 合法域名时仍可完成自动化测试和微信开发者工具联调。

## 2. 范围

### 2.1 本阶段包含

- 微信小程序 `jscode2session` 登录。
- 原生小程序登录页、首页、提醒列表和确认页。
- 一次性订阅授权登记与消费。
- 预算超支提醒的微信推送。
- 提醒确认、忽略、所有权校验和幂等处理。
- Redis access_token 缓存。
- 微信发送 mock/live 模式。
- Docker 和微信开发者工具联调配置。

### 2.2 本阶段不包含

- 微信公众号网页 OAuth。
- 每日记账提醒、月报定时推送和其他定时任务。
- 公网 HTTPS、request 合法域名和正式发布。
- Vue Web 端重构或小程序与 Web 的视觉统一改造。
- 多模板管理后台。

公网域名、TLS、真机发布和生产运维归入第 10 阶段。

## 3. 已确认的微信模板

模板标题为“预算超支通知”，字段映射如下：

| 字段 | 含义 | 示例 |
|---|---|---|
| `thing1` | 预算类型 | 餐饮月度预算 |
| `amount2` | 超预算金额 | 100.00 |
| `time3` | 时间 | 2026-07-18 09:57 |
| `thing4` | 备注 | 点击查看并确认处理 |

模板 ID 只通过 `WECHAT_SUBSCRIBE_TEMPLATE_ID` 注入，不在代码或文档中保存真实值。

订阅消息本身不承载双按钮。消息点击后跳转到：

```text
pages/reminders/confirm/index?id=<reminderId>
```

“确认处理”和“忽略提醒”按钮位于小程序确认页。

## 4. 总体架构

### 4.1 小程序客户端

新增 `miniprogram/` 原生小程序工程：

- `pages/login`：调用 `wx.login`，换取系统 JWT。
- `pages/index`：显示登录状态、订阅入口和待确认提醒数。
- `pages/reminders/index`：显示当前用户的待确认提醒。
- `pages/reminders/confirm`：显示提醒详情并执行确认或忽略。
- `utils/request`：统一 API 地址、JWT 请求头、401 清理和错误展示。
- `utils/auth`：JWT 本地保存和登录状态恢复。

小程序只保存 JWT，不保存 AppSecret、access_token 或 openid。

### 4.2 后端组件

#### `wechatClient`

职责：

- 使用小程序 AppID/AppSecret 调用 `jscode2session`。
- 获取全局 access_token。
- 使用 Redis 缓存 access_token，TTL 为微信返回有效期减 300 秒。
- 发送订阅消息。
- token 失效时刷新并重试一次。

该组件接受 `fetch`、Redis 和配置注入，便于不访问真实微信的单元测试。

#### `wechatNotifier`

职责：

- 在 `mock` 与 `live` 模式之间切换。
- 读取用户的订阅授权和 `mini_openid`。
- 把提醒数据映射为 `thing1/amount2/time3/thing4`。
- 防止同一提醒重复发送。
- 记录发送、跳过和失败结果。
- 仅在成功发送后消费一次性订阅授权。

#### HTTP 路由

- `auth` 路由负责 code 校验、用户创建/复用和 JWT 签发。
- `reminders` 路由负责订阅登记、列表、详情和确认动作。
- 路由不直接拼接微信请求，不接受客户端传入的 openid。

## 5. 数据模型

### 5.1 `wechat_subscribe`

继续使用现有表，每个用户和模板一条记录：

- `authorized`：用户刚授权，可发送一次。
- `consumed`：消息已成功发送。
- `rejected`：用户拒绝或关闭授权。

再次获得 `accept` 时更新为 `authorized`，覆盖上一次消费状态。

### 5.2 `reminder_confirmations`

新增表：

| 字段 | 类型/约束 | 用途 |
|---|---|---|
| `id` | BIGINT 主键 | 确认记录 ID |
| `reminder_id` | BIGINT，唯一 | 对应站内提醒 |
| `user_id` | BIGINT，索引 | 用户隔离 |
| `status` | VARCHAR | `pending/confirmed/ignored` |
| `payload_json` | JSON | 预算类型、超预算金额、时间、备注 |
| `created_at` | DATETIME | 创建时间 |
| `action_at` | DATETIME，可空 | 处理时间 |

### 5.3 `wechat_deliveries`

新增表：

| 字段 | 类型/约束 | 用途 |
|---|---|---|
| `id` | BIGINT 主键 | 发送记录 ID |
| `reminder_id` | BIGINT，唯一 | 保证同一提醒不重复发送 |
| `user_id` | BIGINT，索引 | 用户隔离 |
| `template_id` | VARCHAR | 使用的模板 |
| `status` | VARCHAR | `mock_sent/sent/skipped/failed` |
| `response_json` | JSON，可空 | 脱敏后的微信返回信息 |
| `created_at` | DATETIME | 创建时间 |
| `sent_at` | DATETIME，可空 | 成功时间 |

本阶段通过新增表完成增量升级，不修改已有 `reminders` 表结构，避免现有 Docker 数据库只能重建才能生效。

## 6. 核心流程

### 6.1 小程序登录

1. 小程序调用 `wx.login` 获取临时 code。
2. 小程序 POST `/api/auth/wechat-mini`，只提交 code。
3. 后端调用 `jscode2session`。
4. 后端按 `mini_openid` 查找用户；不存在则创建用户和默认账本。
5. 后端更新 `last_login_at` 并返回系统 JWT。
6. 小程序保存 JWT，并调用 `/api/auth/me` 恢复用户状态。

### 6.2 订阅授权

1. 用户主动点击“订阅预算提醒”。
2. 小程序调用 `wx.requestSubscribeMessage`，传入环境配置的模板 ID。
3. 返回 `accept` 时，小程序 POST `/api/reminders/subscribe`。
4. 后端从 JWT 获取用户 ID，并从 `users.mini_openid` 获取 openid。
5. 后端 upsert `wechat_subscribe` 为 `authorized`。
6. `reject/ban` 只在客户端提示，不伪造服务端授权。

### 6.3 预算提醒与推送

1. 预算监控发现支出达到预警或超支阈值。
2. 写入现有 `reminders` 站内提醒。
3. 写入 `reminder_confirmations.pending`。
4. 调用 `wechatNotifier`。
5. 无授权、已消费或无 openid 时写入 `wechat_deliveries.skipped`。
6. mock 模式写入 `mock_sent`，不调用微信。
7. live 模式调用微信订阅消息接口；成功后写入 `sent` 并把授权更新为 `consumed`。
8. 微信失败写入 `failed`，站内提醒和确认任务仍然保留。

### 6.4 确认与忽略

1. 用户从消息或提醒列表进入确认页。
2. GET 提醒详情时同时按 `reminder_id + user_id` 查询。
3. 用户提交 `confirmed` 或 `ignored`。
4. 第一次提交更新状态、`action_at` 和站内提醒已读状态。
5. 重复提交返回当前结果，不重复执行。
6. 其他用户访问统一返回 404。

## 7. API 设计

### `POST /api/auth/wechat-mini`

请求：

```json
{ "code": "wx.login 返回的临时 code" }
```

成功：

```json
{ "success": true, "data": { "token": "JWT", "userId": 1 } }
```

### `POST /api/reminders/subscribe`

请求体不包含 openid：

```json
{ "result": "accept" }
```

后端固定使用 `WECHAT_SUBSCRIBE_TEMPLATE_ID`。

### `GET /api/reminders/confirmations`

返回当前用户的 `pending` 确认列表。

### `GET /api/reminders/confirmations/:reminderId`

返回当前用户的一条确认详情。

### `POST /api/reminders/confirmations/:reminderId/action`

请求：

```json
{ "action": "confirmed" }
```

`action` 仅允许 `confirmed` 或 `ignored`。

## 8. 错误处理与安全

- AppSecret 只存在于后端本地 `.env`，不写入 Git、小程序或日志。
- `.env.example` 只包含占位符。
- code 缺失返回 400；微信 code 无效返回明确登录失败。
- 微信网络或服务错误返回通用 502，不回传包含敏感信息的原始错误。
- live 模式缺少 AppID、AppSecret 或模板 ID 时启动失败。
- access_token Redis key 包含 AppID，但不包含 AppSecret。
- access_token 失效只允许刷新重试一次。
- 订阅接口不接受 openid，避免给其他用户登记授权。
- 提醒 ID 必须是正安全整数。
- 所有确认查询必须同时包含用户 ID。
- 发送结果中的 access_token、session_key 和 openid 不写入数据库。
- 微信失败不回滚站内提醒。

## 9. 本地配置

本地 `.env` 使用以下变量：

```dotenv
WECHAT_MINI_APPID=<local-only>
WECHAT_MINI_SECRET=<local-only>
WECHAT_SUBSCRIBE_TEMPLATE_ID=<local-only>
WECHAT_SEND_MODE=mock
```

Docker Compose 把这些变量传给 backend。自动化测试和默认冒烟使用 `mock`；人工联调时临时改为 `live`。

小程序本机私有配置：

- 使用真实 AppID。
- 开启开发阶段“不校验合法域名”。
- API 基址为 `http://127.0.0.1:3000`。
- 私有配置加入 `.gitignore`。

第 10 阶段再改为 HTTPS API 域名并启用域名校验。

## 10. 测试与验收

### 10.1 后端自动化测试

- `jscode2session` 成功、无效 code、网络失败和错误脱敏。
- Redis access_token 命中、过期刷新和失效后单次重试。
- 模板字段映射和页面跳转参数。
- mock/live 模式。
- 无授权跳过、成功消费、失败保留授权和重复发送拦截。
- 订阅接口不接受伪造 openid。
- 确认列表、详情、确认、忽略、越权和幂等。
- 两张新增表的 schema 断言。

### 10.2 小程序验证

- API 请求自动附带 JWT。
- 401 时清理本地 JWT 并返回登录页。
- `wx.login` 成功进入首页。
- 只有 `accept` 才登记订阅。
- 消息页面参数能打开正确提醒。
- 确认和忽略后页面显示最终状态并禁止重复操作。

### 10.3 集成验收

1. 后端全量测试通过。
2. Vue Web 生产构建通过。
3. Docker mock 闭环通过。
4. 微信开发者工具能导入、编译和打开小程序。
5. 真实 AppID 下 `wx.login` 能换取系统 JWT。
6. 用户主动订阅后，live 模式发送一条测试预算提醒。
7. 点击微信消息进入确认页，并成功确认或忽略。

## 11. 成功标准

- 小程序登录不依赖 mock 用户。
- 客户端无法伪造 openid 或越权处理提醒。
- 每次订阅授权最多消费一次。
- 同一提醒不会重复推送。
- 微信失败不会造成站内提醒丢失。
- 自动测试不访问或消耗真实微信接口。
- 没有 HTTPS 域名时，开发者工具内仍能完成本阶段联调。
