# 李胜 — AI Agent 开发工程师（实习）

## 教育背景

**广州商学院 · 软件工程 本科** | 2023 - 2027

---

## 技术栈

| 类别 | 技能 |
|------|------|
| **AI/Agent** | LangGraph.js · LangGraph(Python) · Prompt Engineering · RAG (Qdrant) · Multi-Agent 协作 |
| **后端** | Node.js/Express · Python/FastAPI · MySQL · Redis |
| **前端** | Vue 3 · Vite · Element Plus |
| **LLM** | DeepSeek API · SiliconFlow Embedding · Ollama 本地部署 · vLLM (调研) |
| **工程化** | Docker Compose · GitHub Actions CI/CD · Let's Encrypt HTTPS · Nginx |
| **工具** | Git · Playwright · Ruff/ESLint · LM Studio |

---

## 项目经历

### 🔷 Smart Finance · 智能财务记账系统（企业级）
*独立开发 | 2025.06 - 至今 | https://lisheng666.xyz*

**LangGraph.js · Node.js · Vue 3 · MySQL · Redis · Qdrant · Docker**

- 基于 **LangGraph.js 构建 12 节点多 Agent 协作系统**，实现 NLU 意图识别→自动记账→RAG 知识检索→财务健康评估的全链路 AI 代理
- 设计**四层记忆架构**（窗口记忆 / 会话摘要 / 长期记忆 / Qdrant 向量检索），每个会话恢复完整上下文，Token 消耗降低 40%+
- 实现 **LLM + 关键词回退的混合 NLU 引擎**，大额交易通过 LLM 二次确认收入/支出分类，分类准确率 90%+
- 构建**企业级基础设施**：四级 RBAC 权限（owner/admin/member/viewer）、API 全链路审计日志、CSV 数据导出（BOM 兼容 Excel）、Agent 可观测性指标（Token/延迟/成功率）
- 掌握完整交付能力：**610 个自动化测试**、GitHub Actions CI/CD 流水线、Let's Encrypt HTTPS、Docker Compose 一行部署

### 🔷 cr-agent · CLI 代码审查 Agent
*独立开发 | 2026.08 | https://github.com/aleo6666/cr-agent*

**Python · LangGraph · Click · DeepSeek · Ollama · Ruff/ESLint**

- 基于 **Python LangGraph StateGraph 构建三 Agent 并行审查引擎**（Security/Logic/Style），Univers 管道设计：`git diff | cr-agent review`
- 实现**多 Provider 架构**：云端 DeepSeek → 本地 Ollama(Qwen) → 纯规则零 LLM 三级降级策略，支持 Python/JS/Go/Java 多语言代码风格检查
- 设计**审查预筛模式（scan）**，输出 JSON 可疑位置清单，为多 Agent 协作者节省 75% 深度审查 Token
- 自建评估体系：10 个真实 bug diff 测试集，以 DeepSeek 审查自身代码项目并发现 16 个问题，查准率评估驱动 prompt 迭代
- `pip install` 一键安装，GitHub 开源，面向 AI 编码 Agent（Claude Code / Codex）的审查外包工具

### 🔷 QClaw Agent · 公众号 RSS 聚合 Agent
*独立开发 | 2025*

**Node.js · Express · RSS Hub · WeChat API**

- 实现微信公众号内容自动抓取、RSS 聚合与 AI 摘要生成

---

## 关键能力

- **多 Agent 协作**：掌握 Supervisor/Worker 模式，熟悉 Agent 间通信、状态传递、错误隔离
- **Agent 评估**：理解查准率/查全率、回归测试集、LLM-as-judge 等评估方法论
- **企业级交付**：RBAC、审计追踪、CI/CD、可观测性 — 不只是 Demo，是可部署的产品
- **CLI-first 工具设计**：偏好 Unix 管道哲学，零 MCP 开销的 Agent 集成方式

---

## 自我评价

AI Agent 开发方向大三在读，有 2 个完整的 LangGraph Agent 项目（JS + Python 双语言），从架构设计到企业级部署全链路独立完成。追求「不只是跑通，而是能交付、可评估、经得起审查」的工程标准。正在寻找广州/深圳 AI Agent 实习机会，期望 2026 年 9 月后入职。

---

GitHub: github.com/aleo6666 · Email: 123456@qq.com
