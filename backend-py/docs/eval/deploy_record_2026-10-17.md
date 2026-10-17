# Smart Finance 生产部署记录（2026-10-17）

> 目标：把 2026-10-17 的鉴权与意图修复上线到 `https://lisheng666.xyz`。
> 执行方式：通过「极目Linux桌面」的 root 终端操作服务器；本地不保存服务器密码。

## 1. 生产环境实际结构

| 项 | 值 |
|---|---|
| 服务器 | `lisheng666.xyz` / `8.163.84.206` |
| 后端目录 | `/opt/smart-finance-py` |
| Compose 文件 | `/opt/smart-finance-py/cloud-compose.yml` |
| Compose 项目 | `smart-finance-py` |
| 后端服务 / 容器 | `backend-py` / `finance-py-backend` |
| 后端镜像 | `smart-finance-py-backend:latest` |
| 后端端口 | `127.0.0.1:4001 -> 8000` |
| 代码目录（容器内） | `/app`，源码 `/app/app` |
| 运行用户 | `app`（UID 100） |

其余四个服务（`finance-frontend`、`finance-mysql`、`finance-qdrant`、`finance-redis`）来自另一个 Compose 项目，工作目录 `/opt/smart-finance`；本次未动。

> 关键事实：`/opt/smart-finance-py` 只有 Compose 和环境文件，**没有源码 git 仓库**；生产后端跑的是预构建镜像。因此没有 `git pull` 可用，采用代码包热更新 + 镜像固化。

## 2. 代码包

本地构建（不含测试、缓存）：

```bash
cd F:/projects/smart-finance/backend-py
tar czf _deploy_app.tar.gz --exclude='__pycache__' --exclude='*.pyc' app
base64 -w0 _deploy_app.tar.gz > _deploy_app.b64
```

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `_deploy_app.tar.gz` | 126 KB | `c5f2a9109822dcfde2aafeeda4519336dab461354c09de39003fc2767eeb8b4e` |
| `_deploy_app.b64` | 167 KB | `681d3d035ac686b4be91a2099e518d8a41d83203a882776ed2df6bc25a7e3070` |

传输方式：base64 分 4 段粘贴到服务器 `/tmp/app.b64`，`base64 -d` 还原；`tar tzf` 与 SHA-256 均校验通过。

> `_deploy_app.tar.gz` / `.b64` 是临时传输文件，部署后已从本机清理；需要重建时按本节命令重新生成。

## 3. 部署步骤（已执行）

```bash
# 1) 备份当前镜像
docker tag smart-finance-py-backend:latest \
  smart-finance-py-backend:pre-hotfix-20261017

# 2) 把代码包拷进运行中的容器，root 覆盖解包
docker cp /tmp/app.tar.gz finance-py-backend:/tmp/app.tar.gz
docker exec -u root finance-py-backend sh -lc '
  cd /app &&
  tar xzf /tmp/app.tar.gz --overwrite &&
  find /app -name __pycache__ -type d -prune -exec rm -rf {} + &&
  chown -R 100:101 /app/app &&
  python -m compileall -q /app/app &&
  echo COPY_OK
'

# 3) 重启并观察
docker restart finance-py-backend
docker ps --filter name=finance-py-backend
docker logs --tail 25 finance-py-backend

# 4) 通过后固化为新镜像
docker commit finance-py-backend smart-finance-py-backend:20261017
docker tag smart-finance-py-backend:20261017 \
  smart-finance-py-backend:latest

# 5) 用新镜像重建容器（只重建 backend）
cd /opt/smart-finance-py
docker compose -p smart-finance-py -f cloud-compose.yml \
  up -d --no-deps backend-py
```

镜像标签：

- 旧镜像：`smart-finance-py-backend:pre-hotfix-20261017`
- 新镜像：`smart-finance-py-backend:20261017`，同时指向 `latest`

## 4. 线上复核（2026-10-17 15:40 CST）

从本机公网访问，不带 token、附带 `?user_id=999999`：

| 接口 | 状态码 |
|---|---:|
| `GET /api/records` | 401 |
| `GET /api/ledgers` | 401 |
| `GET /api/budgets` | 401 |
| `GET /api/goals` | 401 |
| `GET /api/financial/metrics` | 401 |
| `GET /api/financial/overview` | 401 |
| `GET /api/analysis/all` | 401 |
| `GET /api/reports` | 401 |
| `GET /api/reports/history` | 401 |
| `GET /api/knowledge/documents` | 401 |

其他：

```text
GET /api/health        200  {"success":true,"message":"智能财务记账助手服务运行中"}
GET /api/health/ready  ready {"mysql":{"ok":true},"qdrant":{"ok":true}}
```

响应体示例：

```json
{"success":false,"data":null,"error":"未登录"}
```

带 token 的正向验证（在服务器容器内生成 user 14 的短期 token，不落盘、不打印）：

```text
GET /api/records  200      GET /api/ledgers  200
GET /api/budgets  200      GET /api/goals  200
GET /api/financial/metrics  200
GET /api/financial/overview  200
GET /api/analysis/all  200
GET /api/reports  200      GET /api/reports/history  200
GET /api/knowledge/documents  200
?user_id=14 与 ?user_id=999999 的响应体逐字节一致 → query 参数已被忽略
```

## 5. 回滚

```bash
docker tag smart-finance-py-backend:pre-hotfix-20261017 \
  smart-finance-py-backend:latest
cd /opt/smart-finance-py
docker compose -p smart-finance-py -f cloud-compose.yml \
  up -d --no-deps backend-py
```

回滚只回后端代码；**数据库无结构变更，不需要回滚数据**。

## 6. 边界

- 本次验证只覆盖匿名访问门禁：10 个受保护 GET 全部 401。
- 跨用户 token 隔离（A 用户带 token 读 B 用户数据应 403/404）未在生产复测；需要两个账号，遵循只读约束没有写入测试数据。
- 前端未改动；未跑数据库迁移；未重启 MySQL/Qdrant/Redis。
- 容器内临时文件与本地传输文件已清理；镜像已固化，后续 `docker compose up` 会使用 `latest` 新镜像。
