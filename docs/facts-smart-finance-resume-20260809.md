# Smart Finance 简历描述 · 事实素材（2026-08-09）

> 铁律：只允许使用本文件中的事实与数字。语言可自由组织，但不得超出、不得编造。
> 数字来源标注：`[实测]`=当天运行验证 / `[代码]`=源码可查 / `[文档]`=项目文档。

## 一、项目身份

| 项 | 值 |
|---|---|
| 名称 | Smart Finance（AI-Native 智能财务顾问 / 智能记账系统） |
| 时间 | 2025.06 - 至今（独立开发，全部代码个人完成） |
| 线上 | https://lisheng666.xyz（阿里云 ECS 2C4G，Docker Compose 7 容器，生产运行中） |
| 定位 | 从自然语言记账到财务健康评估的 AI Agent 产品 |

## 二、技术栈

LangGraph.js 1.4 + LangChain.js · Node.js 22 / Express / Knex · Vue 3 / Vite / Pinia / ECharts · MySQL 8 / Redis 7 / Qdrant（向量检索）· Zod / node-sql-parser · Docker Compose / Nginx · GitHub Actions CI · DeepSeek V4 / LM Studio Qwen 本地模型

## 三、核心机制（均有源码/文档依据）

### 1. LangGraph StateGraph 状态机 [代码]
- **12 节点 + 条件路由**：loadMemory → normalize（意图识别）→ compose → model（LLM 推理）→ validateToolCall → riskCheck → confirm（interrupt）→ toolNode → postTurnMemory → END
- 路由决策：无 tool_call 直接 END；有写操作走 risk_check（安全确认链）；只读走校验→执行
- AgentState 用 Zod Schema 定义，`userId/sessionId` 等可信字段仅由服务端注入（Trusted Runtime Context），模型无法伪造

### 2. 四层记忆架构 [代码]
- L1 会话元数据（Redis，单会话）：设备/时区/回复风格/最后活跃
- L2 用户长期记忆（MySQL，跨会话 CRUD）：消费习惯/理财目标/重要日期，工具显式写入需确认
- L3 近期摘要（每 turn 自动更新）：currentTopics / unfinishedTasks / analysisConclusions，LLM 生成结构化摘要
- L4 滑动窗口（LangGraph Checkpointer，Redis Stack 持久化）：最近 N 轮上下文，注入时自动去重，**跨容器重启可恢复** [代码+实测 2026-08-09 线上部署]
- contextLoader 四层**并行加载**（Promise.allSettled），单层失败自动降级不影响其他层
- Checkpointer 接入自检探针：Redis 无 RedisJSON 模块时自动回退 MemorySaver（优雅降级，不崩溃）[代码+实测]

### 3. 3-Agent 主从协同（与图并行的一套规则驱动系统）[代码]
- Master（调度）：规则驱动 5 种任务模式（simple_query / budget_analysis / period_comparison / category_analysis / comprehensive_analysis），生成 DAG 任务计划，依赖满足的步骤**按轮次并行分发**
- Retrieval（只读）：4 种检索（财务汇总 / 向量语义 RAG / 预算配置 / 分类统计）
- Calculator（纯函数无 IO）：5 种计算（预算执行/超支预警 / 周期环比同比 / 合规校验 / 分类占比）
- 关注点分离：检索 Agent 只读不计算，计算 Agent 无 IO，Master 只调度不碰业务

### 4. 三级安全防线 [代码]
- **L1 SQL AST 语法守卫**（admin_sql 工具）：① 原始文本过滤（分号/注释/sleep/benchmark/into outfile 直接拒绝）→ ② node-sql-parser AST 结构校验（仅允许 SELECT，禁子查询/UNION/CTE/窗口函数）→ ③ 表白名单（2 张 safe 视图）+ **自动注入 WHERE user_id=? 防越权** → ④ LIMIT 强制（19 个函数白名单 avg/sum/count/max/min/round…，最多 200 行）
- **L2 工具白名单 + Trusted Runtime Context**：模型传的可信字段直接拒绝
- **L3 敏感写操作 LangGraph interrupt()**：记账/改预算/改记忆/改交易 = 挂起图执行，等用户显式确认才继续（update_budget / confirm_user_memory / delete_user_memory / update_transaction）

### 5. 灰度架构（生产可验证的发布能力）[代码]
- 8 个 Feature Flag 纯环境变量开关（Agent 总开关 / 灰度比例 / 四层记忆 / 管理 SQL / PaddleOCR / Qdrant 知识库 / 账单向量写入）
- **SHA256(userId) 哈希分桶**：0-100% 任意放量，同一用户永远落同一桶
- 秒级回滚：关环境变量即可；Feature-Off 兼容测试 20/20 通过 [文档]

