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
- LangGraph StateGraph 编排，12 节点 + 条件路由
- 四层记忆：会话元数据 / 长期记忆 / 近期摘要 / 滑动窗口
- 3-Agent 主从协同：Master / Retrieval / Calculator
- 灰度架构：Feature Flag + 哈希分桶 + 秒级回滚

### 安全控制
- JWT 鉴权 + Redis 频率限制
- SQL AST 语法守卫（node-sql-parser 白名单 + LIMIT 强制）
- 敏感操作 LangGraph interrupt 确认
- 只读管理 SQL 独立数据库账号

### 认证方式

- **邮箱 + 密码**：注册和重置密码均需先通过邮件中的 6 位验证码；验证后注册，登录使用邮箱和密码
- **手机 + 密码**：现有接口继续保留，生产环境短信供应商尚未接入
- **微信**：微信小程序和公众号认证入口继续保留

### 邮箱 SMTP 配置

个人项目可使用邮箱服务商提供的 SMTP 能力发送验证码。`SMTP_PASS` 必须填写个人邮箱后台生成的 **SMTP app 授权码**，它既不是邮箱登录密码，也不是用户收到的 6 位验证码。`EMAIL_OTP_SECRET` 是独立的随机 HMAC 密钥，生产环境至少 32 个字符；生产环境同时需要至少 32 个字符的强 `JWT_SECRET`。真实邮箱、授权码和密钥均不得提交到仓库。

| 变量 | 用途 |
|------|------|
| `SMTP_HOST` | 邮箱服务商的 SMTP 主机 |
| `SMTP_PORT` | SMTP 端口；通常 465 配合安全连接，587 配合 STARTTLS |
| `SMTP_SECURE` | 465 通常设为 `true`，587 通常设为 `false` |
| `SMTP_USER` | 发件邮箱账号 |
| `SMTP_PASS` | 邮箱服务商生成的 SMTP app 授权码 |
| `MAIL_FROM` | 收件箱展示的发件人名称和地址 |
| `EMAIL_OTP_SECRET` | 独立随机密钥，生产环境至少 32 个字符 |

变量模板见 [`server/.env.example`](./server/.env.example)。直接运行后端时，将配置写入被 Git 忽略的 `server/.env`；通过 Docker Compose 运行时，将 Compose 插值变量写入仓库根目录下被忽略的 `.env`。可用以下命令生成 `EMAIL_OTP_SECRET`，请只保存到本地或密钥管理服务：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

验证码安全策略：有效期 5 分钟、60 秒发送冷却、最多尝试 5 次且成功后立即失效；同一邮箱每小时最多发送 5 次，同一 IP 每小时最多 20 次；邮箱密码连续失败 5 次后锁定 15 分钟。Redis 不可用时验证码流程默认关闭（fail closed），重置密码接口使用统一响应防止探测已注册邮箱。

可选真实 Redis 集成测试中的 `EMAIL_AUTH_REDIS_URL` 只能指向专用或临时测试 Redis/DB。测试不会调用 `FLUSHDB` 或 `FLUSHALL`，但会写入短期 HMAC 测试键，并仅清理本次测试新增的键。

上线前应使用专用测试邮箱做一次人工 SMTP smoke：在本地安全配置上述变量并启动依赖，依次验证发送注册验证码、完成注册、邮箱密码登录和重置密码，再确认验证码不可重复使用、过期后失效；日志不得包含完整邮箱（邮箱仅以脱敏形式出现），且不得包含授权码、密钥或验证码。此步骤需要项目维护者自己的邮箱服务商授权码，不属于自动化测试。

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
├── nodes/                # 图节点（12 个）
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
