# Smart Finance 线上验证报告（2026-10-17）

> **部署状态更新（2026-10-17 15:40 CST）：修复已上线。** 生产 `https://lisheng666.xyz` 上 10 个受保护 GET 匿名访问全部返回 401，`/api/health` 200，`/api/health/ready` 返回 MySQL/Qdrant ready。以下第一至九节保留修复前基线，用于对照；第十节改为部署后记录。

> 目标：验证 `https://lisheng666.xyz` 生产环境是否支持简历里的说法——确定性查询、证据链、意图路由、写确认、多租户隔离。
> 方法：HTTPS 只读探针 + demo 账号（userId=14）+ 一次“待确认后取消”的 HITL 测试。**没有写入任何账目**；对话会写会话历史。
> 结论：**修复前不是全绿。** 基础设施、登录、HITL 通过；有 **1 个 P0 鉴权漏洞、2 个 P1 功能错误**，其中两项和简历直接冲突。修复后已于 2026-10-17 部署，匿名访问门禁已复核。

## 一、结果总表

| 项 | 结果 | 证据 |
|---|---|---|
| HTTPS / API 健康 | ✅ | `/api/health` 200；`/api/health/ready` 200，MySQL/Qdrant 均 ok |
| demo 登录 | ✅ | `/api/auth/email/login` 200，userId=14，token 正常 |
| `/api/auth/me` | ✅ | 200，返回 demo 用户与 1 个账本 |
| 账单接口鉴权 | ✅ | 无 token `GET /api/records` → **401 未登录** |
| 账单读取 | ✅ | 92 条；字段完整（type/category/amount/occurred_at/ledger_id） |
| 财务指标鉴权 | ❌ **P0** | 无 token `GET /api/financial/overview?user_id=14` → **200**；user_id=1/7/28 也 200；user_id=999999 也 200（空数据） |
| 线上总支出计算 | ✅ | `八月总支出` → **4,350.00 元**，与账单逐笔加总一致；工具调用 2 次 |
| 查询证据链 | ⚠️ **P2** | 同一回答 `data.sources = []`，没有 dataset_refs |
| 日期查询意图 | ❌ **P1** | “2026年8月餐饮支出是多少？” → `intent=record`，回答“我没听懂金额” |
| 分析+日期意图 | ❌ **P1** | “分析2026年8月总支出” → 仍 `intent=record`，同样“没听懂金额” |
| 写确认 HITL | ✅ | “交房租5000元” → `pending_confirm=true`，账单数 92→92；“取消” → 92，未落库 |
| 财务指标口径 | ❌ **P1** | 线上 `raw.food=25.00`；按同一精确 90 天口径，真实餐饮类支出 **408.00**（13 笔；若按日期口径为 451.00/15 笔）；`raw.fixed=1800` vs 真实固定类 **1972.00** |
| 会话记忆 | ⚠️ **P2** | 回答主动道歉：“前面提到的 7734 元、衣服 1059 元……并不成立”，说明历史里有错误数字被带进上下文 |

## 二、P0：财务指标接口没有鉴权（IDOR）

### 现象

不带任何 token，直接请求：

```text
GET /api/financial/overview?user_id=14   → 200
GET /api/financial/metrics?user_id=14    → 200
GET /api/financial/overview?user_id=1    → 200
GET /api/financial/overview?user_id=7    → 200
GET /api/financial/overview?user_id=28   → 200
GET /api/financial/overview?user_id=999999 → 200（空数据）
```

### 根因

`app/api/financial.py` 的两个路由只声明了 `user_id: int = Query(gt=0)`，没有 `Depends(get_current_user)`：

```python
@router.get("/metrics")
async def financial_metrics(
    user_id: int = Query(gt=0),
    db: AsyncSession = Depends(get_db),
):
...
```

`main.py` 也没有给该 router 加全局鉴权依赖。结果：任何人只要改 URL 里的 `user_id`，就能读任意用户的收入、支出、资产、负债和健康指标。

### 影响

- 简历里“多租户隔离……跨用户隔离测试通过”这句话，在 **REST 层不成立**；目前只证明了 **Agent 工具层**的越权拦截（5/5）。
- 这是 P0，不是“优化项”。修之前不要在简历/面试里说“多租户隔离已通过”。

### 修法

```python
from app.api.deps import get_current_user

@router.get("/metrics")
async def financial_metrics(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ...
```

- 去掉 `user_id` query 参数，或保留但强制校验 `user_id == current_user`；
- 两个路由都加 `Depends(get_current_user)`；
- 补测试：无 token → 401；A 用户 token 读 B 用户 → 403/404；`user_id=999999` 不再返回 200；
- 如果前端有调用，改成从 token 取 user_id。

