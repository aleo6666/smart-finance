# Smart Finance V3 第一阶段实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 Node/Express 后端迁移到 MySQL + Redis + Qdrant，并跑通自然语言记账 Agent 闭环。

**Architecture:** 后端新增 Knex/MySQL 数据层，SQLite 只作为一次性迁移源。`/api/chat` 保持前端响应兼容，但记账写入改为 Planner/Recorder Agent 流程，Redis 保存任务状态，Qdrant 保存记录向量，Monitor/Observe 提供第一版可验证能力。

**Tech Stack:** Node.js 22, Express 4, Knex, MySQL 8, ioredis, Qdrant, Vue 3, Docker Compose, Node test runner.

---

## 文件结构

- 修改：`server/package.json`，增加测试脚本、迁移脚本、MySQL/Redis/Qdrant 依赖。
- 修改：`server/.env.example`，补齐 V3 第一阶段环境变量。
- 修改：`docker-compose.yml`，新增 MySQL、Redis、Qdrant，并让 backend 依赖它们。
- 创建：`server/src/config.js`，集中读取环境变量。
- 创建：`server/src/db-mysql.js`，Knex MySQL 连接。
- 修改：`server/src/db.js`，导出 MySQL 数据层，移除运行时 SQLite 主库职责。
- 创建：`server/src/schema.js`，创建 MySQL schema。
- 创建：`server/src/scripts/migrate-sqlite-to-mysql.js`，从 SQLite 迁移到 MySQL。
- 创建：`server/src/redis.js`，Redis 客户端和降级包装。
- 创建：`server/src/services/agentQueue.js`，Redis Streams 队列和状态。
- 创建：`server/src/services/plannerAgent.js`，把 NLU 结果转成 Agent 任务。
- 创建：`server/src/services/recorderAgent.js`，执行自然语言记账任务。
- 创建：`server/src/services/monitorAgent.js`，预算阈值检查。
- 创建：`server/src/services/vectorMemory.js`，Qdrant 写入和本地 embedding 降级。
- 创建：`server/src/services/observeService.js`，第一版调用/任务统计。
- 创建：`server/src/routes/observe.js`，`GET /api/observe/stats`。
- 修改：`server/src/index.js`，初始化 schema、Qdrant、Agent consumer、observe 路由。
- 修改：`server/src/routes/chat.js`，自然语言记账走 Planner/Recorder。
- 修改：`server/src/routes/auth.js`，迁移到 async MySQL。
- 修改：`server/src/routes/records.js`，迁移列表/新增/编辑/删除/import 到 MySQL；OCR 保持兼容但写 MySQL。
- 修改：`server/src/routes/ledgers.js`，迁移到 async MySQL。
- 修改：`server/src/routes/reminders.js`，迁移到 async MySQL。
- 修改：`server/src/routes/goals.js`、`server/src/routes/reports.js`，让当前前端可用路径迁到 MySQL。
- 创建：`server/test/*.test.js`，覆盖 config、schema、migration、agent/vector/monitor 单元行为。

## Task 1：测试底座与配置层

**Files:**
- Modify: `server/package.json`
- Create: `server/src/config.js`
- Create: `server/test/config.test.js`

- [ ] **Step 1: 写失败测试**

创建 `server/test/config.test.js`：

```javascript
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

test('loadConfig returns MySQL Redis and vector defaults', () => {
  const config = loadConfig({})
  assert.equal(config.db.host, 'localhost')
  assert.equal(config.db.port, 3306)
  assert.equal(config.redis.host, 'localhost')
  assert.equal(config.redis.port, 6379)
  assert.equal(config.vector.url, 'http://localhost:6333')
  assert.equal(config.vector.collection, 'finance_records')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npm test -- test/config.test.js`

Expected: FAIL，提示找不到 `../src/config.js` 或 `loadConfig`。

- [ ] **Step 3: 增加测试脚本与配置实现**

`server/package.json` 增加：

```json
"test": "node --test"
```

创建 `server/src/config.js`，导出 `loadConfig(env = process.env)`，返回 `db`、`redis`、`vector`、`ai`、`server` 配置，数值端口使用 `Number()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server; npm test -- test/config.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add server/package.json server/test/config.test.js server/src/config.js && git commit -m "test: add phase 1 config harness"`

## Task 2：MySQL schema 与 SQLite 迁移

**Files:**
- Modify: `server/package.json`
- Create: `server/src/db-mysql.js`
- Modify: `server/src/db.js`
- Create: `server/src/schema.js`
- Create: `server/src/scripts/migrate-sqlite-to-mysql.js`
- Create: `server/test/schema.test.js`
- Create: `server/test/migration.test.js`

- [ ] **Step 1: 写 schema 失败测试**

创建 `server/test/schema.test.js`，测试 `getCreateTableStatements()` 至少包含 `records`、`agent_tasks`、`llm_calls`：

