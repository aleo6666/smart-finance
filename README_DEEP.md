# Smart Finance · AI-Native 智能记账 Agent

> 基于 LangGraph 的智能个人财务助手——从自然语言理解到多 Agent 协同，
> 从四层记忆到三级安全防线，从本地开发到 Docker 灰度部署的全链路实现。

[![部署状态](https://img.shields.io/badge/status-online-brightgreen)](http://8.163.84.206)
[![Node.js](https://img.shields.io/badge/node-22+-339933)](https://nodejs.org)
[![LangGraph](https://img.shields.io/badge/LangGraph-1.x-blue)](https://github.com/langchain-ai/langgraphjs)
[![测试](https://img.shields.io/badge/tests-609%2F610-brightgreen)](#)
[![许可证](https://img.shields.io/badge/license-Unlicensed-red)](#许可证)

线上地址：http://8.163.84.206（Docker Compose · 阿里云 ECS）

---

## 目录

1. [设计哲学](#1-设计哲学)
2. [Agent 架构深度解析](#2-agent-架构深度解析)
3. [四层记忆系统](#3-四层记忆系统)
4. [工具系统与安全防线](#4-工具系统与安全防线)
5. [灰度架构与 Feature Flag](#5-灰度架构与-feature-flag)
6. [技术栈](#6-技术栈)
7. [项目结构](#7-项目结构)
8. [本地开发与部署](#8-本地开发与部署)

---

## 1. 设计哲学

### 核心原则

```
用户输入 → 意图识别 → 工具调用 → 结果汇总 → 自然语言输出
                ↑                        ↓
                └──── 四层记忆上下文注入 ────┘
```

- **Agent-First**：所有用户交互都经过 Agent 决策层，而非硬编码路由
- **Memory-Native**：记忆不是事后附加，而是图节点的核心输入和输出
- **Defense-in-Depth**：三层安全防线——SQL AST 守卫 + 工具白名单 + 敏感操作确认
- **Graceful Degradation**：Feature Flag 控制全部可选能力，任何组件失效都有降级路径
- **Trusted Runtime Context**：`userId`/`sessionId` 等可信字段只来自服务端，模型不可伪造

### 为什么选 LangGraph StateGraph

| 方案 | 问题 |
|------|------|
| 简单 LLM Wrapper | 无状态管理，多轮对话丢失上下文 |
| Chain（LangChain） | 线性流程，无法条件分支 |
| AgentExecutor | 黑盒循环，无法插入安全检查节点 |
| **LangGraph StateGraph** ✅ | 显式状态、自定义节点、条件路由、interrupt 人机交互 |

---

## 2. Agent 架构深度解析

### 2.1 图结构（StateGraph Nodes）

```
                         ┌──────────────┐
                         │    START     │
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │ loadMemory   │ ← 注入四层记忆
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │ normalize    │ ← 请求标准化 + 意图识别
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │ compose      │ ← System Prompt + 记忆 + 工具列表
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │ model        │ ← LLM 推理 (DeepSeek v4)
                         └──────┬───────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
              ┌─────▼─────┐          ┌──────▼──────┐
              │ validate   │          │   no_tool   │
              │ tool_call  │          │   → END     │
              └─────┬─────┘          └─────────────┘
                    │
           ┌────────┴────────┐
           │                 │
    ┌──────▼──────┐   ┌──────▼──────┐
    │ risk_check  │   │  tool_node  │ ← 普通查询工具
    │ (写操作)    │   │  (只读)     │
    └──────┬──────┘   └──────┬──────┘
           │                 │
    ┌──────▼──────┐          │
    │ confirm?    │          │
    │ (interrupt) │          │
    └──────┬──────┘          │
           │                 │
    ┌──────▼──────┐          │
    │ tool_node   │          │
    │ (执行写)    │          │
    └──────┬──────┘          │
           │                 │
           └────────┬────────┘
                    │
              ┌─────▼──────┐
              │ post_turn  │ ← 记忆更新 + 摘要生成
              └─────┬──────┘
                    │
              ┌─────▼──────┐
              │   END      │
              └────────────┘
```

### 2.2 State 设计

AgentState 是图的核心数据契约，所有节点读写同一个 Schema：

```typescript
// server/src/agent/state.js
export const AgentState = new StateSchema({
  messages: MessagesValue,              // LangGraph 消息数组
  userId: z.number().int().positive(),  // 可信上下文
  sessionId: z.string().min(1).max(128),
  sessionMetadata: objectMap(),         // L1: 会话元数据
  userMemory: objectArray(),            // L2: 用户长期记忆
  recentSummary: objectMap(),           // L3: 近期摘要
  datasetRefs: objectArray(),           // 查询结果数据集引用
  pendingConfirmation: objectMap().nullable(),  // 待确认操作
  toolCallCount: z.number(),            // 工具调用计数（防止死循环）
  errors: objectArray(),                // 错误收集
  response: objectMap().nullable(),     // 最终响应
  isAdmin: z.boolean(),                 // 权限标记
  intentType: IntentTypeSchema          // 意图类型
})
```

### 2.3 路由逻辑

模型输出后根据 `tool_calls` 动态路由：

```typescript
function routeAfterModel(state) {
  const calls = toolCallsFromLastMessage(state)
  if (calls.length === 0) return 'no_tool'   // → END

  const hasWrite = calls.some(c => WRITE_TOOLS.has(c.name))
  if (hasWrite) return 'risk_check'           // → 安全确认

  return 'validate_tool_call'                 // → 参数校验 → 执行
}
```

### 2.4 确定性领域编排（检索/计算分离）

LangGraph 内的确定性计算层——LLM 只做意图理解与参数提取，检索与计算由纯函数工具/子图完成：

```
用户提问
   ↓
┌──────────────────────────┐
│ call_model               │ ← LLM 决策：意图理解 / 工具选择
└────────────┬─────────────┘
             ↓ 并行执行
┌────────────────┐  ┌───────────────────────┐
│ 检索 (domain)   │  │ 计算 (calculate)       │
│ query_transactions│  │ calculate_finance_   │
│ check_budget    │  │ metrics（4 种确定性计算）│
└────────────────┘  └───────────────────────┘
```

| 计算类型 | 说明 |
|----------|------|
| `budget_execution` | 预算执行率 / 超支 |
| `period_comparison` | 环比 / 同比 |
| `category_ratio` | 分类占比 |
| `spending_trend` | 消费趋势 |

**设计原则**：关注点分离保留——检索只读不计算，计算为纯函数无 IO；调度由 LLM 原生路由完成（不再依赖正则规则）。

> 历史：早期版本曾以规则驱动 Master / Retrieval / Calculator 三 Agent 主从并行实现相同能力，已由本节架构取代；`use3Agent` 灰度开关保留用于回退对比，默认走 LangGraph。

---

## 3. 四层记忆系统

```
┌────────────────────────────────────────────────────┐
│ L1: 会话元数据 (sessionMetadata)                    │
│ 设备类型、时区、输入模式、回复风格、最后活跃时间       │
│ 作用域: 单会话 / Redis 存储                         │
├────────────────────────────────────────────────────┤
│ L2: 用户长期记忆 (userMemory)                      │
│ 用户偏好、消费习惯、理财目标、重要日期                │
│ 作用域: 跨会话 / MySQL 持久化 / 支持增删改查          │
├────────────────────────────────────────────────────┤
│ L3: 近期摘要 (recentSummary)                       │
│ 当前话题、未完成任务、分析结论、计划行动              │
│ 作用域: 单会话 / 每个 turn 自动更新                  │
│ 核心字段: currentTopics, recentReferences,          │
│           unfinishedTasks, analysisConclusions       │
├────────────────────────────────────────────────────┤
│ L4: 滑动窗口 (windowMemory)                        │
│ 最近 N 轮对话上下文                                  │
│ 作用域: 单会话 / LangGraph Checkpointer 持久化       │
│ 注入时自动去重，避免与当前消息重复                     │
└────────────────────────────────────────────────────┘
```

### 记忆加载流程

```typescript
// server/src/agent/memory/contextLoader.js
export function createContextLoader({ sessionMetadata, userMemory,
                                      recentSummary, windowMemory }) {
  return async ({ userId, sessionId }) => {
    // 四层并行加载，任一失败不影响其他层
    const [meta, memory, summary, window] = await Promise.allSettled([
      sessionMetadata.read(userId, sessionId),
      userMemory.listActive(userId),
      recentSummary.read(userId, sessionId),
      windowMemory.read(userId, sessionId)
    ])
    // 失败层回退到空值
    return { sessionMetadata: meta, userMemory: memory,
             recentSummary: summary, messages: window }
  }
}
```

### 记忆更新流程

每个 turn 结束后，`postTurnMemory` 节点自动：
1. 更新 L1 元数据（活跃时间、回复风格）
2. 更新 L3 摘要（调用 LLM 生成新的结构化摘要）
3. 更新 L4 窗口（追加新消息，裁剪到窗口大小）
4. L2 长记忆由工具调用显式写入（`confirm_user_memory`）

---

## 4. 工具系统与安全防线

### 4.1 工具清单

| 工具 | 类型 | 安全级别 |
|------|------|----------|
| `query_transactions` | 只读查询 | 安全 |
| `calculate_finance_metrics` | 只读计算 | 安全 |
| `check_budget` | 只读 | 安全 |
| `record_transaction` | 写入 | ⚠️ 需确认 |
| `update_budget` | 写入 | 🔴 敏感写 |
| `confirm_user_memory` | 写入 | 🔴 敏感写 |
| `delete_user_memory` | 写入 | 🔴 敏感写 |
| `update_transaction` | 写入 | 🔴 敏感写 |
| `admin_sql` | 只读管理 | 🔴 SQL AST 守卫 |

### 4.2 三级安全防线

#### Line 1: SQL AST 语法守卫

管理 SQL 工具经过三层校验后才执行：

```typescript
// server/src/agent/security/sqlGuard.js
export function guardAdminSql(sql, { maxRows = 200 }) {
  // 1. 原始文本过滤
  if (FORBIDDEN_TEXT.some(p => p.test(sql))) reject()
  // 分号、注释、sleep、benchmark、into outfile 等直接拒绝

  // 2. AST 解析 + 结构校验
  ast = parser.astify(sql, { database: 'MySQL' })
  validateAndScopeSelect(ast)
  // 只允许 SELECT，禁止子查询、UNION、CTE、窗口函数

  // 3. 表白名单 + 自动注入 user_id 作用域
  //   - 只允许 finance_records_safe / finance_budgets_safe
  //   - 自动追加 WHERE user_id = ? 防止越权
  //   - 函数白名单 (avg/sum/count/max/min/round 等 19 个)

  // 4. LIMIT 强制限制 → max 200 行
  enforceLimit(ast, maxRows)
}
```

#### Line 2: 工具白名单 + 可信字段

工具参数中的 `userId`/`sessionId`/`operationId` 只能来自 Runtime Context（服务端注入），模型传入的直接拒绝。

#### Line 3: 敏感操作确认

写操作（记账、预算修改、记忆写入）触发 LangGraph `interrupt()`：

```typescript
// 需要用户确认的工具
const SENSITIVE_WRITE_TOOLS = new Set([
  'update_budget', 'confirm_user_memory',
  'delete_user_memory', 'update_transaction'
])
```

### 4.3 JSON 容错修复

模型输出的 JSON 参数可能格式不规范，Agent 内置修复流水线：

```
原始输出 → 去除注释 → 单引号转双引号 →
补齐键名引号 → 移除尾随逗号 → try JSON.parse
```

支持 ```` ```json ```` 代码块、裸 JSON、嵌套参数对象等多种格式。

---

## 5. 灰度架构与 Feature Flag

### 5.1 设计目标

所有可选能力通过环境变量控制，**不需要删代码、不需要改数据库**：

```env
ENABLE_LANGGRAPH_AGENT=false      # Agent 总开关
LANGGRAPH_ROLLOUT_PERCENT=0       # 灰度比例 0-100
ENABLE_FOUR_LAYER_MEMORY=false    # 四层记忆
ENABLE_ADMIN_SQL_AGENT=false      # 管理 SQL 查询
ENABLE_PADDLE_OCR=false           # OCR 票据识别
ENABLE_QDRANT_KNOWLEDGE=false     # 知识库检索
ENABLE_BILL_VECTOR_WRITE=false    # 账单向量写入
```

### 5.2 稳定分桶路由

灰度比例通过用户 ID 哈希分桶，保证同一用户始终落在同一组：

```typescript
// server/src/agent/service.js
export function inRollout(userId, percent) {
  if (percent <= 0) return false
  if (percent >= 100) return true
  const digest = createHash('sha256').update(String(userId)).digest()
  return digest.readUInt32BE(0) % 100 < percent
}
```

### 5.3 上线路线图

```
1. ENABLE_LANGGRAPH_AGENT=true, ROLLOUT=0%
   → 观察启动日志，验证无异常

2. ROLLOUT=5%
   → 小流量只读查询，观察错误率

3. 逐步开启记忆 → 记账 → OCR → 知识库
   → 每步观察 24h

4. 异常时关闭对应 flag，秒级回滚
```

---

## 6. 技术栈

### 后端
- **Agent 框架**: LangChain.js + LangGraph.js
- **运行时**: Node.js 22+ / Express
- **数据库**: MySQL 8 (Knex ORM)
- **缓存**: Redis Stack 7.4 (RedisJSON / 浅层 Checkpoint 持久化)
- **向量库**: Qdrant
- **验证**: Zod (State Schema) + node-sql-parser (SQL AST)

### 前端
- **框架**: Vue 3 (Composition API) + Vite
- **状态**: Pinia
- **图表**: ECharts / vue-echarts
- **路由**: Vue Router

### 基础设施
- **容器化**: Docker Compose (7 个服务)
- **反向代理**: Nginx (Alpine)
- **部署**: 阿里云 ECS (2C4G, Ubuntu 22.04)
- **模型**: DeepSeek v4 Pro / LM Studio 本地 Qwen

---

## 7. 项目结构

```text
smart-finance/
├── client/                           # Vue 3 前端
│   └── src/
│       ├── components/               # ChatWindow, ReportPanel, ImportPage...
│       ├── mobile/                   # 移动端适配
│       ├── stores/                   # Pinia
│       └── utils/                    # API 封装
├── server/                           # Node.js 后端
│   └── src/
│       ├── agent/                    # ⭐ Agent 核心
│       │   ├── graph.js              # StateGraph 构建 + 路由 + JSON 修复
│       │   ├── state.js              # AgentState Schema (Zod)
│       │   ├── prompts.js            # System Prompt + 工具描述
│       │   ├── runtime.js            # Trusted Runtime Context
│       │   ├── tools/                # 8+ Domain Tools
│       │   │   ├── domainTools.js    # 查询/记账/预算计算
│       │   │   ├── memoryTools.js    # 长期记忆 CRUD
│       │   │   ├── adminSqlTool.js   # 管理 SQL (受 SQL Guard 保护)
│       │   │   ├── knowledgeTool.js  # 知识库检索
│       │   │   ├── ocrTool.js        # PaddleOCR
│       │   │   └── runtimeTools.js   # 部署工具
│       │   ├── nodes/                # 图节点
│       │   │   ├── normalizeRequest.js    # 意图识别
│       │   │   ├── composePrompt.js       # Prompt 组装
│       │   │   ├── validateToolCall.js    # 参数校验
│       │   │   ├── riskAndConfirmation.js # 安全确认 + interrupt
│       │   │   ├── observe.js             # 可观测性
│       │   │   └── postTurnMemory.js      # 记忆更新
│       │   ├── memory/               # 四层记忆实现
│       │   │   ├── contextLoader.js  # 并行加载四层上下文
│       │   │   ├── sessionMetadata.js
│       │   │   ├── userMemory.js
│       │   │   ├── recentSummary.js
│       │   │   └── windowMemory.js
│       │   ├── security/
│       │   │   └── sqlGuard.js       # SQL AST 三层校验
│       │   ├── stores/               # Dataset / Operation 存储
│       │   └── subgraphs/
│       │       └── domainAnalysis.js # 子图：领域分析
│       ├── routes/                   # REST API
│       ├── services/                 # 业务服务 (确定性计算/检索等)
│       └── test/                     # 测试 (610 cases)
├── miniprogram/                      # 微信小程序
├── docker-compose.yml                # 本地/生产编排
├── docs/
│   └── 3AGENT_ARCHITECTURE.md        # 历史架构文档（已被 §2.4 取代）
└── scripts/                          # 部署脚本
```

---

## 8. 本地开发与部署

### 前置依赖

- Docker Desktop
- Node.js 22+

### 快速启动

```bash
# 1. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local：填写 LLM API Key

# 2. 一键启动
docker compose up -d

# 3. 验证
curl http://localhost:3000/api/health/ready
# → {"status":"ready","services":{"mysql":{"ok":true},...}}

# 前端: http://localhost
# 后端: http://localhost:3000
```

### 运行测试

```bash
cd server

# 全量测试
npm test                  # 609/610 通过 (1 skip)

# Agent 专项测试
npm run test:agent
```

### 生产部署

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

---

## 关键指标

| 指标 | 数值 |
|------|------|
| 单元测试通过率 | 609/610 (1 skip) |
| Feature-Off 兼容验证 | 20/20 (100%) |
| 灰度范围 | 0-100%（按用户 ID 哈希分桶） |
| 回滚速度 | 秒级（环境变量切换） |
| 支持模型 | DeepSeek v4 / Qwen (LM Studio) / OpenAI 兼容 |
| 容器服务数 | 7 (backend + frontend + mysql + redis + qdrant + nginx + optional) |

---

## 许可证

当前仓库未声明开源许可证。公开使用、分发或二次开发前请先补充许可证文件。
