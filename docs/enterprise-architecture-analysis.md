# Smart Finance → 企业财务平台架构分析

> 作者：AI 架构师（基于 Smart Finance 代码库深度分析）
> 日期：2026-08-10
> 版本：v1.0

---

## 目录

1. [现有架构评审](#1-现有架构评审)
2. [目标场景分析](#2-目标场景分析)
3. [推荐架构](#3-推荐架构)
4. [MVP 方案](#4-mvp-方案)

---

## 1. 现有架构评审

### 1.1 双层架构的实际情况

Smart Finance 当前维护了**两套并行的 Agent 系统**：

| 层 | 系统 | 定位 |
|---|------|------|
| 上层 | LangGraph 12 节点 StateGraph | AI-Native Agent，LLM 决策 + 工具调用 |
| 下层 | 3-Agent 主从协同（实际已扩展为 5 Agent） | 规则驱动，Master → Retrieval / Calculator / Analyst / CFP |

这两套系统通过 `use3Agent` 参数灰度切换，说明团队自己也意识到它们之间存在**功能重叠**。

### 1.2 第一性原理分析：3-Agent 架构是否过度设计？

#### 从"用户需要什么"出发

个人财务记账用户的核心需求只有 4 个：

```
记账（我说一句话，系统记一笔）
  → 需要：NLU → 结构提取 → DB INSERT

查账（本月花了多少？餐饮多少？）
  → 需要：NLU → SQL SELECT → 结果格式化

分析（预算还剩多少？跟上月比呢？）
  → 需要：NLU → 2-3 次 SQL → 确定性计算 → 自然语言呈现

建议（我该怎么省钱？）
  → 需要：（同上）+ LLM 文本生成
```

#### 3-Agent 实际在做什么

```
Master Agent（masterAgent.js 679 行）
  ├── detectTaskPattern() — 30 行正则匹配，识别 7 种模式
  ├── buildTaskPlan() — 每种模式生成一个 DAG 步骤列表
  └── executeTasks() — 按依赖关系串行/并行调用子 Agent

Retrieval Agent（retrievalAgent.js 196 行）
  ├── retrieveFinanceSummary() — 调用 financeQuery.js 做 SQL 查询
  ├── retrieveVectorRecords() — 调用 vectorMemory.js 做 RAG
  ├── retrieveBudgetConfig() — SQL 查预算表
  └── retrieveCategoryStats() — SQL 查分类统计

Calculator Agent（calculatorAgent.js 338 行）
  ├── calculateBudgetExecution() — 纯 JS 计算预算剩余/超支
  ├── calculatePeriodComparison() — 环比/同比
  ├── calculateCategoryRatio() — 占比计算
  └── calculateSpendingTrend() — 简单线性回归
```

#### 诚实判断

**问题 1：Master Agent 的正则匹配是 Chomsky 1 型语法能解决的吗？**

不能。正则无法真正"理解"用户意图。"帮我看看上个月餐饮和交通的对比"需要上下文理解和多意图拆解，正则只能处理最表层的模式匹配。`/(对比|比较|环比|同比|上月|上个月|去年)/.test(text)` 这种匹配在`"我上个月没对比过"`时也会触发。虽然可以通过更复杂的模式迭代修复，但这本质上是在用正则模拟 LLM 的能力——这正是 LangGraph Agent 已经做好的事情。

**问题 2：Retrieval Agent 和 Calculator Agent 的分离有意义吗？**

有意义，但被实现削弱了。

- **Retrieval 只读不计算**：这是正确的约束。但在实现中，`retrieveFinanceSummary()` 已经在做聚合（count、total、average），这已经是"计算"了。
- **Calculator 纯函数无 IO**：这也是正确的约束。但在实现中，calculator 并未真正独立——它的输入完全依赖 retrieval 的输出，耦合度极高。
- **实际效果**：对于个人记账场景，99% 的查询不需要"检索→计算"两步——单次 SQL 就能完成。`SELECT SUM(amount) FROM records WHERE user_id=? AND month=?` 既是检索也是计算。

**问题 3：3-Agent 相比 LangGraph 单 Agent + 工具，真优势在哪？**

| 维度 | LangGraph 单 Agent + 工具 | 3-Agent 主从协同 | 胜出 |
|------|--------------------------|------------------|------|
| 意图理解准确性 | ⭐⭐⭐⭐⭐ LLM 原生 | ⭐⭐ 正则+规则 | LangGraph |
| 工具调用灵活性 | ⭐⭐⭐⭐⭐ LLM 决策 | ⭐⭐ 硬编码 DAG | LangGraph |
| 计算确定性 | ⭐⭐ 依赖 LLM 调用 | ⭐⭐⭐⭐⭐ 纯 JS 函数 | 3-Agent |
| 延迟 | ⭐⭐⭐ LLM 调用 | ⭐⭐⭐⭐ 规则驱动 | 3-Agent |
| 可审计性 | ⭐⭐ 黑盒决策 | ⭐⭐⭐⭐ 明确步骤 | 3-Agent |
| 维护成本 | ⭐⭐⭐⭐ Prompt 驱动 | ⭐⭐ 正则+DAG 二维维护 | LangGraph |

**结论**：

1. **在个人财务场景下，3-Agent 是过度设计**。一个 LangGraph Agent + 确定性工具函数（不经过 LLM 的计算）就能完全覆盖，且意图理解更准确。

2. **但 3-Agent 的分离思想（检索/计算/调度）是对的**——它只是在错误的场景（个人财务）用错了实现方式（正则调度）。

3. **真正的价值在 LangGraph 架构**：12 节点 StateGraph 的三级安全防线、四层记忆、Operation Store 的幂等机制、Trusted Runtime Context——这些都是企业级质量的工程实现。

### 1.3 值得保留的资产

| 资产 | 企业价值 | 理由 |
|------|----------|------|
| LangGraph StateGraph 骨架 | ⭐⭐⭐⭐⭐ | 条件路由 + interrupt + checkpointer 是企业 Agent 的黄金架构 |
| SQL AST 守卫 | ⭐⭐⭐⭐⭐ | `node-sql-parser` 的 AST 级校验直接可用于企业安全 |
| Operation Store（幂等） | ⭐⭐⭐⭐⭐ | `claim → execute → succeed/fail` 模式是企业事务的核心 |
| Trusted Runtime Context | ⭐⭐⭐⭐⭐ | `userId` 等字段服务端注入，不可伪造——企业合规必需 |
| 四层记忆 | ⭐⭐⭐ | L2（长期记忆）和 conversation_summaries 对企业有意义 |
| Feature Flag 体系 | ⭐⭐⭐⭐ | 灰度开关可用于企业功能的分批上线 |
| 609 测试 + 22 Eval | ⭐⭐⭐⭐ | 测试基础设施无需重建 |
| 3-Agent DAG 思想 | ⭐⭐⭐ | 检索/计算分离的思想可升级为企业架构的基础 |

### 1.4 应该抛弃的

| 资产 | 原因 |
|------|------|
| 正则驱动的 Master Agent | 企业意图复杂度远超正则能处理的，必须用 LLM |
| 3-Agent 硬编码 DAG | 企业业务流程多变，DAG 维护成本随业务指数增长 |
| CFP/Financial Analyst Agent | 面向个人的理财建议，与企业管理无关 |
| 个人财务健康评分 | 企业关注的是会计准则合规性，不是"你得了 85 分" |

---

## 2. 目标场景分析

### 2.1 岗位工作流分析

#### 通用岗

##### 会计（记账/凭证/报表）

```
核心工作流：
  [原始凭证] → [填制记账凭证] → [登记明细账] → [月末结转] → [编制报表]

技术特征：
  - 复式记账（借/贷）：每笔交易必须平衡
  - 会计科目体系：严格的层级编码（1001 现金 / 1002 银行存款 / 6601 销售费用...）
  - 会计期间：月结/年结不可跳过，期间一旦关账不可修改
  - 凭证编号：连续、不可跳号
  - 报表：资产负债表（BS）、利润表（IS）、现金流量表（CF）

LLM Agent 适合：✅ 凭证摘要生成（从原始文本提取摘要）、异常分录检测
确定性引擎必需：✅ 复式记账平衡校验、科目编码校验、期间关账锁定、BS/IS/CF 生成
```

##### 出纳（收付款/银行对账）

```
核心工作流：
  [收款通知] → [确认入账] → [登记银行日记账]
  [付款申请] → [审核] → [支付] → [登记银行日记账]
  [银行流水] → [与日记账对账] → [余额调节表]

技术特征：
  - 银行流水导入（CSV/OFX/电子回单）
  - 对账匹配：金额+日期+摘要模糊匹配
  - 未达账项管理

LLM Agent 适合：✅ 银行流水摘要解析、对账匹配中的模糊判断
确定性引擎必需：✅ 金额匹配计算、对账结果汇总
```

##### 财务分析（预算/成本/毛利分析）

```
核心工作流：
  [设定预算] → [实际数据采集] → [预算-实际对比] → [差异分析] → [建议报告]

技术特征：
  - 预算编制：部门×科目×期间三维度
  - 多维分析：同比/环比/预算完成率/结构比
  - 成本核算：直接材料/人工/制造费用的归集与分配

LLM Agent 适合：✅ 差异原因分析（"销售费用超预算 20%，主要原因..."）
确定性引擎必需：✅ 所有数值计算（预算完成率、同比、成本分摊）
```

##### 融资（贷款/授信管理）

```
核心工作流：
  [融资需求] → [授信申请] → [贷款合同] → [提款/还款] → [利息计算] → [到期管理]

技术特征：
  - 利息计算：等额本息/等额本金/到期还本
  - 授信额度：总额度-已用额度=可用额度
  - 到期预警：按日期自动提醒

LLM Agent 适合：⚠️ 部分适合（合同条款解读），但金融合规要求高
确定性引擎必需：✅ 利息计算（日计息，精度到分，四舍五入规则固定）
```

##### 内审（合规检查/异常检测）

```
核心工作流：
  [规则库] → [数据抽样] → [规则匹配] → [异常标记] → [审计报告]

技术特征：
  - 规则引擎：金额阈值、频率异常、权限越界、科目错用
  - 抽样策略：全量/重要性/随机

LLM Agent 适合：✅ 异常原因解释、非结构化数据的审计发现
确定性引擎必需：✅ 规则匹配、统计抽样
```

#### 涉外岗

##### 跨境核算（多币种/合并报表）

```
核心工作流：
  [各币种交易] → [按交易日汇率折算] → [重估（期末汇率）] → [合并抵消] → [合并报表]

技术特征：
  - 多币种：CNY/USD/EUR/JPY/GBP 等
  - 汇率类型：即期汇率、期末汇率、平均汇率
  - 汇兑损益：每笔外币交易在期末重估时产生
  - 合并抵消：内部交易、内部债权债务

LLM Agent 适合：⚠️ 不适合做计算，可做报表文字说明
确定性引擎必需：✅ 汇率换算（精度、四舍五入规则）、合并抵消分录、汇兑损益计算
```

##### 国际税务（转让定价/VAT/GST）

```
核心工作流：
  [跨境交易识别] → [适用税率匹配] → [税务计算] → [申报表生成]

技术特征：
  - 税种：增值税/企业所得税/关税/预提税...
  - 税率：国家×税种×商品类别，变化频繁
  - 转让定价：关联交易的公允价格判定（OECD 指南）

LLM Agent 适合：⚠️ 转让定价分析（需要大量文本理解），但税率计算绝不能用 LLM
确定性引擎必需：✅ 税率查找、税务计算、申报表数字填报
```

##### 外汇管理（汇率风险/远期结汇）

```
核心工作流：
  [敞口识别] → [风险评估] → [对冲策略] → [执行] → [公允价值计量]

技术特征：
  - 外汇敞口：按币种、期限汇总
  - 远期合约估值：折现现金流
  - 套期会计：公允价值套期/现金流套期

LLM Agent 适合：⚠️ 策略建议（但必须标注"不构成投资建议"）
确定性引擎必需：✅ 敞口计算、远期估值、套期有效性测试
```

### 2.2 Agent vs 确定性引擎的边界

这是本分析最核心的结论：

```
┌─────────────────────────────────────────────────────────────────┐
│                      企业财务系统架构边界                          │
│                                                                  │
│  LLM Agent 的领地（理解 & 判断）         确定性引擎的领地（计算 & 记录）  │
│  ┌─────────────────────────┐          ┌─────────────────────────┐ │
│  │ • 自然语言 → 结构化意图   │          │ • 复式记账平衡校验         │ │
│  │ • 凭证摘要自动生成        │          │ • 科目编码体系管理         │ │
│  │ • 银行流水智能对账        │          │ • 汇率换算（到分）         │ │
│  │ • 异常交易解释            │          │ • 税务计算（税率×基数）    │ │
│  │ • 财务报告文字分析        │          │ • BS/IS/CF 报表生成       │ │
│  │ • 发票/单据 OCR 识别      │          │ • 外币重估/汇兑损益        │ │
│  │ • 审计发现解释            │          │ • 利息计算（日计息）       │ │
│  │ • 转让定价文本分析        │          │ • 预算-实际数值对比        │ │
│  │ • 政策/准则解读问答       │          │ • 审计规则引擎匹配         │ │
│  └─────────────────────────┘          │ • 凭证编号连续性校验        │ │
│                                        │ • 会计期间关账锁定         │ │
│  ───────── 边界规则 ─────────          └─────────────────────────┘ │
│                                                                  │
│  1. LLM 绝不做"计算"：任何涉及数值运算的都走确定性引擎             │
│  2. LLM 绝不做"记录"：任何涉及 DB 写入的都通过工具函数             │
│  3. LLM 只做"理解"：把非结构化输入转成结构化参数                   │
│  4. LLM 只做"判断"：基于规则引擎输出做异常分类和解释               │
│  5. 确定性引擎是"source of truth"：LLM 只能读取，不能写入          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**为什么这个边界如此重要？**

1. **审计要求**：企业财务数据必须"可追溯、可复现"。LLM 的概率性输出（同一输入可能产生不同结果）在审计中不可接受。

2. **法律责任**：税务申报错误会导致罚款甚至刑事责任。"LLM 算错了税"不是合法辩护。

3. **精度要求**：财务计算要求到分（0.01），且四舍五入规则必须一致。LLM 的大数计算精度不可靠。

4. **合规要求**：中国《企业会计准则》、IFRS、GAAP 都有严格规定，不能用 AI 做"最佳猜测"。

---

## 3. 推荐架构

### 3.1 设计原则

```
┌─────────────────────────────────────────────────────────────┐
│                     Smart Finance Enterprise                 │
│                                                              │
│   核心原则：                                                  │
│                                                              │
│   1. LLM 是"财务团队的 AI 同事"，不是"替代所有人的黑盒"       │
│   2. 确定性引擎是系统的心脏——计算和记录 100% 可重现             │
│   3. Agent 是系统的双手——理解用户意图，调用正确的引擎           │
│   4. 每一笔数据的来源和变更都记录在不可篡改的审计日志中          │
│   5. 任何组件故障都有降级路径，绝不因为 AI 失效而丢失财务数据   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 整体架构

```
                            ┌──────────────────────────┐
                            │      前端 SPA (Vue 3)      │
                            │   会计工作台 / 出纳面板     │
                            │   财务分析 / 审计界面       │
                            └─────────────┬────────────┘
                                          │ HTTP + SSE (流式)
                            ┌─────────────▼────────────┐
                            │     Express API 层        │
                            │   鉴权 / 限流 / 审计日志    │
                            └─────────────┬────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
    ┌─────────▼─────────┐   ┌─────────────▼─────────────┐   ┌─────────▼─────────┐
    │   Finance Agent   │   │   Deterministic Engine     │   │  Admin / DevOps   │
    │   (LLM 驱动)       │   │   (零 LLM 调用)            │   │                   │
    │                    │   │                           │   │ • Feature Flags   │
    │ • NLU 意图识别     │   │ • DoubleEntryEngine       │   │ • 灰度发布         │
    │ • 凭证摘要生成     │   │   复式记账 / 科目编码       │   │ • 性能监控         │
    │ • 对账智能匹配     │   │ • TaxEngine               │   │ • 成本告警         │
    │ • 异常原因分析     │   │   VAT/GST/税率管理         │   │                   │
    │ • 报告文字说明     │   │ • CurrencyEngine           │   │                   │
    │ • 政策问答 RAG     │   │   汇率换算 / 汇兑损益       │   │                   │
    │ • OCR 票据识别     │   │ • ReportEngine             │   │                   │
    │                    │   │   BS/IS/CF 生成            │   │                   │
    │ 调用方式:          │   │ • AuditEngine              │   │                   │
    │ Agent → Engine     │   │   规则匹配 / 异常标记       │   │                   │
    │ (Agent 调 Engine,  │   │                           │   │                   │
    │  永不是 Engine     │   │ 每个 Engine 是独立的        │   │                   │
    │  调 Agent)         │   │ Node.js 模块, 纯函数        │   │                   │
    └─────────┬─────────┘   └─────────────┬─────────────┘   └───────────────────┘
              │                           │
              └───────────┬───────────────┘
                          │
              ┌───────────▼───────────┐
              │      Data Layer        │
              │                        │
              │  MySQL 8    业务数据    │
              │  Redis      会话/缓存   │
              │  Qdrant     向量/RAG   │
              │  MinIO      附件/凭证   │
              └────────────────────────┘
```

### 3.3 Finance Agent（LLM 驱动层）详细设计

```
┌──────────────────────────────────────────────────────────────┐
│                   Finance Agent (LangGraph)                    │
│                                                                │
│  基于现有 graph.js 的重构，保留安全骨架，精简节点:              │
│                                                                │
│  节点流 (9 节点，从 12 精简):                                   │
│                                                                │
│  START                                                         │
│    │                                                           │
│  ┌─▼────────────┐                                              │
│  │ load_context  │ ← L1(会话) + L2(组织记忆) + L4(窗口)        │
│  └─┬────────────┘                                              │
│    │                                                           │
│  ┌─▼────────────┐                                              │
│  │  compose      │ ← System Prompt + 工具列表 + 用户消息        │
│  └─┬────────────┘                                              │
│    │                                                           │
│  ┌─▼────────────┐                                              │
│  │  call_model   │ ← LLM 推理 (DeepSeek v4 / 本地 Qwen)        │
│  └─┬────────────┘                                              │
│    │                                                           │
│    ├── tool_calls? ──No──→ finalize → post_turn → END          │
│    │                                                           │
│  ┌─▼────────────┐                                              │
│  │  validate     │ ← 参数校验 / 权限检查 / Dataset 引用验证     │
│  └─┬────────────┘                                              │
│    │                                                           │
│    ├── write tool? ──Yes──→ risk_check → confirm?              │
│    │                              │                             │
│    │                         Yes  │  No → 取消                  │
│    │                              │                             │
│  ┌─▼────────────┐                │                             │
│  │  tool_node    │ ←──────────────┘                             │
│  │  (执行工具)   │                                              │
│  └─┬────────────┘                                              │
│    │                                                           │
│    └──→ call_model (循环，直到无 tool_call 或达到上限)           │
│                                                                │
│  工具集 (面向企业重新设计):                                      │
│  ┌──────────────────────────────────────────────────────┐     │
│  │ 读工具 (只读，不走确认):                               │     │
│  │  • query_accounts       — 查询科目余额/明细            │     │
│  │  • query_vouchers       — 查询凭证列表                 │     │
│  │  • query_reports        — 查询报表 (BS/IS/CF)          │     │
│  │  • search_knowledge     — RAG 搜索会计准则/税法        │     │
│  │  • search_audit_rules   — 查询审计规则                 │     │
│  │                                                        │     │
│  │ 写工具 (触发 interrupt 确认):                          │     │
│  │  • create_voucher       — 创建会计凭证 (INTERRUPT)     │     │
│  │  • import_bank_statement — 导入银行流水                │     │
│  │  • post_period_close    — 期末关账 (双人确认)          │     │
│  │                                                        │     │
│  │ 分析工具 (调 Engine):                                  │     │
│  │  • run_tax_calculation  — 调用 TaxEngine              │     │
│  │  • run_currency_reval   — 调用 CurrencyEngine          │     │
│  │  • run_audit_scan       — 调用 AuditEngine             │     │
│  │  • generate_report      — 调用 ReportEngine            │     │
│  └──────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

### 3.4 Deterministic Engine（确定性引擎层）

```
┌─────────────────────────────────────────────────────────────┐
│                    Deterministic Engine Layer                 │
│                     (零 LLM 调用，纯函数)                      │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │               DoubleEntryEngine                          │ │
│  │                                                          │ │
│  │  职责：复式记账核心                                        │ │
│  │                                                          │ │
│  │  chartOfAccounts.js      科目表 (树形编码)                 │ │
│  │  voucherEngine.js        凭证引擎                         │ │
│  │    • createVoucher({借方, 贷方, 摘要, 日期})              │ │
│  │    • validateBalance()  → 借=贷?                          │ │
│  │    • validateAccount(code) → 科目是否存在?                 │ │
│  │    • validatePeriod(date) → 期间是否已关账?                │ │
│  │    • getLedger(accountCode, period) → 明细账              │ │
│  │  periodCloseEngine.js    月结/年结引擎                    │ │
│  │    • closePeriod(period) → 结转损益 / 关账                │ │
│  │    • isClosed(period) → 是否已关账                        │ │
│  │    • reversePeriod(period) → 反结账 (需特殊权限)          │ │
│  │  numberEngine.js         凭证编号引擎                     │ │
│  │    • nextNumber(type, period) → 连续编号，防跳号          │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                 TaxEngine                                 │ │
│  │                                                          │ │
│  │  职责：税务计算                                            │ │
│  │                                                          │ │
│  │  taxRules.js              税率表 (国家×税种×类别)         │ │
│  │    • getRate(country, taxType, category, date)           │ │
│  │  vatEngine.js             VAT/GST 计算                    │ │
│  │    • calcOutputVAT(amount, rate) → 销项税额               │ │
│  │    • calcInputVAT(amount, rate) → 进项税额                │ │
│  │    • calcNetVAT(output, input) → 应纳增值税               │ │
│  │  withholdingEngine.js     预提税计算                       │ │
│  │  transferPricingEngine.js 转让定价分析 (规则+数据)         │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              CurrencyEngine                              │ │
│  │                                                          │ │
│  │  职责：多币种换算                                          │ │
│  │                                                          │ │
│  │  rateProvider.js          汇率提供者                       │ │
│  │    • 从 exchange_rates 表读取 (定期更新)                   │ │
│  │    • 或调用外部 API (需缓存)                               │ │
│  │  conversionEngine.js      换算引擎                         │ │
│  │    • convert(amount, from, to, rateType, date)           │ │
│  │    • ROUND_HALF_UP 到分 (财务舍入规则)                     │ │
│  │  revaluationEngine.js     重估引擎                         │ │
│  │    • revalueMonetaryItems(period) → 汇兑损益              │ │
│  │    • 仅重估货币性项目 (现金/应收/应付/借款)                  │ │
│  │  consolidationEngine.js   合并报表引擎                     │ │
│  │    • 外币报表折算 / 内部交易抵消                           │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │               ReportEngine                               │ │
│  │                                                          │ │
│  │  职责：报表生成                                            │ │
│  │                                                          │ │
│  │  balanceSheetEngine.js    资产负债表                       │ │
│  │    • 从科目余额按 BS 模板重新排列                          │ │
│  │    • 资产=负债+所有者权益 (平衡校验)                        │ │
│  │  incomeStatementEngine.js 利润表                          │ │
│  │  cashflowEngine.js        现金流量表                       │ │
│  │  trialBalanceEngine.js    试算平衡表                       │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │               AuditEngine                                │ │
│  │                                                          │ │
│  │  职责：审计规则引擎                                        │ │
│  │                                                          │ │
│  │  rulesLoader.js           加载审计规则                     │ │
│  │  matcherEngine.js         规则匹配                         │ │
│  │    • 金额异常 (大额/频繁/整数)                              │ │
│  │    • 科目异常 (跨科目转账/科目错用)                         │ │
│  │    • 期间异常 (跨期/关账后修改)                             │ │
│  │    • 对账异常 (银行日记账≠银行流水)                         │ │
│  │    • 权限异常 (非授权操作)                                  │ │
│  │  scoringEngine.js         风险评分                         │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 3.5 数据流设计

```
              ┌─────────────────────────────────────────────┐
              │              请求生命周期示例                   │
              │  "录入一笔销售款 10,000 美元，汇率 7.25"        │
              └─────────────────────────────────────────────┘

  1. NLU (Agent/LLM)
     ┌──────────────────────────────────────────────────────┐
     │  输入: "录入一笔销售款 10,000 美元，汇率 7.25"          │
     │  输出: { intent: "create_voucher",                    │
     │          entries: [                                   │
     │            { account: "1002", side: "debit",          │
     │              amount: 10000, currency: "USD",          │
     │              rate: 7.25 },                            │
     │            { account: "6001", side: "credit",         │
     │              amount: 10000, currency: "USD",          │
     │              rate: 7.25 }                             │
     │          ],                                           │
     │          summary: "收到客户销售款 USD 10,000",          │
     │          date: "2026-08-10" }                         │
     └──────────────────┬───────────────────────────────────┘
                        │
  2. Interrupt (确认)
     ┌──────────────────┴───────────────────────────────────┐
     │  用户看到: "将创建以下凭证:                              │
     │            借: 银行存款(1002) USD 10,000 @7.25         │
     │            贷: 主营业务收入(6001) USD 10,000 @7.25     │
     │            摘要: 收到客户销售款 USD 10,000              │
     │            确认?"                                     │
     │  用户: 确认                                            │
     └──────────────────┬───────────────────────────────────┘
                        │
  3. DoubleEntryEngine (确定性校验)
     ┌──────────────────┴───────────────────────────────────┐
     │  ① validateBalance() → 借(USD 10,000)=贷(USD 10,000) ✓│
     │  ② validateAccount("1002") → 资产类-银行存款 ✓        │
     │  ③ validateAccount("6001") → 损益类-主营业务收入 ✓     │
     │  ④ validatePeriod("2026-08-10") → 2026-08 未关账 ✓    │
     │  ⑤ nextNumber("记账凭证", "2026-08") → 记-2026-08-0058 │
     └──────────────────┬───────────────────────────────────┘
                        │
  4. CurrencyEngine (汇率换算)
     ┌──────────────────┴───────────────────────────────────┐
     │  convert(10000, "USD", "CNY", "spot", "2026-08-10")   │
     │  → 10000 × 7.25 = 72,500.00 CNY                       │
     │  → 存储: amount=10000, currency=USD, amount_cny=72500  │
     └──────────────────┬───────────────────────────────────┘
                        │
  5. Persist + Audit Log
     ┌──────────────────┴───────────────────────────────────┐
     │  BEGIN TXN                                            │
     │    INSERT INTO vouchers (period, number, summary, ...) │
     │    INSERT INTO voucher_entries ×2 (借方+贷方)          │
     │    INSERT INTO account_balances UPDATE (银行存款+72500) │
     │    INSERT INTO audit_log (user, action, before, after) │
     │  COMMIT                                                │
     └──────────────────────────────────────────────────────┘
```

### 3.6 为什么这个架构比当前 3-Agent 好？

| 维度 | 当前 3-Agent 架构 | 推荐架构 | 改进 |
|------|-------------------|----------|------|
| **计算确定性** | Calculator Agent 是纯 JS 函数，但主控用正则调度，意图识别不可靠 | 所有计算在 Engine 层，LLM 只做理解，Engine 输入来自 Agent 的结构化输出 | 计算永远正确 |
| **可审计性** | Agent 决策过程不透明（正则匹配 + 硬编码 DAG） | 每一步：LLM 输出 → Interrupt 展示 → 用户确认 → Engine 校验 → 审计日志 | 完整的审计链条 |
| **可扩展性** | 新增业务需同时修改正则 + DAG + 两个 Agent | 新增业务只需：LLM System Prompt 描述 + Engine 函数 | 增加业务场景成本 O(1) |
| **合规性** | 没有会计期间、复式记账、科目体系概念 | Engine 层内置全部会计准则约束 | 从"记账工具"升级为"会计系统" |
| **架构简洁性** | 两套 Agent 并行（LangGraph + 3-Agent），代码重复 | 单 Agent + 多 Engine，职责边界清晰 | 代码量减 30% |
| **维护成本** | 正则匹配和 DAG 需要人工维护，随业务复杂化指数增长 | Prompt 驱动，Engine 纯函数，无需"调度逻辑" | 维护成本大幅降低 |
| **多币种** | 仅 amount_cny 字段，无汇率引擎 | CurrencyEngine 完整处理换算 + 重估 + 汇兑损益 | 从"记录外币金额"到"外币核算" |
| **复式记账** | 无——当前是单式记账（一笔一记录） | DoubleEntryEngine 保证借=贷 | 从"流水账"到"会计系统" |

**核心差距**：当前架构的本质是"带 AI 辅助的个人流水账"，推荐架构的本质是"有 AI 同事的企业会计系统"。二者面向完全不同的问题域。

---

## 4. MVP 方案

### 4.1 约束条件

- **资源**：1 台阿里云 ECS，2C4G，已有 MySQL + Redis + Qdrant
- **时间**：2-3 周（学生个人开发，课余时间）
- **人力**：1 人
- **目标**：可演示的企业财务 MVP，不是生产就绪产品

### 4.2 MVP 覆盖范围

**只做 1 个角色：会计（记账/报表）**

为什么选这个？
1. 会计是所有其他岗位（出纳/分析/审计/税务）的基础——没有账就没有分析的对象
2. 复式记账是确定性引擎最核心的部分，必须先建立
3. 当前 Smart Finance 的记账是单式记账，改造为复式记账是最根本的升级
4. 2C4G 服务器无法承载更多计算

**MVP 覆盖 3 个场景**：

| 场景 | 优先级 | 说明 |
|------|--------|------|
| 场景 1：智能凭证录入 | P0 | "收到客户王五货款 50,000 元" → AI 拆借/贷 → 用户确认 → 自动生成凭证 |
| 场景 2：科目余额查询 | P0 | "银行存款余额多少？" → Agent 调 Engine 查 account_balances |
| 场景 3：简单报表 | P1 | "本月利润表" → ReportEngine 生成 IS → LLM 格式化输出 |

### 4.3 真 LLM Agent vs 确定性规则

```
MVP 中的 LLM Agent 调用（只有 2 种）:

  1. NLU（自然语言 → 结构化借贷分录）
     输入: "用银行存款支付办公房租 8,000 元"
     LLM 输出: { entries: [
                  { account: "1002", side: "debit", amount: -8000 },
                  { account: "6602", side: "debit", amount: 8000 }
                ], summary: "支付办公房租" }
     
     注: LLM 只输出结构，不计算余额，不校验科目

  2. 报表解释
     输入: { 利润表 JSON }
     LLM 输出: "本月营业收入 125,000 元，较上月增长 15%..."
     
     注: LLM 只做文字分析，不生成报表数字

MVP 中确定性的部分（Engine 层）:

  • 科目编码校验 — chartOfAccounts.js 白名单
  • 借贷平衡校验 — 借合计 === 贷合计 (精度到分)
  • 会计期间校验 — 已关账期间拒绝写入
  • 凭证编号生成 — 连续编号，防跳号
  • 科目余额计算 — SQL SUM 聚合
  • 利润表生成 — 固定模板，科目余额取数
```

### 4.4 文件级改动计划

#### 第 1 周：基础数据模型 + DoubleEntryEngine

```
新增文件:

  server/src/engine/
  ├── chartOfAccounts.js          ← 会计科目表 (中国会计准则标准科目)
  ├── doubleEntryEngine.js        ← 复式记账核心
  │   ├── createVoucher()         ← 创建凭证
  │   ├── validateBalance()       ← 借=贷校验
  │   ├── validateAccount()       ← 科目是否合法
  │   └── validatePeriod()        ← 期间是否已关账
  ├── accountEngine.js            ← 科目余额查询
  │   ├── getBalance()            ← 查询科目余额
  │   ├── getLedger()             ← 查询明细账
  │   └── getTrialBalance()       ← 试算平衡
  └── reportEngine.js             ← 报表生成
      ├── generateIncomeStatement()  ← 利润表
      └── generateBalanceSheet()     ← 资产负债表

新增数据表 (schema.js 补充):

  -- 会计科目表
  CREATE TABLE chart_of_accounts (
    code VARCHAR(16) PRIMARY KEY,     -- 如 "1001", "1002", "6602"
    name VARCHAR(64) NOT NULL,        -- 科目名称
    parent_code VARCHAR(16),          -- 上级科目
    category ENUM('asset','liability','equity','revenue','expense'),
    dc_type ENUM('debit','credit'),   -- 余额方向 (借/贷)
    level TINYINT NOT NULL DEFAULT 1, -- 级次
    is_leaf BOOLEAN DEFAULT TRUE      -- 是否末级科目
  )

  -- 会计凭证主表
  CREATE TABLE vouchers (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,  -- 租户ID (企业)
    period VARCHAR(7) NOT NULL,          -- 会计期间 (YYYY-MM)
    voucher_type VARCHAR(16) NOT NULL,   -- 记账凭证/收款凭证/付款凭证
    voucher_number VARCHAR(32) NOT NULL, -- 凭证编号
    summary TEXT,                         -- 摘要
    total_debit DECIMAL(16,2) NOT NULL,  -- 借方合计
    total_credit DECIMAL(16,2) NOT NULL, -- 贷方合计
    attachments TEXT,                     -- 附件列表 (JSON array)
    status ENUM('draft','posted','reversed') DEFAULT 'draft',
    created_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    posted_at DATETIME NULL,
    UNIQUE KEY uniq_voucher_number (tenant_id, period, voucher_number),
    KEY idx_vouchers_period (tenant_id, period)
  )

  -- 会计凭证分录明细表
  CREATE TABLE voucher_entries (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    voucher_id BIGINT UNSIGNED NOT NULL,
    account_code VARCHAR(16) NOT NULL,   -- 科目编码
    side ENUM('debit','credit') NOT NULL, -- 借/贷
    amount DECIMAL(16,2) NOT NULL,
    currency VARCHAR(8) DEFAULT 'CNY',
    amount_cny DECIMAL(16,2) NULL,        -- 本位币金额
    exchange_rate DECIMAL(10,6) NULL,
    summary TEXT,
    KEY idx_entries_voucher (voucher_id),
    KEY idx_entries_account (tenant_id, account_code, period)
  )

  -- 科目余额表 (冗余表，定期刷新，加速查询)
  CREATE TABLE account_balances (
    tenant_id BIGINT UNSIGNED NOT NULL,
    account_code VARCHAR(16) NOT NULL,
    period VARCHAR(7) NOT NULL,
    opening_debit DECIMAL(16,2) DEFAULT 0,
    opening_credit DECIMAL(16,2) DEFAULT 0,
    period_debit DECIMAL(16,2) DEFAULT 0,
    period_credit DECIMAL(16,2) DEFAULT 0,
    closing_debit DECIMAL(16,2) DEFAULT 0,
    closing_credit DECIMAL(16,2) DEFAULT 0,
    PRIMARY KEY (tenant_id, account_code, period)
  )

修改文件:

  server/src/schema.js              ← 添加新表
  server/src/db-mysql.js            ← 无需改动 (knex 自动识别)
```

**第 1 周末验证**：
```bash
# 单元测试：创建凭证 → 检查借=贷 → 查询科目余额
npm test -- --test-name-pattern="doubleEntry"
```

#### 第 2 周：Agent 对接 + 工具重新设计

```
新增文件:

  server/src/agent/tools/
  ├── accountingTools.js           ← 会计专用工具 (替换 domainTools 的部分)
  │   ├── create_voucher           ← Agent 调 DoubleEntryEngine.createVoucher()
  │   ├── query_account_balance    ← Agent 调 accountEngine.getBalance()
  │   ├── query_voucher            ← Agent 查询凭证
  │   ├── query_trial_balance      ← Agent 调 accountEngine.getTrialBalance()
  │   └── generate_income_statement ← Agent 调 reportEngine.generateIncomeStatement()

修改文件:

  server/src/agent/graph.js        ← 工具列表更新 (新增 accountingTools)
  server/src/agent/prompts.js      ← System Prompt 重写 (会计角色)
  server/src/agent/state.js        ← 添加 tenantId / period 字段

新增/修改:

  server/src/agent/eval/cases.js   ← 新增会计场景评估用例:
    - "收到股东投资 100 万元"
    - "用银行存款支付办公房租 8,000 元"
    - "销售商品收入 50,000 元，款项已收"
    - "银行存款余额是多少？"
    - "生成本月利润表"
    - "已关账期间不允许录入" (安全测试)

改写 System Prompt (prompts.js):

  从:
    "你是智能财务顾问，擅长帮助用户管理个人财务
     1. 智能记账 2. 账单查询 3. 预算管理 4. 财务健康评估..."

  改为:
    "你是企业的 AI 会计助手。你的职责是：
     1. 理解用户的自然语言描述，识别其中的借贷分录
     2. 调用会计工具完成凭证录入和查询
     3. 生成和解释财务报表

     你必须遵守的规则：
     - 每笔凭证的借方合计必须等于贷方合计
     - 科目必须使用中国会计准则标准编码
     - 已关账的会计期间不能修改
     - 不确定的科目编码必须询问用户
     - 不提供投资建议"
```

**第 2 周末验证**：
```bash
# 端到端测试：自然语言 → Agent → Engine → DB
npm run eval  # 新增 6+ 会计场景评估
```

#### 第 3 周：前端适配 + 演示打磨

```
修改文件:

  client/src/
  ├── components/
  │   ├── VoucherEntry.vue         ← 新增：凭证录入界面 (展示借/贷两栏)
  │   ├── VoucherList.vue          ← 新增：凭证列表
  │   └── AccountBalance.vue       ← 新增：科目余额表 (表格形式)
  ├── stores/
  │   └── accounting.js            ← 新增：会计数据 Pinia store
  └── router/
      └── index.js                 ← 新增路由: /accounting/*

修改文件 (后端):

  server/src/routes/chat.js        ← 无需改动 (Agent API 已自包含)
  server/src/routes/               ← 可新增 accounting.js REST 路由 (直接调 Engine)

部署:

  docker-compose.yml               ← 无需改动 (已有 MySQL + Redis + Qdrant)
  数据库迁移脚本                    ← npm run migrate (执行新表创建)
```

**第 3 周末验证**：
```bash
# 全流程演示
1. 前端输入 "收到客户王五货款 50,000 元"
2. Agent 返回借贷分录建议，展示在 VoucherEntry 组件
3. 用户确认 → 凭证创建成功
4. 查询 "银行存款余额" → 显示余额 +50000
5. 查询 "本月利润表" → 显示收入 50000
```

### 4.5 不做的事项（明确边界）

| 不做 | 原因 |
|------|------|
| 多币种/汇率引擎 | MVP 只用 CNY，第 2 期再上 |
| 税务计算 | 税率管理复杂，需要专业领域知识 |
| 多租户完整实现 | tenant_id 字段预留，但 MVP 用 user_id 代替 |
| 关账/反结账 | 需要期间管理，MVP 先不做 |
| 出纳对账 | 需要银行流水导入，第 3 期 |
| 审计规则引擎 | 需要大量规则积累 |
| 知识库 RAG | 现有 Qdrant 基础设施可用，但会计准则语料需另外准备 |
| CFP/财务顾问功能 | 移除，与企业管理无关 |

### 4.6 风险评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| 复式记账逻辑错误 | 致命—企业数据不可用 | 覆盖性单元测试（每个 Engine 函数至少 5 个测试） |
| 科目编码不标准 | 高—会计人员无法使用 | 严格遵循《企业会计准则》科目表 |
| LLM 输出不可靠 | 中—NLU 可能错误理解 | Interrupt 确认 + Engine 校验双重保护 |
| 2C4G 性能不足 | 中—多表 JOIN 可能慢 | 4 张核心表，索引覆盖所有查询，Redis 缓存余额 |
| 时间不够 | 中 | 砍功能到核心 3 个场景，第 2 期再做完整版 |

### 4.7 扩展路线图

```
MVP (2-3 周)               第 2 期 (2-3 周)              第 3 期 (2-3 周)
┌──────────────┐        ┌──────────────────┐        ┌──────────────────┐
│ 会计核心      │   →    │ 多币种 + 出纳      │   →    │ 税务 + 审计       │
│              │        │                  │        │                  │
│ • 复式记账    │        │ • CurrencyEngine  │        │ • TaxEngine      │
│ • 科目体系    │        │ • 银行对账        │        │ • AuditEngine    │
│ • 凭证管理    │        │ • 多币种凭证      │        │ • 审计报告生成   │
│ • 利润表      │        │ • 资产负债表      │        │ • 税务申报联动   │
│ • NLU 凭证    │        │ • 现金流量表      │        │ • 政策知识库     │
│              │        │ • 汇兑损益        │        │ • 合规检查       │
└──────────────┘        └──────────────────┘        └──────────────────┘
```

---

## 附录：关键代码示例

### A. DoubleEntryEngine 核心接口

```javascript
// server/src/engine/doubleEntryEngine.js

/**
 * 创建会计凭证
 * @param {Object} params
 * @param {number} params.tenantId - 租户 ID
 * @param {Array} params.entries - 分录列表
 * @param {string} params.entries[].accountCode - 科目编码
 * @param {'debit'|'credit'} params.entries[].side - 借贷方向
 * @param {number} params.entries[].amount - 金额 (正数)
 * @param {string} params.summary - 摘要
 * @param {string} params.date - 日期 (YYYY-MM-DD)
 * @returns {Object} { success, voucherId, errors[] }
 */
export async function createVoucher({ tenantId, entries, summary, date }) {
  const errors = []

  // 1. 借贷平衡校验
  const totalDebit = entries
    .filter(e => e.side === 'debit')
    .reduce((sum, e) => sum + e.amount, 0)
  const totalCredit = entries
    .filter(e => e.side === 'credit')
    .reduce((sum, e) => sum + e.amount, 0)
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return { success: false, errors: ['借贷不平衡'] }
  }

  // 2. 科目编码校验
  for (const entry of entries) {
    const exists = await COA.exists(entry.accountCode)
    if (!exists) errors.push(`科目 ${entry.accountCode} 不存在`)
  }

  // 3. 期间校验
  const period = extractPeriod(date)
  if (await periodEngine.isClosed(tenantId, period)) {
    return { success: false, errors: [`期间 ${period} 已关账`] }
  }

  if (errors.length > 0) return { success: false, errors }

  // 4. 生成凭证编号
  const number = await numberEngine.nextNumber(tenantId, period, '记账凭证')

  // 5. 事务写入
  const voucherId = await db.transaction(async (trx) => {
    const [id] = await trx('vouchers').insert({
      tenant_id: tenantId,
      period,
      voucher_type: '记账凭证',
      voucher_number: number,
      summary,
      total_debit: totalDebit,
      total_credit: totalCredit,
      created_by: userId,
      status: 'posted'
    })
    for (const e of entries) {
      await trx('voucher_entries').insert({
        voucher_id: id,
        account_code: e.accountCode,
        side: e.side,
        amount: e.amount
      })
    }
    // 更新科目余额
    await updateBalances(trx, tenantId, period, entries)
    return id
  })

  return { success: true, voucherId, number }
}
```

### B. 会计科目表（MVP 精简版）

```javascript
// server/src/engine/chartOfAccounts.js
export const CHART_OF_ACCOUNTS = [
  // 资产类 (1xxx)
  { code: '1001', name: '库存现金', category: 'asset', dc_type: 'debit', level: 1, parent_code: null },
  { code: '1002', name: '银行存款', category: 'asset', dc_type: 'debit', level: 1, parent_code: null },
  { code: '1122', name: '应收账款', category: 'asset', dc_type: 'debit', level: 1, parent_code: null },

  // 负债类 (2xxx)
  { code: '2202', name: '应付账款', category: 'liability', dc_type: 'credit', level: 1, parent_code: null },

  // 权益类 (4xxx)
  { code: '4001', name: '实收资本', category: 'equity', dc_type: 'credit', level: 1, parent_code: null },

  // 损益-收入类 (6xxx)
  { code: '6001', name: '主营业务收入', category: 'revenue', dc_type: 'credit', level: 1, parent_code: null },

  // 损益-费用类 (6xxx)
  { code: '6601', name: '销售费用', category: 'expense', dc_type: 'debit', level: 1, parent_code: null },
  { code: '6602', name: '管理费用', category: 'expense', dc_type: 'debit', level: 1, parent_code: null },
  { code: '6603', name: '财务费用', category: 'expense', dc_type: 'debit', level: 1, parent_code: null },
]
```

---

> **文档版本**: v1.0 | **作者**: AI 架构师 | **日期**: 2026-08-10
> **下次评审**: MVP 完成后