## 三、P1：带年份的查询被当成记账

### 现象

| 输入 | 线上 intent | 回答 |
|---|---|---|
| `2026年8月餐饮支出是多少？` | `record` | “我没听懂金额，请告诉我具体多少钱……” |
| `分析2026年8月总支出` | `record` | 同上 |
| `八月总支出是多少？` | `query` | 正确：4,350.00 元，工具 `query_transactions` ×2 |

### 根因

`app/agents/nodes/intent_router.py` 的规则层：

```python
AMOUNT_RE = re.compile(r"\d+(?:\.\d+)?\s*(?:元|块|钱|rmb)?")
RECORD_VERBS = (..., "支出", ...)

if AMOUNT_RE.search(normalized) and any(v in normalized for v in RECORD_VERBS):
    return "record"
```

`2026` 被 `AMOUNT_RE` 当成金额；`支出` 又是记账动词，所以直接判 `record`。`分析2026年8月总支出` 里的“分析”不在高置信词表（表里是“分析一下/深度分析/财务分析”），因此也掉进 record。

### 修法

1. **先剥离日期表达式，再匹配金额**：
   - `2026年8月`、`2026-08`、`2026/08`、`8月`、`8月15日` 等；
   - 只剥离日期片段，保留“8月花了500元”里的 500。
2. 或要求金额必须带货币单位/“花了”等强语境，不把裸年份当金额。
3. 补回归测试：
   - `rule_route("2026年8月总支出是多少") != "record"`
   - `rule_route("分析2026年8月总支出") == "analysis"`
   - `rule_route("8月餐饮支出是多少") != "record"`
   - `rule_route("8月花了500元") == "record"`（不能误伤真记账）
4. 可选：把“分析”“查询”补进高置信词表，但要防止“分析这笔消费”误伤。

## 四、P1：财务指标的分类口径和线上数据对不上

### 现象

线上 `/api/financial/overview` 返回：

```json
"food": "25.00",
"fixed": "1800.00"
```

但同一账号、同一 3 个月周期（2026-07-19 ~ 2026-10-17）按账单实际分类汇总：

| 口径 | 线上指标 | 实际账单 | 差异 |
|---|---:|---:|---|
| 餐饮类 | 25.00 | **408.00**（13 笔；日期口径 451/15） | 少算 383.00 |
| 固定支出类 | 1800.00 | **1972.00**（3 笔） | 少算 172.00 |

实际餐饮类包括：早餐、午餐、晚餐、咖啡、奶茶、外卖、聚餐、超市采购；线上 `FOOD_CATEGORIES` 只认 `food / 食品 / 餐饮`。注：2026-07-19 的午餐 32 + 奶茶 11 在精确 90 天起点之前，已从 408 中剔除；若按日期口径则是 451/15 笔。固定支出同理，只认 `housing / rent / 住房 / 房租 / 房贷 / 水电 / 保险`，漏掉“水电燃气 / 物业费 / 话费”等实际分类。

### 影响

- Engel 系数、自由储蓄率、健康评分里依赖“餐饮/固定支出”的维度会被低估/高估；
- 这是“确定性计算”的**输入分类**问题：公式没错，分类映射错了；
- 简历里“健康评分（0-100 五维加权）”在生产数据上不一定可信，修好映射前别说“准确”。

### 修法

1. 建 `CATEGORY_GROUPS` 映射（建议放在 `app/services/category_groups.py`）：
   - `food`: 餐饮、食品、早餐、午餐、晚餐、咖啡、奶茶、外卖、聚餐、超市采购
   - `fixed`: 房租、住房、房贷、水电、水电燃气、物业费、保险、话费
   - `transport`: 地铁、公交、打车、加油、停车
   - 其他按现有分类补全
2. `financial_overview._transaction_totals` 和 `query_transactions` 的 category 过滤都走映射（或写入时归一化）；
3. 补测试：用“早餐/午餐/晚餐/超市采购/水电燃气/物业费”等真实分类，断言 food/fixed 合计；
4. 跑一遍 demo 数据，确认 `food≈408`、`fixed≈1972`（同一精确周期）。

## 五、P2：查询回答没有证据链

“八月总支出是多少？”回答正确（4,350.00），但 API 返回：

```json
"tools": ["query_transactions", "query_transactions"],
"sources": []
```

`query_transactions` 只返回文本 JSON，没有 `dataset_refs`；`analyst_loop` 的工具才有 refs。结果：查询类回答没有可点击/可追溯的数据引用，和“结论必须绑定真实数据”的对外说法有差距。

