/**
 * 证据链 — 确定性证据构建 + LLM 引用校验
 *
 * 目标：让每条分析结论都能追溯到具体账单记录（record_id），杜绝 LLM 编造数字。
 *
 * 职责：
 * 1. buildEvidence: 从数据集（账单行 + 汇总 + 计算结果）构建确定性证据块，
 *    每个维度统计/异常项都携带 record_id 引用与计算过程。
 * 2. validatePoints / validateSummary: 校验 LLM 输出 —— recordIds 必须存在于
 *    证据块中，文本中的数字必须与证据块一致，否则丢弃。
 * 3. deterministicPoints / deterministicAnalysisText: LLM 无有效内容时降级为
 *    纯确定性模板表述（不依赖 LLM）。
 */

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function toRecordId(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * 从数据集 rows 中收集可引用的账单记录（按 recordId 去重）。
 * rows 由 query_transactions 等工具写入，携带数据库主键 id。
 */
export function collectEvidenceRecords(datasets) {
  const byId = new Map()
  const records = []
  for (const dataset of Array.isArray(datasets) ? datasets : []) {
    const rows = Array.isArray(dataset?.rows) ? dataset.rows : []
    for (const row of rows) {
      const recordId = toRecordId(row?.id ?? row?.recordId ?? row?.record_id)
      if (recordId === null || byId.has(recordId)) continue
      const record = {
        recordId,
        amount: round2(Number(row.amount_cny ?? row.amount ?? 0)),
        category: typeof row.category === 'string' && row.category
          ? row.category
          : '其他',
        date: typeof row.date === 'string' ? row.date.slice(0, 10) : (row.date ?? null),
        description: typeof row.description === 'string' ? row.description : null
      }
      byId.set(recordId, record)
      records.push(record)
    }
  }
  return records
}

function asBudgetItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const category = typeof item.category === 'string' && item.category
    ? item.category
    : '总预算'
  const budget = Number(item.budget ?? item.limit ?? item.amount ?? 0)
  if (!Number.isFinite(budget) || budget <= 0) return null
  const spent = Number(item.spent ?? item.total ?? 0)
  return { category, budget, spent: Number.isFinite(spent) ? spent : 0 }
}

/**
 * 从数据集中收集预算配置。预算可能出现在多个结构里：
 * summary.budgets / summary.items / summary.data.items（check_budget 结果）
 * 以及 summary.calculations[].result.{items,data.items}（budget_execution 结果）。
 */
function collectBudgetItems(datasets) {
  const items = []
  const seen = new Set()
  const push = item => {
    const normalized = asBudgetItem(item)
    if (!normalized) return
    const key = `${normalized.category}:${normalized.budget}`
    if (seen.has(key)) return
    seen.add(key)
    items.push(normalized)
  }
  for (const dataset of Array.isArray(datasets) ? datasets : []) {
    const summary = dataset?.summary
    if (!summary || typeof summary !== 'object') continue
    for (const candidate of [summary.budgets, summary.items, summary.data?.items]) {
      if (Array.isArray(candidate)) candidate.forEach(push)
    }
    for (const calculation of Array.isArray(summary.calculations) ? summary.calculations : []) {
      const result = calculation?.result
      for (const candidate of [result?.items, result?.data?.items]) {
        if (Array.isArray(candidate)) candidate.forEach(push)
      }
    }
  }
  return items
}

function addNumber(set, value) {
  if (value === null || value === undefined) return
  const n = Number(value)
  if (!Number.isFinite(n)) return
  set.add(String(n))
}

/**
 * 构建确定性证据块：记录 + 分类维度 + 超支维度 + 可引用数字集合。
 * 每个结论（分类合计/占比/超支）都带 recordIds 与计算过程，供 LLM 逐字引用。
 */
export function buildEvidence(datasets) {
  const records = collectEvidenceRecords(datasets)
  const recordIds = records.map(record => record.recordId)
  const total = round2(records.reduce((sum, record) => sum + record.amount, 0))
  const count = records.length

  const categoryMap = new Map()
  for (const record of records) {
    const block = categoryMap.get(record.category) ?? {
      category: record.category,
      total: 0,
      count: 0,
      recordIds: []
    }
    block.total = round2(block.total + record.amount)
    block.count += 1
    block.recordIds.push(record.recordId)
    categoryMap.set(record.category, block)
  }
  const categories = [...categoryMap.values()]
    .sort((a, b) => b.total - a.total)
    .map(block => {
      const ratio = total > 0 ? Math.round((block.total / total) * 100) : 0
      return {
        category: block.category,
        total: block.total,
        count: block.count,
        recordIds: block.recordIds,
        ratio,
        calculation:
          `分类「${block.category}」合计 = ${block.recordIds.map(id => `#${id}`).join(' + ')} = ${block.total} 元，占总支出 ${ratio}%`
      }
    })

  const overspends = collectBudgetItems(datasets)
    .map(item => {
      const backingRecords = item.category === '总预算'
        ? records
        : records.filter(record => record.category === item.category)
      const spent = item.spent > 0
        ? item.spent
        : round2(backingRecords.reduce((sum, record) => sum + record.amount, 0))
      if (spent <= item.budget) return null
      const percent = Math.round((spent / item.budget) * 100)
      const overAmount = round2(spent - item.budget)
      return {
        category: item.category,
        budget: round2(item.budget),
        spent: round2(spent),
        percent,
        overAmount,
        recordIds: backingRecords.map(record => record.recordId),
        calculation:
          `分类「${item.category}」预算 ${round2(item.budget)} 元，实际支出 ${round2(spent)} 元，超支 ${overAmount} 元（执行率 ${percent}%）`
      }
    })
    .filter(Boolean)

  // 可被 LLM 逐字引用的数字集合（用于“数字必须与证据一致”校验）
  const numbers = new Set()
  for (const record of records) {
    addNumber(numbers, record.recordId)
    addNumber(numbers, record.amount)
  }
  addNumber(numbers, total)
  addNumber(numbers, count)
  for (const category of categories) {
    addNumber(numbers, category.total)
    addNumber(numbers, category.count)
    addNumber(numbers, category.ratio)
  }
  for (const overspend of overspends) {
    addNumber(numbers, overspend.budget)
    addNumber(numbers, overspend.spent)
    addNumber(numbers, overspend.percent)
    addNumber(numbers, overspend.overAmount)
  }

  return {
    records,
    recordIds,
    total,
    count,
    categories,
    overspends,
    numbers: [...numbers]
  }
}

