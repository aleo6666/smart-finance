# 任务 A：记账写入能力（create_record + 确认策略 + 五层校验）

你是 Smart Finance（backend-py，FastAPI + LangGraph Python 版）的实现工程师。项目当前 39 个测试文件全绿。

## 现状（代码级核实，先读这些文件）
- `app/api/records.py:68` `RecordCreate` schema 已存在：type/category/amount(Decimal)/currency/ledger_id/note/occurred_at/income_source
- `app/agents/graph.py:291-294`：agent 工具集全部只读（query_transactions / search_similar_records / search_knowledge_base / analyze_financial_health / plan_financial_goal）——**没有写工具**
- 图结构：`inject_cfp_context → call_model → validate_tool → execute_tool → loop → persist_memory`，无 interrupt
- `app/core/config.py`：有 rag_top_k/rag_rerank_top_k/agent_max_iterations(8)/summary_threshold(20)，无记账确认阈值、无超时配置

## 目标
1. 新增 create_record 写工具，agent 能真正记账
2. 确定性确认策略：小额直通、大额/歧义/新类别走 interrupt 人工确认
3. 补齐五层校验：schema / 参数补齐 / 权限 / **幂等** / 结果校验
4. 规划执行闭环补"单次执行超时"（三道保险第 2 道）
5. 全部工具 description 套四要素公式

## 交付点（具体）

### A1. `app/agents/tools/create_record.py`
- 工具名 `create_record`，参数：type/category/amount/currency/ledger_id/note/occurred_at + 强制 user_id（schema 缺 user_id 直接拒绝，与现有 validate_tool 约定一致）
- **幂等**：新增 `idempotency_key` 参数（可选，缺省 = sha256(user_id + amount + category + note + occurred_at) 前 16 位）；写前查 Transaction 表是否已有同 key 记录（新增 `idempotency_key` 列 + 索引），有则返回已有记录（不重复写）；时间窗内重复调用只落一笔
- 复用 RecordCreate 的校验逻辑（金额 Decimal 正数、type 枚举、income_source 枚举）
- 返回结构化 `{content, context, dataset_refs}`（context 可空，dataset_refs=[{record_id, amount, category, occurred_at}]）

### A2. `app/agents/nodes/confirm_policy.py`
- 纯函数 `confirm_required(draft: dict, settings) -> bool`：
  `amount > record_confirm_threshold OR category ∉ confirm_fast_categories OR 命中 confirm_ambiguous_words(在 note 里) OR category 为该用户首次出现`
- 首次出现判断需要 DB 查询（同 user_id 同 category 是否已有记录）
- 返回 `{"confirm_required": bool, "reason": str|None}`

### A3. `app/agents/graph.py` 改造
- 挂载 create_record 工具
- **超时**：call_model 和 execute_tool 内用 `asyncio.wait_for(..., timeout=settings.tool_timeout)`，超时 → 返回兜底（"处理超时，请重试"）；loop 节点已有 max_iterations 熔断
- **写入分支**：execute_tool 结果含 `confirm_required=True` 的写操作 → 走 `human_approval` 节点（`interrupt()`，LangGraph v1.x 语义：invoke 返回带 `__interrupt__` 的 dict，恢复用 `Command(resume=...)`）；`confirm_required=False` → 直接落库
- 确认后 resume 时重新执行落库（幂等键保证不重复）
- 保持现有 `{success, data:{message, source:"langgraph", intent, tools, sources}}` 契约

### A4. `app/core/config.py` 新增
```python
record_confirm_threshold: Decimal = Field(default=200)  # 大额确认阈值
confirm_fast_categories: list[str] = ["餐饮", "交通", "日用品", "娱乐", "医疗"]  # 小额直通白名单
confirm_ambiguous_words: list[str] = ["报销", "分期", "借款", "预付", "押金"]  # 歧义词触发确认
tool_timeout: float = Field(default=30.0)  # 单次 LLM/工具调用超时秒数
```

### A4b. 缓存 key 规范化（视频评审项）
若代码中有缓存（CFP 上下文/检索结果/rerank），key 统一为 `user_id:tool_id:params_hash`，值带 `{"ttl": ..., "version": 1}`；无现有缓存则跳过，不新造缓存。

### A5. 全部工具 description 四要素公式重写
每个工具 description 按：**用途（做什么）→ 边界（不做什么）→ 输入约束（参数要求）→ 禁忌场景（什么时候别用）**。
涉及：query_transactions / search_similar_records / search_knowledge_base / analyze_financial_health / plan_financial_goal / create_record。参考：create_record 禁忌"金额≤0 拒绝、重复提交幂等、不提供投资建议"。

### A6. `tests/test_idempotency.py`
- 同一输入连续调用 create_record 2 次 → 只落 1 笔，返回相同 record_id
- 不同 note 同金额 → 落 2 笔
- 幂等 key 显式传入相同 → 只落 1 笔

### A7. `tests/test_confirm_policy.py`
- 阈值边界：199 直通 / 200 确认 / 201 确认
- 白名单类别小额直通；非白名单小额 → 确认
- note 含"报销"→ 确认；含"午餐"→ 直通
- 用户首次记录某类别 → 确认；已有记录 → 按金额规则
- 超时：mock llm_client 挂起（sleep 60）→ 30s（测试用 tool_timeout=0.5）内兜底返回

## 环境铁律
- git-bash 环境，禁用 PowerShell 语法（不要用 activate）
- 用 `./.venv/Scripts/python.exe` 绝对路径跑测试
- 不要等待审批，直接执行命令跑测试；不要问问题
- 金额一律 Decimal(18,2)，禁止 float
- 向后兼容：现有 39 个测试文件不得破坏（新功能只增不改旧行为）
- 新路由/工具模块若涉及 DB session 注入，参照现有工具写法；测试 conftest 用 dependency_overrides 模式

## 工作方式
写完立即用 `./.venv/Scripts/python.exe -m pytest tests/test_idempotency.py tests/test_confirm_policy.py tests/test_agent_graph.py tests/test_chat.py -q` 跑对应测试贴真实输出。
最终报告：文件清单 + 验收命令真实输出 + 遗留问题。
若接近 max-turns 还没跑完测试，直接报告已写文件清单，测试由 QA 补跑。
