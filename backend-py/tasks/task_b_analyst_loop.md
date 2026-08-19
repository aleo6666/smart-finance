# 任务 B：CFP 分析 Agent 循环（受约束 ReAct + 分析工具补全）

你是 Smart Finance（backend-py，FastAPI + LangGraph Python 版）的实现工程师。项目当前 39 个测试文件全绿（任务 A 可能已合入，先 git pull/status 确认）。

## 现状（先读这些文件）
- `app/agents/graph.py`：单图 `inject_cfp_context → call_model → validate_tool → execute_tool → loop → persist_memory`；有 `agent_max_iterations=8`
- 现有分析工具：`analyze_financial_health`（7 维 0-100 评分）、`plan_financial_goal`（缺口/月存/可行性）——全确定性纯函数
- 证据链 V2.1：结论绑定真实账单行 `{text, recordIds}`，LLM 只准逐字引用，校验层丢弃编造
- `app/agents/state.py`：AgentState 含 messages/retrieved_context/used_tools/dataset_refs/iterations

## 目标
把"探索性财务分析"从单轮（评分→LLM 解读）升级为**受约束 ReAct 多轮循环**：LLM 自主决策分析路径、多轮深入，但只能调确定性工具取数、只能引用真实数据（证据链）。

## 交付点（具体）

### B1. `app/agents/nodes/analyst_loop.py`
- 受约束 ReAct 循环节点：`决策(LLM 选工具+参数) → 调确定性工具 → 观察结果 → 再决策`，≤5 轮（配置 `analyst_max_iterations`）
- **每轮 LLM 调用和工具调用都要 `asyncio.wait_for(timeout=settings.tool_timeout)`**，超时 → 兜底"分析超时，请缩小问题范围"
- 终止条件：LLM 输出 final 标记（结构化 JSON 含 `final: true` + 分析文本）或达到轮次上限 → 进入证据链校验
- 输出：`{"analysis": str, "dataset_refs": [...], "iterations": N}`，不进 messages（外置独立字段，防上下文膨胀）

### B2. 分析工具补全（全确定性，零 LLM 计算）
新建 `app/agents/tools/analysis_tools.py`，全部纯函数 + DB 查询：
- `get_ratio_analysis(user_id, ledger_id?)`：负债率/储蓄率/流动性比率/负债收入比/自由储蓄率（有真实数据才返回，无数据返回空+说明）
- `get_cashflow_trend(user_id, months=6)`：月度收入/支出/结余趋势
- `get_expense_breakdown(user_id, category?)`：支出结构（按类别聚合 + 占比）
- `simulate_scenario(user_id, adjustments)`：情景推演（如"每月多存 500"→ 结余变化，纯函数基于真实历史均值计算，明确标注"基于历史均值估算，非承诺"）
- 每个工具 description 套四要素公式（用途/边界/输入约束/禁忌场景），边界声明"不提供投资建议"

### B3. `app/agents/graph.py` 路由分支
- 新增 `analyst_loop` 节点；意图路由：分析类意图（health/ratio/trend/breakdown/scenario/analysis）→ `analyst_loop`；记账类 → 原 workflow（含任务 A 的确认策略）
- 分析路径终点统一过证据链校验：分析文本引用的数字必须能在 dataset_refs 找到，找不到 → 丢弃该句（或降级确定性模板）
- 保持 chat 契约 `{success, data:{message, source:"langgraph", intent, tools, sources}}`

### B4. `tests/test_analyst_loop.py` + `tests/test_analysis_tools.py`
- 多轮诊断：fake LLM 先决策调 `get_ratio_analysis`，观察后再决策调 `get_cashflow_trend`，第三轮 final → 断言 ≥2 次工具调用、分析文本含真实数字、dataset_refs 非空
- 轮次上限：fake LLM 永远不 final → 5 轮后熔断返回兜底
- 超时熔断：mock 工具挂起 → tool_timeout=0.5 内兜底
- 编造数字丢弃：分析文本含 dataset_refs 没有的数字 → 校验层丢弃该句
- 工具纯函数：ratio/trend/breakdown/scenario 用种子数据断言计算结果（Decimal 精度）

### B5. 配置新增
```python
analyst_max_iterations: int = Field(default=5, ge=1, le=10)
```

## 环境铁律
- git-bash，禁用 PowerShell 语法；`./.venv/Scripts/python.exe` 绝对路径跑测试
- 金额 Decimal(18,2)；分析工具零 LLM 依赖（LLM 只在 analyst_loop 的决策点）
- 向后兼容现有测试；新模块若涉及 DB session 参照现有工具注入写法
- 不要等待审批；不要问问题；写完立即跑对应测试贴真实输出

## 最终报告
文件清单 + 验收命令真实输出 + 遗留问题。若接近 max-turns 没跑完测试，直接交文件清单，测试由 QA 补跑。
