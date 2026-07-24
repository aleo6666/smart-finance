# Smart Finance 生产部署设计

**日期**: 2026-07-22
**目标**: 将 Smart Finance 部署到 2C2G 云服务器 `lisheng666.xyz`

## 1. 架构总览

```
┌────────────── lisheng666.xyz :443 ──────────────┐
│  Docker Compose (5 容器)                          │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │ nginx (:80/:443)                            │ │
│  │  ├─ /           → /usr/share/nginx/html     │ │
│  │  ├─ /api/*      → backend:3000              │ │
│  │  ├─ /uploads/*  → backend:3000/uploads      │ │
│  │  └─ SSL: Let's Encrypt (宿主机 mount)        │ │
│  └──────────────┬──────────────────────────────┘ │
│                 │ proxy_pass                      │
│  ┌──────────────▼──────────────────────────────┐ │
│  │ backend (Node 22 Alpine) :3000              │ │
│  │  ├─ 连接 mysql 容器                           │ │
│  │  ├─ canvas (Cairo/Pango 渲染)               │ │
│  │  ├─ AI: DeepSeek chat + 智谱 embed           │ │
│  │  └─ memoryStore Map (Redis auto-fallback)    │ │
│  └──────┬──────────┬──────────┬────────────────┘ │
│         │          │          │                   │
│  ┌──────▼──┐ ┌─────▼───┐ ┌───▼────────┐         │
│  │ mysql   │ │ redis   │ │ qdrant     │         │
│  │ :3306   │ │ :6379   │ │ :6333      │         │
│  │ 8.4     │ │ 7-alpine│ │ latest     │         │
│  │ 350MB   │ │ 25MB    │ │ 250MB      │         │
│  └─────────┘ └─────────┘ └────────────┘         │
│                                                   │
│  预计内存: ~1.1GB / 2GB                            │
│                                                   │
│  AI 云端:                                          │
│  ┌────────────────────────────────────────────┐  │
│  │ DeepSeek API (deepseek-chat)               │  │
│  │  ├─ RAG 对话增强 (ragService.js)            │  │
│  │  └─ baseUrl: https://api.deepseek.com/v1   │  │
│  ├────────────────────────────────────────────┤  │
│  │ 智谱 API                                    │  │
│  │  ├─ embedding-2 → Qdrant 向量化             │  │
│  │  └─ glm-4v-flash → 小票 OCR (vision.js)     │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

## 2. 服务清单

| 服务 | 镜像 | 内存预算 | 关键配置 |
|---|---|---|---|
| **nginx** | `nginx:alpine` | ~15 MB | HTTPS + 反向代理 + 静态文件 |
| **backend** | `node:22.21.1-alpine` (build) | ~250 MB | AI_PROVIDER=cloud, DB=SQLite |
| **mysql** | `mysql:8.4` | ~350 MB | `innodb_buffer_pool_size=64M`, `performance_schema=OFF` |
| **redis** | `redis:7-alpine` | ~25 MB | `maxmemory 50mb` |
| **qdrant** | `qdrant/qdrant:latest` | ~250 MB | 向量检索 |

## 3. AI 服务路由

新增 `server/src/services/aiClient.js`，根据 `AI_PROVIDER` 环境变量选择后端：

| AI_PROVIDER | chat() | embed() | 本地开发 |
|---|---|---|---|
| `cloud` (生产) | DeepSeek `deepseek-chat` | 智谱 `embedding-2` | ✗ |
| 未设置 (默认) | LM Studio (本地) | LM Studio (本地) | ✓ |

### 接口（与 lmStudioClient 同签名）

```js
{ chat(messages): Promise<string>, embed(text): Promise<number[]>, listModels(): Promise<string[]> }
```

### 各模块调用关系

| 模块 | 调用方法 | 生产 → | 开发 → |
|---|---|---|---|
| `ragService.js` | `chat()` | DeepSeek `deepseek-chat` | LM Studio |
| `vectorMemory.js` | `embed()` | 智谱 `embedding-2` | LM Studio |
| `healthService.js` | `chat()`, `embed()`, `listModels()` | 同上 | LM Studio |

## 4. 代码改动

### 4.1 新增文件

**`server/src/services/deepseekClient.js`**
- `chat(messages)` → `POST https://api.deepseek.com/v1/chat/completions`
- `listModels()` → 返回 `['deepseek-chat']`
- 鉴权: `Authorization: Bearer $DEEPSEEK_API_KEY`

**`server/src/services/zhipuEmbedClient.js`**
- `embed(text)` → `POST https://open.bigmodel.cn/api/paas/v4/embeddings`
- Model: `embedding-2`
- 鉴权: `Authorization: Bearer $ZHIPU_API_KEY`

**`server/src/services/aiClient.js`**
- 环境切换逻辑
- `AI_PROVIDER=cloud` → DeepSeek chat + 智谱 embed
- 否则 → lmStudioClient
- 导出: `{ chat, embed, listModels }`

**`docker-compose.prod.yml`**
- 5 个服务，MySQL 内存调优
- 生产环境变量注入

**`client/nginx.conf`** (修改, 适配生产)
- 加上 HTTPS 443 监听
- SSL 证书路径指向宿主 mount
- proxy_pass 改为 `backend:3000`（Docker 网络内）

### 4.2 修改现有文件