修法：让 `query_transactions` 返回 `dataset_refs`（记录 id/金额/日期），在 `graph.py` 的 `run_one_tool` 聚合进 state，`chat.py` 返回 `sources`；补一条端到端测试断言 `sources` 非空。

## 六、P2：90 天周期的时间边界

线上 overview 的 `expenses.total=4622`；按日期（2026-07-19 起）从账单加总得到 4671，差 49.00。

原因：`get_user_financial_overview` 用 `datetime.now() - timedelta(days=90)` 作为起点，但只把日期 `2026-07-19` 展示出来；当天 00:00 的三笔支出（6+32+11=49）在精确时间点之前，被排除。不是数据错，是**日界 vs 精确 90 天**的口径不一致。

修法：把 `period_start` 归一到当天 00:00，或返回精确时间戳；两者选一个，测试断言“展示周期内的账单合计 = overview 合计”。

## 七、P2：会话历史里有错误数字

“八月总支出是多少？”的回答开头主动道歉：

> “我在前面几轮回复中提到的‘本月总支出 7734 元’、‘衣服 1059 元’等数字，经重新按真实流水核对后并不成立，那是不该出现的数字。”

说明 demo 账号的历史对话里有模型编造的数字，且被注入下一轮上下文。虽然这次模型自我纠正了，但这是信任风险：错误数字可能被下一轮沿用。

修法：
- demo 账号清空会话历史（或提供“重置会话”入口）；
- 系统提示里明确“历史 assistant 数字未经工具验证，不得作为事实引用”；
- 长期：只把带 `dataset_refs` 的 assistant 消息写入长期记忆，纯文本结论降级为短期上下文。

## 八、对简历的影响（必须先处理）

> 注：验证后已先把 1017 与证据版里“跨用户隔离测试通过”收窄为“Agent 工具层跨用户隔离通过”——这只是去掉假话，不等于 REST 鉴权已修。
> 2026-10-17 15:40 已部署修复（见 §十），生产匿名访问 10 个受保护 GET 全部 401。
> 仍然不要写“多租户隔离已通过”：只复核了匿名门禁，跨用户 token 复测未做；简历用“token 身份作用域 + 线上匿名访问 401”。

| 简历说法 | 线上结论 | 处理 |
|---|---|---|
| “多租户隔离……跨用户隔离测试通过” | ❌ REST 层可越权读任意 user_id | 修 P0 前删掉/改成“Agent 工具层越权拦截 5/5” |
| “结论必须绑定真实数据” | ⚠️ 分析链路有 refs；查询链路 `sources=[]` | 改成“分析链路强制证据链；查询链路补 refs 中”，或修完再写 |
| “意图路由覆盖 75%→93.8%” | ❌ 带年份的查询直接错路由 | 修 P1 并补测试后再写；否则加限定“不含日期表达” |
| “健康评分（0-100 五维加权）” | ❌ 分类映射漏算，食品/固定支出失真 | 修 P1 分类映射后再写“准确” |
| “329 测试全绿” | ✅ 本地事实；修复后 **349** | 改为 349；本轮已补鉴权/日期/分类/AA/证据链回归 |
| “写确认 20/20” | ✅ 线上 HITL 也通过（pending→取消，92→92） | 可保留，注明“离线 20/20 + 线上取消验证” |

### 为什么 329 测试没抓到

- `tests/test_financial_api.py` 直接请求 `/api/financial/metrics?user_id=1`，没有带 token——测试把“无鉴权”当成了预期行为。
- `tests/test_intent_router.py` 只测“这个月花了多少”，没有“2026年8月……”这类年份表达。
- 财务指标测试用 `food` / `salary` 等宽分类，没有“早餐 / 午餐 / 超市采购 / 水电燃气 / 物业费”等线上真实分类。
- `query_transactions` 没有 `dataset_refs` 断言，所以 `sources=[]` 不会被测试发现。

结论：测试全绿只能证明“已覆盖的路径没坏”，不能证明线上行为正确。这四类要补回归。

## 九、建议修复顺序

1. **P0 鉴权**（半天）：`financial.py` 加 `Depends(get_current_user)`，补 401/越权测试；部署后复测无 token 必须 401。
2. **P1 日期意图**（半天）：剥离日期再匹配金额，补 4 条规则测试；部署后复测“2026年8月总支出”必须 query/analysis。
3. **P1 分类映射**（1 天）：建 category group，改 metrics + query，补真实分类测试；部署后复测 food≈408、fixed≈1972。
4. **P2 refs / 周期边界 / 历史清理**（各半天）：query_transactions 返回 refs；period_start 归零；清 demo 会话。
5. 全部复测通过后，再更新简历口径。

