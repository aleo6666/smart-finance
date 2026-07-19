# Smart Finance V3 第 10 阶段：本地 RAG 与一键运行落地设计

日期：2026-07-19  
状态：已确认，待实施计划

## 1. 目标

第 10 阶段把现有 Smart Finance V3 收敛为可在 Windows 本机稳定运行和验收的交付物，并补齐真正参与回答的本地 RAG 链路。

完成后，开发者在已安装 Docker Desktop 和 LM Studio 的 Windows 主机上执行一个 PowerShell 脚本，即可完成环境检查、配置生成、服务构建、数据库初始化、RAG 初始化、健康检查和端到端冒烟验收。

## 2. 已确认边界

- 运行目标：Windows 本机，不做公网部署。
- 容器运行：前端、Node.js/Express 后端、MySQL、Redis、Qdrant。
- 主机运行：LM Studio。
- 唯一后端：`server/` Node.js/Express；不接入未跟踪的 `finance-backend/` Java 项目。
- 数据库：允许使用全新的 MySQL 数据库，不要求迁移现有 SQLite 数据。
- 数据库密码：沿用项目现有本地默认值。
- JWT：首次启动自动生成本地 `JWT_SECRET`。
- 第 9 阶段：不纳入本阶段，不包含微信登录、订阅消息或提醒确认。
- DeepSeek：不进入默认链路，不保存用户此前提供的 DeepSeek Key。

## 3. 本地模型与接口

当前 LM Studio 已确认具备：

- OpenAI 兼容服务：`http://127.0.0.1:1234/v1`。
- 生成模型：`qwen3.6-35b-a3b`。
- Embedding 模型：`text-embedding-nomic-embed-text-v1.5`。

Docker 后端无法访问只绑定在 `127.0.0.1` 的 LM Studio。启动脚本因此临时将 LM Studio Server 重启为 `0.0.0.0:1234`，但不启用 CORS，也不创建公网防火墙规则。停止脚本将服务恢复为 `127.0.0.1:1234`。

容器内后端通过 `http://host.docker.internal:1234/v1` 调用 LM Studio。

## 4. 总体架构

```text
Browser
  -> Nginx/Vue
  -> Node.js/Express
       -> MySQL       权威账目、用户和统计
       -> Redis       短期会话与任务状态
       -> Qdrant      用户隔离的账目向量
       -> LM Studio   Embedding + Qwen 回答生成
```

MySQL 始终是金额、分类、账本归属和统计结果的权威来源。Qdrant 只用于语义检索，不能替代 MySQL 聚合，也不能决定精确金额。

## 5. RAG 数据流

### 5.1 写入链路

1. 用户通过自然语言或确认流程写入账目。
2. 后端先提交 MySQL 事务。
3. 后端把账目转换为稳定的中文文本块。
4. LM Studio Embedding 模型生成向量。
5. 后端向版本化 Qdrant 集合写入向量和最小必要 payload。

payload 仅包含：`recordId`、`userId`、`ledgerId`、日期、月份、类型、分类、金额、商家、描述和检索文本。

向量写入失败不得撤销已成功写入 MySQL 的账目。失败应记录结构化告警，并允许通过重建脚本补偿。

### 5.2 查询链路

1. 后端识别用户意图并提取月份、分类、收支类型等提示。
2. 精确统计问题优先查询 MySQL，并直接使用数据库结果回答。
3. 建议、解释、相似消费和上下文问题进入 RAG。
4. LM Studio 为查询生成向量。
5. Qdrant 按 `userId` 强制过滤，并按可用的月份、分类和账本条件进一步过滤。
6. 取 Top-K 记录，限制总上下文长度并移除无关字段。
7. Qwen 根据用户问题、数据库摘要和检索证据生成中文回答。
8. API 返回回答以及来源 `recordId` 列表，便于测试和审计。

提示词必须明确：不得编造不存在的账目，不得自行替代数据库完成精确求和，证据不足时应说明无法判断。

## 6. 后端模块

### 6.1 LM Studio 客户端

新增可注入、可测试的客户端模块，使用原生 `fetch` 调用：

- `POST /v1/embeddings`
- `POST /v1/chat/completions`
- `GET /v1/models`

客户端负责超时、HTTP 错误、响应结构校验和安全错误信息。日志不得包含完整账目上下文或任何 API Key。

### 6.2 向量记忆

现有 `vectorMemory` 改为使用 LM Studio 的真实 Embedding。运行时不再使用确定性哈希伪向量；该算法仅可作为单元测试夹具。

Qdrant 使用新的版本化集合名称，避免与原有 1536 维伪向量集合发生维度冲突。初始化时用真实 Embedding 响应校验向量维度，再创建集合。

### 6.3 RAG 编排

新增独立 RAG 服务，负责：

