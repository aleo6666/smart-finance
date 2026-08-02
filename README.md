# Smart Finance · AI-Native 智能财务顾问

[![部署状态](https://img.shields.io/badge/status-online-brightgreen)](http://8.163.84.206)
[![Node.js](https://img.shields.io/badge/node-22+-339933)](https://nodejs.org)
[![LangGraph](https://img.shields.io/badge/LangGraph-0.x-blue)](https://github.com/langchain-ai/langgraphjs)
[![测试](https://img.shields.io/badge/tests-243%2F243-brightgreen)](#)
[![许可证](https://img.shields.io/badge/license-Unlicensed-red)](#)

基于 LangGraph 的 AI-Native 智能财务顾问——从自然语言记账到财务健康评估，从四层记忆到三级安全防线，从本地开发到 Docker 灰度部署的全链路实现。

线上地址：http://8.163.84.206

> 📖 深度架构文档见 [README_DEEP.md](./README_DEEP.md)

---

## 功能概览

### 智能记账
- 自然语言输入，自动识别金额、分类、日期
- 支持多账本，微信小程序
- OCR 票据识别（PaddleOCR）

### 账单查询与分析
- 今日/本月/上月/分类明细/最大单笔/平均消费
- 月度报表、分类占比、趋势分析
- RAG 语义检索（Qdrant 向量库）

### 🆕 财务顾问
- **财务健康评估**：储蓄率、收支平衡、预算执行率、消费结构
- **财务健康评分**：0-100 分综合评估（5 维度加权）
- **目标规划**：储蓄目标 / 大额消费计划可行性分析
- **个性化建议**：基于消费模式的结构化改进建议

### Agent 架构
- LangGraph StateGraph 编排，10 节点 + 条件路由
- 四层记忆：会话元数据 / 长期记忆 / 近期摘要 / 滑动窗口
- 3-Agent 主从协同：Master / Retrieval / Calculator
- 灰度架构：Feature Flag + 哈希分桶 + 秒级回滚

### 安全控制
- JWT 鉴权 + Redis 频率限制
- SQL AST 语法守卫（node-sql-parser 白名单 + LIMIT 强制）
- 敏感操作 LangGraph interrupt 确认
- 只读管理 SQL 独立数据库账号

---

## 技术栈

| 层级 | 技术 |
|------|------|
| Agent 框架 | LangChain.js + LangGraph.js |
| 后端 | Node.js 22+ / Express / Knex |
| 数据库 | MySQL 8 / Redis 7 / Qdrant |
| 前端 | Vue 3 / Vite / Pinia / ECharts |
| 验证 | Zod / node-sql-parser |
| 部署 | Docker Compose / Nginx / 阿里云 ECS |
| 模型 | DeepSeek V4 Pro / LM Studio (Qwen) |
| 测试 | Node Test Runner + 评估框架 |

---

## 快速开始

```bash
# 1. 配置
cp .env.example .env.local

# 2. 启动
docker compose up -d

# 3. 验证
curl http://localhost:3000/api/health/ready
```

---

## 开发命令

```bash
npm run dev:server          # 后端开发
npm run dev:client          # 前端开发

cd server

npm test                    # 全量测试 (233+ tests)
npm run test:agent          # Agent 测试
npm run eval                # Agent 评估 (22 用例)
npm run test:eval -- --test-name-pattern="advisor"  # 财务顾问评估
```

---

## 项目结构

```text
server/src/agent/
├── graph.js              # StateGraph 构建 + 路由
├── state.js              # AgentState Schema (Zod)
├── prompts.js            # System Prompt（财务顾问人格）
├── runtime.js            # Trusted Runtime Context
├── tools/
│   ├── domainTools.js    # 查询/记账/预算
│   ├── advisorTool.js    # 🆕 财务顾问（健康评估+目标规划）
│   ├── memoryTools.js    # 长期记忆
│   ├── adminSqlTool.js   # 管理 SQL（SQL Guard 保护）
│   ├── knowledgeTool.js  # 知识库检索
│   └── ocrTool.js        # PaddleOCR
├── memory/               # 四层记忆
├── nodes/                # 图节点（7 个）
├── security/sqlGuard.js  # SQL AST 三层守卫
├── eval/                 # 🆕 Agent 评估框架
│   ├── framework.js      # 评估运行器 + 报告生成
│   └── cases.js          # 22 个评估用例 (7 维度)
└── utils/                # jsonRepair / textToolCalls
```

---

## Agent 评估

`npm run eval` 运行 22 个确定性的 Agent 评估用例：

| 维度 | 用例数 | 说明 |
|------|--------|------|
| record | 4 | 智能记账准确率 |
| query | 3 | 账单查询正确性 |
| analysis | 2 | 消费分析 |
| budget | 3 | 预算管理（含超支检测） |
| safety | 4 | 安全防护（拒绝越权） |
| memory | 2 | 记忆确认流 |
| routing | 4 | 路由决策 |

---

## 许可证

当前仓库未声明开源许可证。公开使用、分发或二次开发前请先补充。