| 文件 | 改动 | 行数 |
|---|---|---|
| `server/src/index.js` | `lmStudioClient` → `aiClient` import | 1 行 |
| `server/src/services/ragService.js` | `lmStudioClient` → `aiClient` import | 1 行 |
| `server/src/services/vectorMemory.js` | `lmStudioClient` → `aiClient` import | 1 行 |
| `client/nginx.conf` | 增加 HTTPS server block | ~15 行 |

### 4.3 不改的文件

- `server/src/services/lmStudioClient.js` — 保留，本地开发用
- `server/src/services/vision.js` — 已经用智谱，不动
- `server/src/db-mysql.js` / `server/src/db.js` — 数据库切换详见第 5 节
- `server/src/services/nlu.js` — 规则引擎，不动
- `client/src/` — 前端代码不动

## 5. 数据库：MySQL 还是 SQLite？

**最终决策：MySQL**（用户确认保留）

但代码里 `db.js` 硬编码 `import from './db-mysql.js'`，且 better-sqlite3 只在 migration 脚本里用。生产环境 Docker 内走 MySQL，不改任何数据库代码。

### MySQL 内存调优（docker-compose 启动参数）

```
--innodb-buffer-pool-size=64M
--performance-schema=OFF
--skip-log-bin
--max-connections=30
--table-definition-cache=200
--table-open-cache=200
```

预计内存从 500MB → ~350MB。

## 6. Nginx + HTTPS

### SSL 证书方案

| 组件 | 说明 |
|---|---|
| 证书获取 | Certbot 安装在**宿主机**，DNS challenge（`lisheng666.xyz`） |
| 证书路径 | `/etc/letsencrypt/live/lisheng666.xyz/` |
| 挂载 | 只读 mount 到 nginx 容器 |
| 续期 | 宿主机 certbot systemd timer 自动续 |

### 首次获取证书（宿主机执行）

```bash
apt install -y certbot
certbot certonly --standalone -d lisheng666.xyz --agree-tos --email <your-email>
```

### Nginx 配置要点

```
# HTTP → HTTPS 重定向
server {
    listen 80;
    server_name lisheng666.xyz;
    return 301 https://$host$request_uri;
}

# HTTPS
server {
    listen 443 ssl;
    server_name lisheng666.xyz;
    ssl_certificate     /etc/letsencrypt/live/lisheng666.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lisheng666.xyz/privkey.pem;

    root /usr/share/nginx/html;
    
    location /assets/ { expires 1y; }
    location /api/   { proxy_pass http://backend:3000; }
    location /       { try_files $uri /index.html; }
}
```

## 7. 环境变量

### 生产 `.env`（服务器上手动创建 `server/.env`）

```env
# 服务端口
PORT=3000
NODE_ENV=production

# AI 提供商: cloud = DeepSeek + 智谱
AI_PROVIDER=cloud

# DeepSeek API (对话)
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_CHAT_MODEL=deepseek-chat

# 智谱 API (embedding + OCR)
ZHIPU_API_KEY=your-zhipu-api-key
ZHIPU_EMBEDDING_MODEL=embedding-2

# 数据库 (Docker 内)
DB_HOST=mysql
DB_PORT=3306
DB_NAME=smart_finance
DB_USER=finance
DB_PASSWORD=your-db-password

# Redis (Docker 内)
REDIS_HOST=redis
REDIS_PORT=6379

# Qdrant (Docker 内)
VECTOR_DB_URL=http://qdrant:6333

# RAG
RAG_ENABLED=true
RAG_COLLECTION=finance_records_nomic_v1
RAG_TOP_K=5

# JWT
JWT_SECRET=<随机生成64位字符串>

# 微信 (生产用真实值)
WECHAT_MINI_APPID=your-mini-appid
WECHAT_MINI_SECRET=your-mini-secret
```

## 8. 部署步骤

### 8.1 前置（宿主机）

```bash
# 1. 安装 Docker + Docker Compose
curl -fsSL https://get.docker.com | bash

# 2. 获取 SSL 证书
apt install -y certbot
certbot certonly --standalone -d lisheng666.xyz

# 3. 创建项目目录
mkdir -p /opt/smart-finance
```

### 8.2 部署

```bash
# 4. 上传代码到服务器
cd /opt/smart-finance
git clone <your-repo-url> .

# 5. 创建生产 .env
cp server/.env.example server/.env
# 编辑 server/.env 填入上述生产配置

# 6. 构建 + 启动
docker compose -f docker-compose.prod.yml up -d --build

# 7. 验证
curl https://lisheng666.xyz/api/health
```

### 8.3 Certbot 续期（自动）

```bash
# certbot 安装后自带 systemd timer，确认已启用
systemctl enable --now certbot.timer
```

## 9. 内存预算总表

| 项目 | 预估内存 |
|---|---|
| OS (Ubuntu 22.04) | 150 MB |
| Docker Engine | 80 MB |
| mysql 容器 | 350 MB |
| qdrant 容器 | 250 MB |
| backend 容器 | 250 MB |
| redis 容器 | 25 MB |
| nginx 容器 | 15 MB |
| **总计** | **~1,120 MB** |
| 剩余 | **~880 MB** |

安全余量充足，正常流量下不会 OOM。

## 10. 回滚方案

本地 `docker-compose.yml` 不修改，开发环境完全不受影响。
如需回滚服务器，只需停止生产容器，换回开发版 compose 即可。
