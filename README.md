# Smart Finance · AI-Native 智能财务顾问

[![部署状态](https://img.shields.io/badge/status-online-brightgreen)](http://8.163.84.206)
[![Python](https://img.shields.io/badge/Python-3.11-3776AB)](https://www.python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-009688)](https://fastapi.tiangolo.com)
[![LangGraph](https://img.shields.io/badge/LangGraph-1.x-blue)](https://github.com/langchain-ai/langgraph)
[![测试](https://img.shields.io/badge/tests-349%2F349-brightgreen)](#)
[![许可证](https://img.shields.io/badge/license-Unlicensed-red)](#)

基于 LangGraph 的 AI-Native 智能财务顾问——从自然语言记账到财务健康评估，从**受约束自主体 + 反思闭环 + 证据链**到四类跨会话记忆，从本地开发到 Docker 灰度部署的全链路实现。

线上地址：https://lisheng666.xyz

---

## 功能概览

### 智能记账
- 自然语言输入，Hybrid 意图路由（LLM + 确定性关键词双通道，低置信反问澄清）
- LLM 提取凭证要素 → 确定性确认策略（小额直通 / 大额与新分类人工确认）
- 写操作经 LangGraph interrupt 挂起，用户显式确认后落库；幂等键防重复记账

### 账单查询与分析
- 今日/本月/上月/分类明细/最大单笔/平均消费
- 月度报表、分类占比、趋势分析
- RAG 语义检索（Qdrant 向量库 + 混合检索）

### 🆕 智能财务顾问（分析师）
- **受约束 ReAct 循环**：模型自主决定「再取数 or 给结论」，最多 5 轮（`analyst_loop`）
- **反思闭环（Critic）**：生成结论后由审计模型自检——答非所问 / 超出数据推断 / 空泛套话将被打回重写（最多 2 轮），全程 `critique_log` 可追溯
- **证据链校验**：分析中每个数字必须来自真实取数结果（`dataset_refs`），无据句子整句丢弃，模型无法捏造
- 财务健康评分（5 维度）、目标规划、情景推演、月度体检

### Agent 架构
- LangGraph 状态机：Hybrid 意图路由 → 记账确定性工作流 / 分析 ReAct 循环 / 对话注入 CFP 真实数据
- 长期记忆：规则 / 目标 / 偏好三类事实 + 向量化检索（Qdrant + MySQL），工具显式写入需确认
- 受约束自主性：模型只拥有工具执行权与决策权，所有写操作经确认、所有数字经证据校验；工具调用经 Pydantic Schema 校验，并由服务端 token 注入当前用户，模型无法伪造身份
- 确定性领域计算：预算执行 / 环比 / 占比 / 评分等纯函数实现，LLM 不做算术

### 安全控制（Agentic Security）
- JWT 鉴权 + 工具级授权（每个工具强制注入 user_id，模型无法伪造）
- 敏感写操作 human-in-the-loop（LangGraph interrupt 人工确认）
- 幂等键 + 确定性写入执行器防重复提交

---

## 技术栈

| 层级 | 技术 |
|------|------|
| Agent 框架 | LangGraph 1.x + LangChain Tools（Python） |
| 后端 | FastAPI + SQLAlchemy 2.0（Async） |
| 数据库 | MySQL 8.4 / Qdrant（向量检索） |
| 前端 | Vue 3 / Vite |
| 模型 | DeepSeek V4（对话/分析/审计）|
| 部署 | Docker Compose / Nginx / 阿里云 ECS |
| 测试 | pytest 349 用例（51 文件） |

---

## 快速开始

```bash
# 1. 配置（backend-py）
cp backend-py/.env.example backend-py/.env.local

# 2. 启动（MySQL + Qdrant + 后端）
docker compose up -d

# 3. 验证
curl http://localhost:8000/api/health/ready
```

---

## 开发命令

```bash
cd backend-py
./.venv/Scripts/python.exe -m pytest tests/ -q        # 全量 349 用例（约 3.5 分钟）
./.venv/Scripts/python.exe -m pytest tests/test_analyst_loop.py tests/test_critic_integration.py -q   # 分析+自检专项
```

---

## 项目结构

```text
backend-py/app/
├── agents/                 # LangGraph 状态机
│   ├── graph.py            # 图构建 + 路由 + 工具循环
│   ├── nodes/
│   │   ├── intent_router.py    # Hybrid 意图路由（LLM+规则，低置信澄清）
│   │   ├── analyst_loop.py     # 分析师 ReAct 循环 + Critic 反思闭环 + 证据链
│   │   ├── record_draft.py     # 记账提取 + 确定性工作流
│   │   ├── cfp_node.py         # 财务顾问上下文注入
│   │   ├── memory_node.py      # 跨会话长期记忆
│   │   └── confirm_policy.py   # 写操作确认策略
│   └── tools/              # 记账/查询/分析/知识库/OCR 工具（Pydantic 校验 + token 用户上下文）
├── api/                    # FastAPI 路由（20+ 业务域）
├── core/                   # 配置 / LLM 客户端
├── models/                 # SQLAlchemy
└── tests/                  # 349 用例
```

---

## 许可证

当前仓库未声明开源许可证。公开使用、分发或二次开发前请先补充。
