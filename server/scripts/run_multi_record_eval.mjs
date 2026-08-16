/**
 * 复杂记账测试集运行器 — 驱动 nlu 确定性拆单引擎，量化"一句话多意图拆分"质量
 *
 * 跑法：node scripts/run_multi_record_eval.mjs
 * 输出：按分类分桶的通过率 + 失败明细
 * 说明：拆单是纯规则（LLM 不参与），结果确定性可复现；这是"测试集"而非单元测试——
 *       用真实场景题目量化行为质量，用于简历/报告指标。
 */
import { buildMultiRecordResult } from '../src/services/nlu.js'
import { multiRecordCases } from '../docs/eval/multi-record-cases.mjs'

function round2(v) { return Math.round(v * 100) / 100 }

function evaluateCase(c) {
  const result = buildMultiRecordResult(c.input)
  const exp = c.expect

  // 期望不拆
  if (!exp.multi) {
    return { pass: result === null, detail: result === null ? 'null ✓' : `应不拆但得到 ${result.data?.records?.length ?? 0} 笔` }
  }

  // 期望拆分
  if (!result) return { pass: false, detail: '应拆分但得到 null' }
  const records = result.data.records
  if (records.length !== exp.n) {
    return { pass: false, detail: `应 ${exp.n} 笔实际 ${records.length} 笔` }
  }
  const errors = []
  exp.records.forEach((er, i) => {
    const r = records[i]
    if (Math.abs(round2(r.amount) - er.amount) > 0.01) errors.push(`[${i}]金额 ${r.amount}≠${er.amount}`)
    if (er.category && r.category !== er.category) errors.push(`[${i}]分类 ${r.category}≠${er.category}`)
    if (er.type && r.type !== er.type) errors.push(`[${i}]收支 ${r.type}≠${er.type}`)
  })
  return { pass: errors.length === 0, detail: errors.join('; ') || `${exp.n} 笔全对` }
}

const buckets = {}
let total = 0, passed = 0
for (const c of multiRecordCases) {
  const r = evaluateCase(c)
  total++; if (r.pass) passed++
  if (!buckets[c.category]) buckets[c.category] = { total: 0, pass: 0 }
  buckets[c.category].total++; if (r.pass) buckets[c.category].pass++
  console.log(`${r.pass ? '✅' : '❌'} [${c.category}] ${c.name} — ${r.detail}`)
}

console.log('\n========== 复杂记账测试集结果 ==========')
console.log(`总计: ${passed}/${total} = ${(passed / total * 100).toFixed(1)}%`)
for (const [bucket, b] of Object.entries(buckets)) {
  console.log(`  ${bucket}: ${b.pass}/${b.total} (${(b.pass / b.total * 100).toFixed(1)}%)`)
}
process.exit(passed === total ? 0 : 1)