```javascript
import test from 'node:test'
import assert from 'node:assert/strict'
import { getCreateTableStatements } from '../src/schema.js'

test('schema contains core and phase 1 tables', () => {
  const sql = getCreateTableStatements().join('\n')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS users/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS records/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_tasks/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS llm_calls/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cost_alert_rules/)
})
```

- [ ] **Step 2: 写迁移映射失败测试**

创建 `server/test/migration.test.js`，测试 SQLite row 到 MySQL row 的字段映射：

```javascript
import test from 'node:test'
import assert from 'node:assert/strict'
import { mapRecordRow } from '../src/scripts/migrate-sqlite-to-mysql.js'

test('mapRecordRow keeps record ids and fills amount_cny', () => {
  const row = { id: 7, device_id: 'dev', user_id: 2, amount: 12.5, amount_cny: null, currency: null, category: 'food', type: 'expense', date: '2026-07-17' }
  const mapped = mapRecordRow(row)
  assert.equal(mapped.id, 7)
  assert.equal(mapped.amount_cny, 12.5)
  assert.equal(mapped.currency, 'CNY')
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd server; npm test -- test/schema.test.js test/migration.test.js`

Expected: FAIL，提示模块不存在。

- [ ] **Step 4: 安装依赖并实现**

Run: `cd server; npm install knex mysql2 ioredis @qdrant/js`

实现：

- `db-mysql.js`：创建 Knex 连接，导出默认 `db`、`closeDb()`。
- `db.js`：改为 re-export MySQL `db`，保留默认导出。
- `schema.js`：导出 `getCreateTableStatements()` 与 `ensureSchema(db)`。
- `migrate-sqlite-to-mysql.js`：导出 `mapRecordRow(row)`、`migrateSqliteToMysql({ sqlitePath, mysqlDb })`，CLI 模式读取 `server/finance.db`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server; npm test -- test/schema.test.js test/migration.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

Run: `git add server/package.json server/package-lock.json server/src/db.js server/src/db-mysql.js server/src/schema.js server/src/scripts/migrate-sqlite-to-mysql.js server/test/schema.test.js server/test/migration.test.js && git commit -m "feat: add mysql schema and sqlite migration"`

## Task 3：Redis、Qdrant、Agent 与 Monitor 服务

**Files:**
- Create: `server/src/redis.js`
- Create: `server/src/services/agentQueue.js`
- Create: `server/src/services/plannerAgent.js`
- Create: `server/src/services/recorderAgent.js`
- Create: `server/src/services/monitorAgent.js`
- Create: `server/src/services/vectorMemory.js`
- Create: `server/src/services/observeService.js`
- Create: `server/test/vectorMemory.test.js`
- Create: `server/test/agentFlow.test.js`
- Create: `server/test/monitorAgent.test.js`

- [ ] **Step 1: 写 vector 失败测试**

测试缺少 OpenAI Key 时 deterministic vector 长度固定、同文同向量。

- [ ] **Step 2: 写 agent 失败测试**

用假的 `db`、`queue`、`vectorMemory` 注入 `recordFromPlannerTask()`，验证成功返回 `recordId` 并调用 vector upsert。

- [ ] **Step 3: 写 monitor 失败测试**

用假的 `db` 注入 `checkBudgetAfterRecord()`，验证 80% 阈值会插入 reminder。

- [ ] **Step 4: 跑测试确认失败**

Run: `cd server; npm test -- test/vectorMemory.test.js test/agentFlow.test.js test/monitorAgent.test.js`

Expected: FAIL，提示模块不存在。

- [ ] **Step 5: 实现最小服务**

实现重点：

- Redis 不可用时记录 warn，但本地测试可以用内存 fallback 状态。
- `agentQueue` 导出 `enqueueTask()`、`waitForTaskResult()`、`markTaskStatus()`。
- `plannerAgent` 导出 `createRecordTaskFromNlu()`。
- `recorderAgent` 导出 `recordFromPlannerTask()`。
- `monitorAgent` 导出 `checkBudgetAfterRecord()`。
- `vectorMemory` 导出 `createDeterministicEmbedding()`、`embedRecord()`、`initVectorCollection()`。
- `observeService` 导出 `recordLlmCall()`、`getObserveStats()`。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd server; npm test -- test/vectorMemory.test.js test/agentFlow.test.js test/monitorAgent.test.js`

Expected: PASS。

- [ ] **Step 7: 提交**

Run: `git add server/src/redis.js server/src/services/agentQueue.js server/src/services/plannerAgent.js server/src/services/recorderAgent.js server/src/services/monitorAgent.js server/src/services/vectorMemory.js server/src/services/observeService.js server/test/vectorMemory.test.js server/test/agentFlow.test.js server/test/monitorAgent.test.js && git commit -m "feat: add phase 1 agent services"`

## Task 4：路由迁移与自然语言记账闭环

**Files:**
- Modify: `server/src/index.js`
- Modify: `server/src/routes/chat.js`
- Modify: `server/src/routes/auth.js`
- Modify: `server/src/routes/records.js`
- Modify: `server/src/routes/ledgers.js`
- Modify: `server/src/routes/reminders.js`
- Modify: `server/src/routes/goals.js`
- Modify: `server/src/routes/reports.js`
- Create: `server/src/routes/observe.js`
- Create: `server/test/chatRoute.test.js`

- [ ] **Step 1: 写 chat route 失败测试**

用 Express app + 注入式服务测试 `POST /api/chat` 对自然语言记账返回成功，并确认 fake recorder 被调用。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npm test -- test/chatRoute.test.js`