- 规范化查询条件。
- 调用向量检索。
- 限制 Top-K 和上下文长度。
- 构造可审计提示词。
- 调用 Qwen。
- 返回回答和来源记录。
- 在 LM Studio 或 Qdrant 不可用时降级到现有模板回答。

### 6.4 索引重建

提供 Node.js 重建脚本，可从 MySQL 为全部账目或指定用户重新生成向量。脚本支持幂等 upsert、批次处理、进度输出和单条失败统计。

## 7. 配置

新增或统一以下本地配置：

- `LM_STUDIO_BASE_URL=http://host.docker.internal:1234/v1`
- `LM_STUDIO_CHAT_MODEL=qwen3.6-35b-a3b`
- `LM_STUDIO_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5`
- `RAG_ENABLED=true`
- `RAG_COLLECTION=finance_records_nomic_v1`
- `RAG_TOP_K=5`
- `RAG_EMBEDDING_TIMEOUT_MS=10000`
- `RAG_CHAT_TIMEOUT_MS=120000`

Git 只提交无敏感值的 `.env.example`。实际 `.env.local` 被 Git 忽略，首次启动时生成 JWT，不保存 DeepSeek Key。

## 8. 一键运行脚本

### 8.1 `scripts/start-local.ps1`

脚本按以下顺序执行：

1. 检查 PowerShell、Docker Desktop、Docker Compose 和 `lms` CLI。
2. 检查两个 LM Studio 模型已安装。
3. 记录 LM Studio 原监听方式，并将 Server 临时启动为 `0.0.0.0:1234`。
4. 检查 `/v1/models` 可访问。
5. 创建或复用 `.env.local`，首次生成强随机 JWT。
6. 执行 `docker compose --env-file .env.local up -d --build`。
7. 等待 MySQL、Redis、Qdrant、后端和前端健康。
8. 初始化数据库和版本化向量集合。
9. 运行本地端到端冒烟。
10. 输出访问地址、容器状态和排错命令。

脚本必须可重复执行，不应重复覆盖 JWT 或破坏已有数据卷。

### 8.2 `scripts/stop-local.ps1`

默认仅停止容器并保留数据，随后恢复 LM Studio 的 localhost 监听。只有显式清理参数才删除 Compose 数据卷。

## 9. 健康检查与冒烟

后端健康检查分别报告：

- MySQL
- Redis
- Qdrant
- LM Studio models
- LM Studio Embedding
- LM Studio Chat

端到端冒烟使用隔离的临时用户和测试数据：

1. 创建测试用户和账本。
2. 写入语义相关和不相关的多条账目。
3. 确认 Qdrant 写入成功且 payload 按用户隔离。
4. 发起精确统计查询，验证结果来自 MySQL。
5. 发起建议类查询，验证回答包含 RAG 来源。
6. 清理测试用户、账目和对应向量。

## 10. 测试策略

- 单元测试：LM Studio 客户端、响应校验、超时、向量维度、提示词和来源映射。
- 服务测试：用户隔离、过滤条件、Top-K、上下文截断、降级和索引重建。
- 路由测试：精确查询继续走 MySQL，建议类查询进入 RAG。
- 回归测试：后端全部 Node Test Runner 测试。
- 构建测试：Vue/Vite 生产构建。
- 集成测试：真实 LM Studio、Qdrant、MySQL 和 Redis 本地冒烟。
- 安全检查：仓库扫描不得出现 API Key、JWT 或本地 `.env.local`。

## 11. 错误处理

- LM Studio 未启动或模型缺失：启动脚本在构建容器前失败，并给出具体模型名。
- Embedding 超时：返回降级回答，记录可重试索引失败。
- Chat 超时：使用基于数据库与检索摘要的模板回答。
- Qdrant 不可用：精确 MySQL 查询继续可用。
- 集合维度不匹配：不自动删除数据，提示执行显式重建命令。
- Docker 服务未健康：脚本输出失败服务和最近日志，不继续宣称启动成功。

## 12. 非目标

- 公网域名、HTTPS、云服务器和云数据库。
- Kubernetes 或多机高可用。
- DeepSeek 默认调用链。
- 第 9 阶段微信小程序功能。
- Java `finance-backend/` 整合。
- SQLite 历史数据迁移。
- 自动修改 Windows 公网防火墙规则。

## 13. 完成标准

第 10 阶段只有在以下条件全部满足时才算完成：

1. 从 `master` 独立实现，不包含第 9 阶段代码。
2. 一个 PowerShell 命令可以完成本地启动与验收。
3. 后端、前端、MySQL、Redis 和 Qdrant 全部健康。
4. LM Studio 的 Chat 与 Embedding 检查通过。
5. 真实账目可写入 Qdrant，并能按用户隔离检索。
6. 精确统计由 MySQL 返回正确结果。
7. 建议类问题由 Qwen 基于检索来源生成回答。
8. LM Studio 或 Qdrant 故障时系统按设计降级。
9. 后端全量测试和前端构建通过。
10. 仓库不包含任何真实密钥。