// 日期形态的数字不属于“编造数字”，先剔除再校验。
const DATE_PATTERNS = [
  /\d{4}-\d{1,2}-\d{1,2}/g,
  /\d{1,2}月\d{1,2}日/g,
  /\d{1,2}\/\d{1,2}/g
]

function maskDates(text) {
  let result = text
  for (const pattern of DATE_PATTERNS) {
    result = result.replace(pattern, ' ')
  }
  return result
}

export function extractNumbers(text) {
  return maskDates(String(text ?? '')).match(/\d+(?:\.\d+)?/g) ?? []
}

function groundedNumbers(evidence) {
  return new Set((evidence?.numbers ?? []).map(String))
}

function hasUngroundedNumber(text, evidence) {
  const allowed = groundedNumbers(evidence)
  return extractNumbers(text).some(number => !allowed.has(number))
}

/**
 * 校验 LLM 输出的 summary —— 文本中的数字必须与证据块一致。
 * 含编造数字时返回空串（由调用方决定是否降级）。
 */
export function validateSummary(summary, evidence) {
  if (typeof summary !== 'string') return ''
  if (hasUngroundedNumber(summary, evidence)) return ''
  return summary.trim()
}

/**
 * 校验 LLM 输出的 points：
 * - recordIds 必须全部存在于证据块中，否则视为编造引用，丢弃该 point。
 * - text 中的数字必须与证据块一致，否则视为编造数字，丢弃该 point。
 */
export function validatePoints(points, evidence) {
  const recordIdSet = new Set((evidence?.recordIds ?? []).map(String))
  const valid = []
  const dropped = []
  for (const point of Array.isArray(points) ? points : []) {
    if (!point || typeof point.text !== 'string' || !point.text.trim()) {
      dropped.push({ reason: 'empty' })
      continue
    }
    const recordIds = Array.isArray(point.recordIds)
      ? point.recordIds.map(toRecordId).filter(id => id !== null)
      : []
    if (recordIds.some(id => !recordIdSet.has(String(id)))) {
      dropped.push({ reason: 'fabricated_record_id' })
      continue
    }
    if (hasUngroundedNumber(point.text, evidence)) {
      dropped.push({ reason: 'fabricated_number' })
      continue
    }
    valid.push({ text: point.text, recordIds })
  }
  return { valid, dropped }
}

/**
 * 纯确定性表述：不依赖 LLM，直接从证据块生成可追溯的 points。
 */
export function deterministicPoints(evidence) {
  const points = []
  if ((evidence?.count ?? 0) > 0) {
    points.push({
      text: `本月共支出 ${evidence.total} 元，合计 ${evidence.count} 笔。`,
      recordIds: evidence.recordIds ?? []
    })
  }
  for (const category of evidence?.categories ?? []) {
    points.push({
      text: `${category.category} 合计 ${category.total} 元（${category.count} 笔，占 ${category.ratio}%）。`,
      recordIds: category.recordIds ?? []
    })
  }
  for (const overspend of evidence?.overspends ?? []) {
    points.push({
      text: `${overspend.category} 预算 ${overspend.budget} 元，已用 ${overspend.spent} 元，超支 ${overspend.overAmount} 元（执行率 ${overspend.percent}%）。`,
      recordIds: overspend.recordIds ?? []
    })
  }
  return points
}

export function deterministicAnalysisText(evidence) {
  const lines = ['【财务分析】']
  const points = deterministicPoints(evidence)
  if (points.length === 0) {
    lines.push('当前账单数据不足，暂无法生成分析结论。请先记录或查询更多账单。')
  } else {
    lines.push('分析要点：')
    for (const point of points) lines.push(`- ${point.text}`)
  }
  lines.push('')
  lines.push('免责声明：本分析仅供记账与预算参考，不构成投资建议。')
  return lines.join('\n')
}

/**
 * 把 point 引用的 recordIds 解析成具体账单记录，供前端渲染。
 */
export function resolveRecords(recordIds, evidence) {
  const byId = new Map((evidence?.records ?? []).map(record => [
    String(record.recordId),
    record
  ]))
  return (Array.isArray(recordIds) ? recordIds : [])
    .map(id => byId.get(String(id)))
    .filter(Boolean)
}
