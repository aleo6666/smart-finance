# Smart Finance Assistant

智能个人财务记账助手，一个面向日常消费管理的 AI-Native 记账系统。项目支持自然语言记账、账单导入、消费分析、预算查询、目标管理、长期记忆和多端访问，前端线上地址为 [lisheng666.xyz](https://lisheng666.xyz/#/)。

## 功能概览

- 智能记账：支持自然语言输入，例如“今天午餐花了25元”，后端自动识别金额、分类、日期和描述。
- 账单查询：支持今日、本月、上月、分类明细、最大单笔、平均消费等统计查询。
- 消费分析：提供月度报表、分类占比、趋势分析和预算执行情况。
- 账单导入：支持前端导入页面创建导入批次，并按当前账本写入记录。
- 多账本：前端选择账本后，记账、导入、报表和查询都会按账本范围过滤。
- LangGraph Agent：运行时绑定财务工具和记忆工具，支持查询、记账、预算、用户资料记忆等能力。
- 四层记忆：会话元数据、用户长期记忆、近期摘要和滑动窗口上下文。
- RAG 与向量检索：可选接入 Qdrant，用于消费建议和语义检索。
- 安全控制：JWT 鉴权、频率限制、敏感操作确认、只读管理 SQL 防护、敏感配置忽略提交。

## 技术栈

前端：

- Vue 3
- Vite
- Pinia
- Vue Router
- ECharts / vue-echarts

后端：

- Node.js 22+
- Express
- Knex
- MySQL 8
- Redis 8
- Qdrant
- LangChain / LangGraph
- Zod

部署：

- Docker Compose
- Nginx 前端容器
- Backend / MySQL / Redis / Qdrant 多容器服务

## 目录结构

```text
.
├── client/                 # Vue 前端
│   ├── src/components/     # 桌面端业务组件
│   ├── src/mobile/         # 移动端入口
│   ├── src/stores/         # Pinia 状态
│   └── src/utils/          # API 封装
├── server/                 # Express 后端
│   ├── src/agent/          # LangGraph Agent、工具、记忆、图节点
│   ├── src/routes/         # API 路由
│   ├── src/services/       # 业务服务
│   └── test/               # 后端测试
├── miniprogram/            # 微信小程序相关文件
├── scripts/                # 本地启动、停止和部署脚本
├── docs/                   # 项目文档
├── docker-compose.yml      # 本地/服务端 compose 配置
├── docker-compose.prod.yml # 生产 compose 配置
└── .env.example            # 环境变量模板
```

## 本地运行

### 前置条件

- Docker Desktop
- Node.js 22+
- PowerShell 7
- 一个 OpenAI 兼容的模型服务，例如 LM Studio、DeepSeek 或其他兼容接口

### 配置环境变量

复制环境变量模板：

```powershell
Copy-Item .env.example .env.local
```

至少需要检查这些配置：

```env
DB_NAME=smart_finance
DB_USER=finance
DB_PASSWORD=your-db-password
DB_ROOT_PASSWORD=your-root-password

JWT_SECRET=

LM_STUDIO_BASE_URL=https://api.deepseek.com/v1
LM_STUDIO_API_KEY=your-api-key
LM_STUDIO_CHAT_MODEL=deepseek-v4-pro
LM_STUDIO_EMBEDDING_MODEL=deepseek-embed
```

`.env`、`.env.local`、`.env.production` 已被 `.gitignore` 忽略，请不要把真实密钥提交到仓库。

### 一键启动

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

启动后访问：

- 前端：http://localhost
- 后端：http://localhost:3000
- 健康检查：http://localhost:3000/api/health/ready

### 停止服务

```powershell
# 停止容器，保留数据卷
.\scripts\stop-local.ps1

# 停止容器并清理数据卷
.\scripts\stop-local.ps1 -Clean
```

## 开发命令

安装依赖：

```powershell
npm run install:all
```

分别启动前后端开发服务：

```powershell
npm run dev:server
npm run dev:client
```

构建前端：

```powershell
cd client
npm run build
```

运行后端测试：

```powershell
cd server
npm test
```

运行 Agent 测试：

```powershell
cd server
npm run test:agent
```

重建 RAG 向量索引：

```bash
docker compose exec backend npm run reindex:rag
```

## Agent 开关

LangGraph Agent 默认可灰度启用。常用变量：

```env
ENABLE_LANGGRAPH_AGENT=false
ENABLE_FOUR_LAYER_MEMORY=false
ENABLE_ADMIN_SQL_AGENT=false
ENABLE_PADDLE_OCR=false
ENABLE_QDRANT_KNOWLEDGE=false
ENABLE_BILL_VECTOR_WRITE=false
LANGGRAPH_ROLLOUT_PERCENT=0
```

建议上线顺序：

1. `ENABLE_LANGGRAPH_AGENT=true`，`LANGGRAPH_ROLLOUT_PERCENT=0`，先观察服务启动与日志。
2. 小流量开启只读查询，例如 `LANGGRAPH_ROLLOUT_PERCENT=5`。
3. 再逐步开启四层记忆、记账工具、OCR、知识库检索和管理 SQL。
4. 出现异常时优先关闭对应 feature flag，不需要删除数据库表。

## API 模块

后端主要路由位于 `server/src/routes`：

- `auth`：登录与鉴权
- `chat`：智能对话、记账、查询、建议
- `records`：账单 CRUD
- `reports`：月度消费分析
- `import`：账单导入
- `ledgers`：账本管理
- `goals`：目标管理
- `reminders`：提醒
- `vision`：图片/OCR 相关能力
- `health`：服务健康检查
- `export`：账单导出

## 安全说明

- 不要提交 `.env`、`.env.local`、`.env.production`、数据库文件、上传文件、部署包、截图和压缩包。
- 微信 AppID 等公开配置请使用 `touristappid` 或本地私有配置文件。
- 生产环境必须设置强 `JWT_SECRET`、数据库密码和只读管理 SQL 账号。
- 管理 SQL 只能连接脱敏视图或只读账号，不应使用业务写账号。
- LangGraph 工具参数中的 `userId`、`sessionId`、`operationId` 等可信字段只允许来自服务端 Runtime Context。

## 部署

生产环境可参考：

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

常用检查：

```bash
docker compose ps
docker logs --tail 100 finance-backend
curl http://127.0.0.1:3000/api/health/ready
```

项目已在云服务器中使用 `finance-backend`、`finance-frontend`、`finance-mysql`、`finance-redis`、`finance-qdrant` 等容器运行。

## 常见问题

**前端看不到智能体记的账**

优先检查 `ledgerId` 是否一致。智能体、导入页、报表页和前端选中账本必须使用同一个账本范围。

**查询“今天/本月/上月”结果不对**

检查请求是否传入用户时区，以及后端是否按 `Asia/Shanghai` 或当前用户时区计算自然日和自然月。

**出现“请求无法安全执行”**

通常是模型调用了未注册工具、工具参数包含可信字段，或触发了敏感操作确认。请检查 Agent 绑定工具清单、系统提示词和 `riskAndConfirmation` 日志。

**RAG 或建议不可用**

确认 Qdrant、Embedding 模型和 `RAG_ENABLED` 配置是否正常。精确账单查询会优先走 MySQL，不依赖 RAG。

## 许可证

当前仓库未声明开源许可证。公开使用、分发或二次开发前请先补充许可证文件。