### 6. 模型输出容错 [代码]
- JSON 修复流水线：去注释 → 单引号转双引号 → 补键名引号 → 移除尾随逗号 → parse；兼容 ```json 代码块 / 裸 JSON / 嵌套参数

### 7. 企业级功能 [代码]
- 四级 RBAC（owner/admin/member/viewer）、中间件级全链路审计日志、CSV 导出（BOM 兼容 Excel 中文）
- Agent 可观测性：Token / 延迟 / 成功率指标（observeService）
- 邮箱验证码登录（Redis 原子限频 + SMTP，开发环境 000000 跳过）、收入自动识别、多账本 CRUD
- 财务顾问能力：0-100 健康评分（5 维度加权：储蓄率/收支平衡/预算执行率/消费结构）、目标规划（储蓄目标/大额消费可行性）、结构化建议
- RAG 知识库（Qdrant 向量）、PaddleOCR 票据识别、微信小程序端（miniprogram/）

## 四、量化证据（可写数字）

| 数字 | 来源 |
|---|---|
| 610 个自动化测试：609 通过 / 1 跳过 / 0 失败，15 个 suite，~20s 跑完 | [实测] 2026-08-09 |
| **Redis Stack Checkpoint 持久化：跨容器重启会话可恢复（ShallowRedisSaver + 探针自检降级）** | [实测] 2026-08-09 线上部署，backend 日志 Redis-backed |
| **线上 LangGraph Agent 100% 放量运行（ENABLE_LANGGRAPH_AGENT=true, ROLLOUT=100），chat 实测 source=langgraph** | [实测] 2026-08-09 |
| Agent 评估框架：22 个确定性用例 × 7 维度（record 4 / query 3 / analysis 2 / budget 3 / safety 4 / memory 2 / routing 4） | [代码] eval/cases.js |
| 12 节点状态图 + 条件路由 | [代码] graph.js |
| 四层记忆 | [代码] memory/ |
| 3 Agent 协同：5 任务模式 / 4 检索类型 / 5 计算类型 | [代码] services/ |
| SQL 守卫：2 张表白名单 / 19 函数白名单 / LIMIT 200 | [代码] sqlGuard.js |
| 8 个 Feature Flag，0-100% 哈希分桶，秒级回滚 | [代码] service.js |
| GitHub Actions CI：push/PR 触发，MySQL 8.4 + Redis 7 服务容器 + 全量测试 | [代码] .github/workflows/ci.yml |
| 7 容器 Docker Compose 生产部署，ECS 2C4G 运行中 | [文档] |

## 五、不写清单（无证据，禁止编造）

- ❌ 分类准确率 90% —— 无标注数据集与评估报告支撑（仅 22 个确定性用例）
- ❌ 300+ 标注数据 —— 项目内不存在该数据集
- ❌ LLM 调用量降低 80% —— 无基准测量
- ❌ Token 消耗降低 40% —— 无测量
- ❌ 任何用户数 / DAU / 线上调用量 —— 未统计
- ❌ "Supervisor 模式" —— 图是 StateGraph 条件路由，3-Agent 是规则驱动主从，不要贴错架构名词

## 六、写作要求（用户已确认的偏好）

1. 推倒重来：现有 v6 描述（附后）没有深度，不要沿用其表述，重新组织
2. 每条 bullet = 场景痛点 → 机制设计 → 量化收益，三要素缺一不可
3. 用机制名词体现架构理解（状态图条件路由 / 哈希分桶灰度 / interrupt 人机协同 / AST 守卫 / 关注点分离）
4. 实证态优先：测试 609/610、22 eval 用例、线上部署是面试官最认的证据
5. 标题格式：【平台名】·【项目定位】（如 "Smart Finance · AI-Native 智能财务顾问"），第一条 bullet 和末尾技术栈行都出现平台名
6. 4-6 条 bullet，中文，每条 2-3 行，可直接粘贴进 LaTeX 简历
7. 目标岗位：AI Agent / 大模型应用开发实习（广州/深圳），面试官看重 LangGraph 多 Agent 实战深度、安全工程素养、评估意识、企业级交付能力

## 附：v6 现有描述（仅作对比参考，不沿用）

```
Smart Finance · 基于 LangGraph 多 Agent 的智能财务系统（2025/06--至今，独立开发·已上线）
- 设计 12 节点 Supervisor 路由 + 混合 NLU 引擎解决财务 NLU 不确定性问题：日常场景关键词直接命中（零 LLM 调用），大额/模糊交易自动升级 DeepSeek 精判，300+ 标注数据上分类准确率超 90%，日常记账场景下 LLM 调用量降低 80%。
- 设计四层记忆架构应对长对话上下文衰减：滑动窗口（最近 K 轮）→ 会话摘要（超窗口自动压缩）→ Checkpointer（状态图持久化）→ Qdrant 向量检索（历史交易语义召回），每层独立存储引擎与 TTL，跨会话自动恢复上下文。
- 搭建三级安全防线防止 Agent 生成危险 SQL（AST 语法校验 → 表白名单 → LIMIT 强制限制，敏感操作需用户确认 LangGraph interrupt）+ 灰度兼容架构（Feature Flag + 分桶路由 + 自动降级，0-100% 放量，环境变量秒级回滚）。
- 实现企业级多租户体系（四级 RBAC：owner/admin/member/viewer、中间件级全链路审计日志、CSV 数据导出、Agent 运行指标监控）；610 个自动化测试覆盖核心业务，GitHub Actions CI/CD，Docker Compose 一行部署。
- 技术栈：LangGraph.js · Node.js/Express · Vue3 · MySQL 8 · Redis 7 · Qdrant · Docker Compose。
```
