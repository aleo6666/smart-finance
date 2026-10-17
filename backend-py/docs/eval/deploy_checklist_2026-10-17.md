# Smart Finance 修复部署与复测清单

日期：2026-10-17
范围：`backend-py` 本轮 P0/P1/P2 修复
本地状态：**349 passed / 0 failed / 0 errors**
生产状态：**已部署（2026-10-17 15:40 CST）**，线上匿名访问 10 个受保护 GET 全部 401

> 实际部署记录见 `docs/eval/deploy_record_2026-10-17.md`。生产后端没有源码仓库，走的是镜像热更新；本清单第 1 节的 `git pull` 路径不适用于这台服务器，保留作通用参考。

> 本轮没有数据库结构变更，不需要跑 Alembic migration。
> 不要在生产上执行删除类复测；跨用户删除已经由本地测试覆盖。

## 1. 部署前确认

在服务器上先确认实际运行的 Compose 项目，不要凭记忆敲路径：

```bash
docker compose ls
cd /opt/smart-finance        # 以 docker compose ls 显示的实际目录为准
pwd
git status --short
git log -1 --oneline
```

确认后端是 Python 版（`backend-py`），不是旧 Node 版：

```bash
docker compose ps
curl -s http://127.0.0.1:3000/api/health
# 期望包含：智能财务记账助手服务运行中
```

备份数据库和当前镜像信息：

```bash
mkdir -p /opt/smart-finance/backups
# 变量从实际 compose 环境读取，不要把密码打印到终端历史
docker compose exec -T mysql sh -c \
  'exec mysqldump -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
  > backups/mysql-before-20261017.sql
docker compose ps > backups/compose-before-20261017.txt
git rev-parse HEAD > backups/git-before-20261017.txt
```

## 2. 上传并构建

把本地已验证的 `backend-py` 代码同步到服务器。若服务器是 git 部署：

```bash
cd /opt/smart-finance
git fetch --all
git log --oneline HEAD..origin/deploy-dist   # 先看要上哪些提交
git pull --ff-only origin deploy-dist
```

如果服务器访问 GitHub 不通，用 `deploy_20261017/` 下的离线包（本地已生成并校验）：

```bash
# 本机上传（二选一）
scp deploy_20261017/smart-finance-deploy-20261017.bundle <user>@<server>:/opt/smart-finance/       # 41K，增量，需服务器已有 99d1592
scp deploy_20261017/smart-finance-deploy-full-20261017.bundle <user>@<server>:/opt/smart-finance/  # 46M，全量，任何状态可用
# 服务器
cd /opt/smart-finance
git bundle verify smart-finance-deploy-full-20261017.bundle
git pull smart-finance-deploy-full-20261017.bundle HEAD
```

本次发布提交：`f7b4be9`（`deploy-dist` 分支，领先 `origin/deploy-dist` 4 个提交）。

只重建后端，避免误重启 MySQL / Qdrant：

```bash
cd backend-py
docker compose up -d --build backend
docker compose ps
docker compose logs --tail=100 backend
```

> 如果生产使用的是根目录 compose + nginx，先确认 nginx 的 upstream 指向
> Python 后端容器，再执行对应的 backend 重建；不要在没确认前重建整个栈。

## 3. 健康检查

```bash
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:3000/api/health/ready
# ready 必须是 status=ready，mysql/qdrant 都为 true
```

如果健康检查失败，先看日志，不要继续做业务复测：

```bash
docker compose logs --tail=200 backend
```

## 4. 线上只读复测

在本机 `backend-py` 目录运行；账号密码只放在环境变量里，不写入文件、不贴到聊天：

```bash
cd F:/projects/smart-finance/backend-py
SMART_FINANCE_BASE=https://lisheng666.xyz \
SMART_FINANCE_EMAIL='<demo账号>' \
SMART_FINANCE_PASSWORD='<密码>' \
.venv/Scripts/python.exe scripts/probe_online_after_deploy.py
```

脚本检查这些硬条件：

| 检查 | 期望 |
|---|---|
| `/api/health`、`/api/health/ready` | 200 / ready |
| 无 token 访问 financial、analysis、knowledge、reports、records | **全部 401** |
| 登录 | 200，拿到 token 和 userId |
| 带 token 传 `user_id=999999` 查 financial | 返回体 `user_id` 仍是 token 用户 |
| `2026年8月餐饮支出是多少？` | intent 是 query/analysis，**不是 record** |
| 同一句查询 | `sources` 非空 |

脚本会向 demo 账号写一条会话历史，这是唯一副作用；不写账单、不改数据。

## 5. 手工补充检查

```bash
# 1) 无 token 必须 401
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://lisheng666.xyz/api/financial/overview?user_id=14'

# 2) 带 token 的越权参数必须被忽略
#    先登录拿 token，再执行；响应里的 user_id 应等于 token 用户
curl -s -H "Authorization: Bearer <token>" \
  'https://lisheng666.xyz/api/financial/overview?user_id=999999'

# 3) 知识库无 token 必须 401
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://lisheng666.xyz/api/knowledge/documents?user_id=14'
```

不要在生产做“用户 A 删除用户 B 的文档”测试；本地 `test_knowledge.py`
已覆盖：跨用户删除返回 404，文档仍然存在。

## 6. 前端兼容确认

这些接口现在只认 Bearer token：

- `/api/financial/*`
- `/api/analysis/*`
- `/api/reports` 旧版 generate/history/detail
- `/api/knowledge/*` 全部

部署后如果前端出现 401，先查请求是否带 `Authorization`，不要先怀疑后端。
知识库上传的 `space_id` 现在必须是正整数；传 `0` 会返回 422（禁止私人文档
塞进公共空间）。

## 7. 回滚

本轮只改代码，不改表结构：

```bash
cd /opt/smart-finance
git checkout <部署前commit>
cd backend-py
docker compose up -d --build backend
```

不需要回滚数据库。会话历史会多一条探针消息，可忽略；不要为了清这一条去动
生产数据。

## 8. 本次验收结果（2026-10-17 已完成）

1. `docs/eval/online_verify_2026-10-17.md` 已改为“已部署并复核”。
2. 复测时间 2026-10-17 15:40 CST；镜像 `smart-finance-py-backend:20261017`；10 个受保护 GET 匿名访问全部 401。
3. 简历只写到“token 身份作用域 + 生产匿名访问 401 + Agent 工具层越权拦截 5/5”；**未**写“多租户隔离已通过”。
4. 跨用户 token 复测和前端登录回归仍待补，见 `value_proof` 的限制表。