## 十、修复与生产部署记录（2026-10-17）

| 项 | 状态 | 证据 |
|---|---|---|
| P0 `/api/financial/*` 无鉴权 | ✅ 已上线 | `Depends(get_current_user)`；匿名 401；`?user_id=999999` 仍 401 |
| P0 `/api/analysis/*` 无鉴权 | ✅ 已上线 | body/query `user_id` 不再作为身份来源；匿名 401 |
| P0 `/api/reports` 旧版接口无鉴权 | ✅ 已上线 | generate/history/detail 改为 token 身份；匿名 401 |
| P0 `/api/knowledge/*` 无鉴权、删除无归属校验 | ✅ 已上线 | 全部改用 token 身份；删除只允许所有者，跨用户统一 404 |
| P1 日期意图 | ✅ 已部署 | 金额识别前剔除日期；补 `支出是多少/总支出/多少钱`；`2026年8月...` → query，`2026年8月花了3000` → record |
| P1 分类映射 | ✅ 已部署 | 新增 category group；`早餐/午餐/超市采购`→food，`房租/水电燃气/物业费/话费`→fixed；query 支持 `餐饮` 别名 |
| P2 查询 refs | ✅ 已部署 | 查询工具返回 `dataset_refs`（逐笔/类目/月份） |
| P2 周期边界 | ✅ 已部署 | `period_start` 对齐当天 00:00 |
| 旧坑 AA/人均 | ✅ 已部署 | 人均×人数=160；AA 240÷3=80 |
| 旧坑 报销 type | ✅ 已部署 | `公司报销打车费120` → expense/交通 |
| 旧坑 证据链混句 | ✅ 已部署 | 子句级：真实分句保留，编造分句删除 |
| 测试 | ✅ **349 passed** | 全量 `pytest -q`，0 failed / 0 errors |
| 部署 | ✅ **已上线** | 热更新镜像 `smart-finance-py-backend:20261017`；容器 `finance-py-backend` 已重建 |

### 部署后线上复核（2026-10-17 15:40 CST）

```text
GET /api/health                                     200
GET /api/health/ready                               ready (mysql ok, qdrant ok)
GET /api/records?user_id=999999                     401
GET /api/ledgers?user_id=999999                     401
GET /api/budgets?user_id=999999                     401
GET /api/goals?user_id=999999                       401
GET /api/financial/metrics?user_id=999999           401
GET /api/financial/overview?user_id=999999          401
GET /api/analysis/all?user_id=999999                401
GET /api/reports?user_id=999999                     401
GET /api/reports/history?user_id=999999             401
GET /api/knowledge/documents?user_id=999999         401
```

响应体示例：`{"success":false,"data":null,"error":"未登录"}`。

带 token 的正向验证（服务器容器内生成 user 14 短期 token，不落盘）：

```text
GET /api/records  200      GET /api/ledgers  200
GET /api/budgets  200      GET /api/goals  200
GET /api/financial/metrics  200
GET /api/financial/overview  200
GET /api/analysis/all  200
GET /api/reports  200      GET /api/reports/history  200
GET /api/knowledge/documents  200
?user_id=14 与 ?user_id=999999 响应体逐字节一致 → query 参数已被忽略
```

> 部署方式：服务器上 Python 后端是预构建镜像，没有源码 git 仓库；本次把 `app/` 代码包热更新进容器，验证通过后 `docker commit` 为 `smart-finance-py-backend:20261017`，再 `docker compose -p smart-finance-py -f cloud-compose.yml up -d --no-deps backend-py` 重建。回滚标签为 `smart-finance-py-backend:pre-hotfix-20261017`。详见 `docs/eval/deploy_record_2026-10-17.md`。
>
> 边界：本次只复核了匿名访问门禁和 token 正向可用；跨用户 token 隔离需要两个账号，未在生产执行写入式复测。前端未改动；无数据库结构变更、未跑迁移。

## 十一、复现方式

```bash
# 健康
curl -s https://lisheng666.xyz/api/health
curl -s https://lisheng666.xyz/api/health/ready

# P0：无 token 读指标（应 401，当前 401）
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://lisheng666.xyz/api/financial/overview?user_id=999999"

# 账单鉴权（应 401）
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://lisheng666.xyz/api/records?limit=1"
```

> 本文所有线上数字均来自 2026-10-17 的实际 HTTPS 响应；未使用生产写入。demo 账号为展示账号，不包含真实用户数据。
