# Smart Finance Python 后端阶段 1 设计

## 1. 目标与范围

阶段 1 在仓库根目录新增独立的 `backend-py/`，建立可运行、可测试、可容器化的 Python 后端基础。旧 `server/` 仅作为 API 契约参考，不修改、不复用其运行时代码，也不迁移旧数据库结构或数据。

本阶段交付：

- FastAPI 应用与 `/api/health` 健康检查。
- 基于 `pydantic-settings` 的环境变量配置。
- SQLAlchemy 2.0 异步引擎、会话依赖和 Alembic 异步迁移环境。
- 独立 Docker Compose，包含 Python 后端、MySQL 8.4 和 Qdrant。
- 面向后续模块的包目录与清晰边界。
- 配置、健康检查和数据库基础设施的自动化测试。

数据模型、认证和业务 API 不在阶段 1 实现；它们分别在阶段 2 和阶段 3 通过测试驱动方式加入。

## 2. 运行与隔离策略

`backend-py/docker-compose.yml` 是独立 Compose 项目，使用自己的 MySQL、Qdrant 服务和命名卷，不读取旧数据库卷。Compose 不声明固定 `container_name`，依靠项目作用域隔离资源，避免与根目录旧 Compose 的容器名冲突。

Python 容器监听 `8000`，宿主机映射 `127.0.0.1:3000:8000`。Web 开发服务器现有 `/api -> http://localhost:3000` 代理无需改变。小程序继续使用现有 HTTPS 域名；部署切换时只把该域名的反向代理上游改为 Python 服务。

阶段 1 不修改 Web 或小程序代码。后续每迁移一组业务 API，就以现有前端调用为契约补充兼容测试并同步修正必要的前端字段，不保留 Node 回退链路。

Redis 在阶段 1 不启动。配置保留可选的 `REDIS_URL`，只有后续缓存、限流或 LangGraph checkpoint 明确需要时才加入 Compose。

## 3. 应用结构与职责

`backend-py/app/main.py` 提供 `create_app()` 应用工厂和默认 `app` 实例。应用工厂负责中间件、异常处理和路由注册，使测试无需真实网络或外部依赖即可创建应用。

`backend-py/app/core/config.py` 定义唯一的 `Settings`：

- 应用名称、环境、CORS 来源和日志级别。
- `DATABASE_URL`。
- Qdrant、可选 Redis、LLM、Embedding、Rerank 配置。
- JWT、RAG 召回数和上下文长度。

所有值从环境变量或 `.env` 读取；仓库只提交不含真实密钥的 `.env.example`。配置对象通过缓存函数创建，测试可以清除缓存并注入独立环境。

`backend-py/app/core/database.py` 根据 `DATABASE_URL` 创建异步 SQLAlchemy 引擎和 `async_sessionmaker`，提供请求级 `get_db()` 依赖。支持以下连接串而不改业务代码：

- MySQL：`mysql+asyncmy://...`
- PostgreSQL：`postgresql+asyncpg://...`
- SQLite：`sqlite+aiosqlite:///...`

MySQL 异步驱动固定使用 `asyncmy`，不安装或使用 `aiomysql`；`requirements.txt` 必须显式包含 `asyncmy`。

`backend-py/alembic/env.py` 复用同一 `DATABASE_URL` 和 ORM metadata，使用异步连接执行在线迁移；离线模式生成 SQL。阶段 1 建立迁移环境，阶段 2 再生成首个新模型迁移。

`app/api`、`app/models`、`app/schemas`、`app/services`、`app/agents` 和 `app/tasks` 在阶段 1 建立 Python 包边界，但不加入无行为的业务占位实现。

## 4. 健康检查契约

`GET /api/health` 是无外部依赖的轻量存活检查，固定返回 HTTP 200 和旧 Node 后端现有响应：

```json
{"success": true, "message": "智能财务记账助手服务运行中"}
```

这样现有反向代理和 Docker 健康检查路径、状态码与响应判定均可保持不变。

同时保留 `GET /api/health/ready` 作为就绪检查。它检查 MySQL 与 Qdrant：全部可用时返回 HTTP 200、`status: ready`；任何必需依赖不可用时返回 HTTP 503、`status: degraded`，并为每项依赖返回不含凭据和内部异常详情的结果。外部 LLM 不作为容器就绪前提，避免第三方 API 波动导致本地服务反复重启。

## 5. API 与错误处理基础

除健康检查的兼容响应外，后续 API 使用统一格式：

```json
{"success": true, "data": {}, "error": null}
```

```json
{"success": false, "data": null, "error": "面向用户的错误信息"}
```

阶段 1 注册统一 HTTP 异常和请求校验异常处理器，确保未知堆栈、数据库地址和密钥不会进入响应。未处理异常记录服务端日志，对客户端返回通用错误。

CORS 来源由环境变量显式配置；开发示例允许本地 Web 端口，生产环境不使用通配符与凭据组合。

## 6. Docker 与可移植性

Dockerfile 使用 `python:3.11-slim`，以非 root 用户运行 Uvicorn。依赖先复制和安装，再复制应用代码以利用构建缓存。容器启动命令为 `uvicorn app.main:app --host 0.0.0.0 --port 8000`。

Compose 中：

- `mysql` 使用 MySQL 8.4、独立持久卷和 `mysqladmin ping` 健康检查。
- `qdrant` 固定使用 `qdrant/qdrant:v1.11.3`、独立持久卷和容器内 TCP 健康检查，禁止使用 `latest`。
- `backend` 等待 MySQL 与 Qdrant 健康后启动，从 `.env` 读取配置，并对 `/api/health` 执行容器健康检查。
- 只有后端端口映射到宿主机；数据库和 Qdrant 默认只在 Compose 网络内可见。

不使用云厂商专有 SDK。未来迁移服务器时只需复制仓库、环境文件和数据备份，再运行 Compose。

## 7. 测试与验收

阶段 1 采用测试先行：先写预期行为并确认失败，再写最小实现。

自动化测试覆盖：

- 未设置可选变量时可以加载开发配置。
- `DATABASE_URL`、JWT 和模型配置能被环境变量覆盖。
- SQLite、MySQL 和 PostgreSQL 异步连接串能交给数据库层创建引擎。
- `/api/health` 返回 HTTP 200 和旧后端的精确 JSON。
- `/api/health/ready` 能区分 ready 与 degraded，依赖失败返回 503。
- 请求校验错误遵守统一错误格式。

本地验收命令：

1. `pytest` 全部通过。
2. `python -m compileall app` 通过。
3. `docker compose config` 通过且不暴露真实密钥。
4. 确认宿主机 `127.0.0.1:3000` 未被旧后端或其他进程占用；如被占用，先停止对应进程，不静默改用其他端口。
5. Docker Desktop 可用后，`docker compose up -d --build` 启动三个服务。
6. `curl http://localhost:3000/api/health` 返回旧后端兼容响应。
7. `curl http://localhost:3000/api/health/ready` 返回 HTTP 200 和 `status: ready`。

如果当前机器的 Docker daemon 不可用，前 3 项仍需完成；容器启动验收明确记录为环境阻塞，Docker 恢复后补做，不用伪造成功结果。

## 8. 阶段完成边界

阶段 1 完成后，仓库具备可独立启动的 Python 服务、可迁移数据库基础和稳定健康检查，但不会宣称前端业务功能已经可用。进入阶段 2 后，从新设计创建用户、交易、预算、目标、资产、负债、画像、知识文档和报告表，并实现认证；进入阶段 3 后再逐项接通 Web 与小程序业务接口。
