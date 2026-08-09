# Smart Finance 项目简历描述（v2 · 2026-08-09 推倒重来版）

> 生成流程：探索项目（F:\projects\smart-finance）→ 实测测试 610/609/1/0 → 素材 facts-smart-finance-resume-20260809.md → ResumeTailor 专家重写 → 逐条数字验收。
> 事实依据见同目录 `facts-smart-finance-resume-20260809.md`（含「不写清单」）。

## 简历版（可直接粘贴，无标注）

**Smart Finance · AI-Native 智能财务顾问**（从自然语言记账到财务健康评估的 AI Agent 产品 · 2025.06 至今 · 独立开发 · 已上线 https://lisheng666.xyz）

1. 财务对话意图混杂（记账/查询/分析/改预算），若每轮直接让 LLM 调工具，误判即可能误写账目。为 Smart Finance 以 LangGraph.js 构建 12 节点 StateGraph 状态机 + 条件路由：无工具调用直接收尾、写操作强制走风险检查-确认链、只读操作校验后执行；AgentState 以 Zod Schema 约束，userId 等可信字段仅服务端注入（Trusted Runtime Context），模型无法伪造。路由正确性由评估框架 routing 维度 4 个确定性用例回归保障。

2. 对话一长模型就"失忆"，跨会话还会丢掉用户消费习惯与财务目标，是财务 Agent 的典型痛点。设计四层记忆架构：Redis 会话元数据、MySQL 跨会话长期记忆（工具显式写入需确认）、每 turn 自动更新的 LLM 结构化摘要、Redis Stack 持久化 Checkpoint 滑动窗口（跨容器重启自动恢复，接入探针自检：RedisJSON 缺失时优雅降级内存）；contextLoader 以 Promise.allSettled 四层并行加载，单层故障自动降级、互不影响。记忆恢复行为由评估框架 memory 维度 2 个用例验证，持久化已在线上部署实测生效。

3. 单一 Agent 既检索又计算还调度，职责混杂、难以测试与扩展。设计 Master/Retrieval/Calculator 三 Agent 主从协同：Master 规则驱动 5 种任务模式生成 DAG 任务计划、依赖满足的步骤按轮次并行分发；Retrieval 只读不计算（4 种检索：财务汇总/向量 RAG/预算配置/分类统计），Calculator 纯函数无 IO（5 种计算：预算执行/环比同比/合规校验/分类占比），实现关注点分离。分析-预算链路由评估框架 analysis、budget 维度共 5 个用例覆盖。

4. 财务数据敏感，LLM 直出 SQL 查库存在注入与越权风险。搭建三级安全防线：L1 原始文本过滤（分号/注释/危险函数直接拒绝）→ node-sql-parser AST 结构校验（仅 SELECT，禁子查询/UNION/CTE/窗口函数）→ 2 张表白名单 + 自动注入 WHERE user_id 防越权 + LIMIT 200 上限（19 个函数白名单）；L2 工具白名单 + Trusted Runtime Context；L3 记账/改预算/改记忆/改交易等敏感写操作经 LangGraph interrupt() 挂起图执行，等待用户显式确认才继续。安全行为由评估框架 safety 维度 4 个用例回归。

5. PaddleOCR、Qdrant 知识库等新能力全量上线风险高、出问题难快速止血。落地 8 个 Feature Flag 纯环境变量开关，以 SHA256(userId) 哈希分桶实现 0-100% 任意放量、同一用户永远落同一桶；关闭环境变量即秒级回滚，并保留全功能关闭的兼容模式专项回归。Smart Finance 以 7 容器 Docker Compose 部署于阿里云 ECS 生产运行，LangGraph Agent 路径已 100% 放量（chat 实测 source=langgraph）。

6. LLM 输出不确定、回归保障薄弱是个人项目通病，难以支撑企业级交付。建立双层质量体系：610 个自动化测试（609 通过 / 1 跳过 / 0 失败，15 个 suite，约 20s 跑完）+ 22 个确定性 eval 用例 × 7 维度（意图/查询/分析/预算/安全/记忆/路由）；GitHub Actions CI 于 push/PR 时以 MySQL 8.4 + Redis 7 服务容器跑全量测试；配套四级 RBAC、中间件级全链路审计日志、CSV 导出与 Token/延迟/成功率可观测等企业级能力。

**技术栈**：Smart Finance 基于 LangGraph.js 1.4 + LangChain.js · Node.js 22 / Express / Knex · Vue 3 / Vite / Pinia / ECharts · MySQL 8 / Redis 7 / Qdrant（向量检索）· Zod / node-sql-parser · Docker Compose / Nginx · GitHub Actions CI · DeepSeek V4 / LM Studio Qwen 本地模型

## 审计版（带数字来源标注）

同 ResumeTailor 原始产出（deleg_556f6e8d）：每条 bullet 内联 [实测]/[代码]/[文档]，见会话记录；验收自检 6/6 通过，禁用数字 0 出现。

## 岗位信号映射（面试官为什么吃这套）

| # | 岗位信号 | 对比 v6 的改进 |
|---|---|---|
| 1 | LangGraph 实战深度 | v6 贴错"Supervisor 路由"架构名词（已禁）；本版明确 StateGraph 条件路由三种走向 + Zod + Trusted Runtime Context |
| 2 | 记忆工程 | v6 把 Qdrant 混入记忆层（实为独立 RAG 知识库）；本版还原四层 + 并行加载降级 |
| 3 | 多 Agent 编排 | v6 完全没写 3-Agent 主从；本版展开 DAG 并行分发 + 职责边界（关注点分离） |
| 4 | 安全工程素养 | v6 一句带过；本版三级防线完整细节 + interrupt 确认清单 |
| 5 | 生产部署能力 | v6 一句带过；本版 SHA256 分桶原理 + 秒级回滚 + 7 容器线上实例 |
| 6 | 评估意识 + 企业级 | v6 只写"610 个测试"；本版给全实测数字 + 22×7 eval + CI 细节 + RBAC/审计/可观测 |

## 使用建议

- LaTeX cventry 结构：标题 = "Smart Finance · AI-Native 智能财务顾问"，位置行 = "独立开发 · 已上线 lisheng666.xyz"，日期 = 2025/06--至今
- 6 条 bullet 偏长（约 3 页风险），若压缩：bullet 3 与 6 可合并，或每条压 15-20 字
- 严禁重新引入：90% 准确率 / 300+ 标注 / 80% 调用量 / 40% token（无证据）