Expected: FAIL，当前 `chat.js` 直接写旧数据库，不支持注入。

- [ ] **Step 3: 改造路由**

将需要数据库访问的路由函数改为 `async`，用 Knex 查询替换 `db.prepare()`。

`chat.js` 行为要求：

- 调用 `processMessage(identity, message)`。
- 当 `result.intent === 'record'` 且有 `amount` 时创建 Planner task。
- 调用 Recorder 写入 MySQL。
- 返回 `{ success: true, data: result }`，保持前端兼容。

- [ ] **Step 4: 注册 observe 路由与启动初始化**

`index.js` 启动时：

- `await ensureSchema(db)`。
- `await initVectorCollection()`，失败只 warn。
- 注册 `/api/observe`。
- 启动 Agent consumer 或初始化队列。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server; npm test -- test/chatRoute.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

Run: `git add server/src/index.js server/src/routes/*.js server/test/chatRoute.test.js && git commit -m "feat: route chat through phase 1 agents"`

## Task 5：Docker Compose 与环境变量

**Files:**
- Modify: `docker-compose.yml`
- Modify: `server/.env.example`
- Modify: `server/Dockerfile` if needed

- [ ] **Step 1: 更新 `.env.example`**

加入 MySQL、Redis、Qdrant、OpenAI、Zhipu、Anthropic 配置，保持无真实密钥。

- [ ] **Step 2: 更新 `docker-compose.yml`**

加入 `mysql`、`redis`、`qdrant` 服务，backend 注入对应环境变量，并等待 MySQL/Redis 健康。

- [ ] **Step 3: 配置迁移命令**

`server/package.json` 增加：

```json
"migrate:sqlite": "node src/scripts/migrate-sqlite-to-mysql.js"
```

- [ ] **Step 4: 验证 compose 配置**

Run: `docker compose config`

Expected: 输出有效配置，exit code 0。

- [ ] **Step 5: 提交**

Run: `git add docker-compose.yml server/.env.example server/package.json server/package-lock.json server/Dockerfile && git commit -m "chore: add phase 1 docker services"`

## Task 6：端到端验证与收尾

**Files:**
- Modify: `README.md` if needed for Phase 1 run notes.

- [ ] **Step 1: 跑单元测试**

Run: `cd server; npm test`

Expected: PASS。

- [ ] **Step 2: 跑前端构建**

Run: `cd client; npm run build`

Expected: PASS。

- [ ] **Step 3: 启动 Docker**

Run: `docker compose up -d --build`

Expected: MySQL、Redis、Qdrant、backend、frontend 均 healthy 或 running。

- [ ] **Step 4: 执行 SQLite 到 MySQL 迁移**

Run: `docker compose exec backend npm run migrate:sqlite`

Expected: 输出每张表 copied/upserted 数量。

- [ ] **Step 5: 验证自然语言记账闭环**

Run:

```powershell
$login = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/mock-login -ContentType 'application/json' -Body '{}'
$token = $login.data.token
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/chat -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body '{"message":"今天午饭花了25元"}'
Invoke-RestMethod -Method Get -Uri http://localhost:3000/api/observe/stats -Headers @{ Authorization = "Bearer $token" }
```

Expected: chat 成功，records 新增，observe stats 有活动数据。

- [ ] **Step 6: 查看 Redis/Qdrant 证据**

Run:

```powershell
docker compose exec redis redis-cli KEYS '*agent*'
Invoke-RestMethod -Method Get -Uri http://localhost:6333/collections/finance_records
```

Expected: Redis 有任务/状态 key，Qdrant collection 存在。

- [ ] **Step 7: 提交验证文档或 README 更新**

Run: `git add README.md && git commit -m "docs: document v3 phase 1 verification"` only if README changed.

---

## 自审结果

- 设计文档中的第一阶段要求均有任务覆盖。
- OCR、人机审核、完整观测面板、微信确认没有被纳入实现任务。
- 所有生产代码任务都先写测试并确认失败。
- 计划默认内联执行，不使用子代理；当前 Codex 模式不允许主动派发子代理，且仓库存在大量未跟踪文件，当前工作区更能保留真实项目状态。
