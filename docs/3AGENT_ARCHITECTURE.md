# 极简 3 Agent 架构设计

> 主从协同模式：单主控 + 两个执行 Agent，结构最简单、改造成本最低

## 架构总览

```
用户提问
   ↓
┌─────────────────────────────────┐
│     主控 Agent (Master)         │  ← 调度中心
│  - 意图识别 / 任务拆解          │
│  - 分发任务 / 编排执行          │
│  - 结果汇总 / 生成回答          │
└──────┬───────────────┬──────────┘
       │               │
       ↓               ↓
┌──────────────┐ ┌──────────────────┐
│ 检索 Agent    │ │  计算 Agent      │
│ (Retrieval)  │ │ (Calculator)     │
│ - RAG 向量   │ │ - 预算执行计算   │
│ - 数据查询   │ │ - 周期对比计算   │
│ - 规则匹配   │ │ - 分类占比分析   │
│ - 配置读取   │ │ - 合规校验       │
└──────────────┘ └──────────────────┘
```

## 执行流程

```
用户提问 → 主控拆解任务 → 分发至检索/计算 Agent → 结果回传主控 → 整合输出
```

1. **拆解阶段**：主控 Agent 识别意图，生成多步任务计划
2. **分发阶段**：无依赖的步骤并行分发到对应执行 Agent
3. **执行阶段**：检索 Agent 取数据，计算 Agent 做运算
4. **汇总阶段**：主控收集所有结果，整合生成最终回答

## 三个 Agent 职责

### 1. 主控 Agent (`masterAgent.js`)

**定位**：调度中心，唯一对外入口

**核心能力**：
- 意图识别（规则驱动，5 种任务模式）
- 任务计划生成（DAG 有向无环图）
- 按轮次并行执行（依赖满足的步骤并发）
- 结果汇总与自然语言回答生成

**任务模式**：
| 模式 | 触发关键词 | 涉及 Agent |
|------|-----------|-----------|
| simple_query | 花了多少、统计 | 仅检索 |
| budget_analysis | 预算、超支、省钱 | 检索 + 计算 |
| period_comparison | 对比、环比、上月 | 检索 + 计算 |
| category_analysis | 分类、占比、构成 | 检索 + 计算 |
| comprehensive_analysis | 全面、综合、深度 | 多检索 + 多计算 |

### 2. 检索 Agent (`retrievalAgent.js`)

**定位**：数据获取层，只读不计算

**4 种检索类型**：
- `finance_summary` - 财务汇总查询（总数、笔数、均值、最大单笔）
- `records_vector` - 向量语义检索（RAG 用）
- `budget_config` - 预算配置查询
- `category_stats` - 分类统计查询

**输入**：查询参数
**输出**：原始结构化数据

### 3. 计算 Agent (`calculatorAgent.js`)

**定位**：运算层，纯计算无 IO

**5 种计算类型**：
- `budget_execution` - 预算执行计算（超支/预警状态、剩余金额）
- `period_comparison` - 周期对比（环比/同比、差额、百分比）
- `compliance_check` - 合规校验（金额合理性、分类合规性）
- `category_ratio` - 分类占比分析（消费结构评估）
- `spending_trend` - 消费趋势计算（线性回归斜率）

**输入**：原始数据（来自检索 Agent）
**输出**：计算后的指标与判断结果

## 文件结构

```
server/src/services/
├── masterAgent.js        # 主控 Agent（调度中心）
├── retrievalAgent.js     # 检索 Agent（数据层）
├── calculatorAgent.js    # 计算 Agent（运算层）
└── ...
server/src/scripts/
└── test-3agent.js        # 冒烟测试脚本
```

## 集成方式

### API 调用

在现有 `/chat` 接口中添加 `use3Agent` 参数即可启用新架构：

```json
POST /chat
{
  "message": "帮我看看预算执行情况",
  "use3Agent": true
}
```

响应中会包含：
- `agent: "3agent"` - 标识使用新架构
- `pattern` - 任务模式
- `execution` - 执行统计（步骤数、成功/失败数）

### 代码调用

```javascript
import { processQuery } from '../services/masterAgent.js'

const result = await processQuery({
  userId: 1,
  message: '我这个月花了多少钱'
})

console.log(result.answer)      // 自然语言回答
console.log(result.pattern)     // 任务模式
console.log(result.execution)   // 执行详情
```

## 设计原则

### 极简优先
- 规则驱动调度，不引入额外 LLM 调用
- 每个 Agent 职责单一，接口清晰
- 先跑通核心链路，再逐步增强

### 关注点分离
- **检索 Agent**：只做数据查询，不做业务计算
- **计算 Agent**：纯函数计算，无副作用
- **主控 Agent**：只做调度，不碰具体业务逻辑

### 可扩展性
- 新增检索类型：在 retrievalAgent.js 添加 handler
- 新增计算类型：在 calculatorAgent.js 添加 handler
- 新增任务模式：在 masterAgent.js 添加 pattern + plan
- 未来可平滑升级为 LLM 调度（替换 detectTaskPattern）

## 与原有架构的关系

新架构与原有 orchestratorAgent 并行存在，互不影响：
- 原有架构：复杂多步编排（基于 compound intent）
- 新架构：极简 3 Agent 主从协同
- 通过 `use3Agent` 参数灰度切换

## 下一步可扩展方向

1. **LLM 调度升级**：用 LLM 替换规则驱动的任务拆解
2. **工具调用增强**：检索 Agent 增加更多数据源（汇率、行情等）
3. **计算 Agent 扩展**：增加更多财务指标（储蓄率、现金流分析等）
4. **可观测性**：每个 Agent 的调用链追踪与耗时统计
5. **流式输出**：支持 SSE 流式回答
