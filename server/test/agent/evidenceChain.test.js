import test from 'node:test'
import assert from 'node:assert/strict'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { tool } from 'langchain'
import { z } from 'zod'
import {
  buildEvidence,
  deterministicAnalysisText,
  validatePoints,
  validateSummary
} from '../../src/agent/evidence.js'
import { createSynthesisNode } from '../../src/agent/nodes/synthesizeFinancialAnalysis.js'
import { createAgentGraph } from '../../src/agent/graph.js'

// 聚餐 3 笔 + 打车 1 笔，餐饮预算 150，餐饮实际 180 → 超支 30（执行率 120%）
function datasetFixture() {
  return {
    rows: [
      { id: 8, amount: 80, category: '餐饮', date: '2026-08-03', description: '聚餐' },
      { id: 9, amount: 60, category: '餐饮', date: '2026-08-07', description: '聚餐' },
      { id: 10, amount: 40, category: '餐饮', date: '2026-08-15', description: '聚餐' },
      { id: 11, amount: 30, category: '交通', date: '2026-08-05', description: '打车' }
    ],
    summary: {
      budgets: [{ category: '餐饮', budget: 150 }]
    }
  }
}

function evidenceFixture() {
  return buildEvidence([datasetFixture()])
}

function fixtureState(datasetRefs) {
  return {
    messages: [new HumanMessage('帮我分析本月支出情况')],
    userId: 7,
    sessionId: 'session-7',
    userMemory: [],
    recentSummary: {},
    datasetRefs,
    intentType: 'analysis'
  }
}

// 1. 确定性证据正确性：分类/超支维度都携带 recordId 引用与计算过程
test('buildEvidence 产出可追溯的确定性证据块（recordIds + 计算过程）', () => {
  const evidence = evidenceFixture()

  assert.equal(evidence.total, 210)
  assert.equal(evidence.count, 4)
  assert.deepEqual(evidence.recordIds, [8, 9, 10, 11])

  const dining = evidence.categories.find(item => item.category === '餐饮')
  assert.deepEqual(dining.recordIds, [8, 9, 10])
  assert.equal(dining.total, 180)
  assert.equal(dining.count, 3)
  assert.equal(dining.ratio, 86)
  assert.match(dining.calculation, /#8 \+ #9 \+ #10 = 180 元/)

  const overspend = evidence.overspends[0]
  assert.equal(overspend.category, '餐饮')
  assert.equal(overspend.budget, 150)
  assert.equal(overspend.spent, 180)
  assert.equal(overspend.percent, 120)
  assert.equal(overspend.overAmount, 30)
  assert.deepEqual(overspend.recordIds, [8, 9, 10])
  assert.match(overspend.calculation, /超支 30 元/)

  for (const n of ['210', '180', '86', '120', '30', '8', '9', '10', '11']) {
    assert.ok(evidence.numbers.includes(n), `numbers 应包含 ${n}`)
  }
})

// 2. LLM 输出引用合法：recordIds 与数字都来自证据块 → 全部保留
test('validatePoints 放行引用与数字均来自证据块的 point', () => {
  const evidence = evidenceFixture()
  const { valid, dropped } = validatePoints([
    { text: '餐饮合计 180 元，占 86%，已超预算 30 元。', recordIds: [8, 9, 10] },
    { text: '交通合计 30 元，占 14%。', recordIds: [11] }
  ], evidence)

  assert.equal(valid.length, 2)
  assert.equal(dropped.length, 0)
  assert.deepEqual(valid[0].recordIds, [8, 9, 10])
})

// 3. 编造引用被拦截：recordId 不存在于证据块 → 丢弃该 point
test('validatePoints 拦截不存在的 recordId 引用', () => {
  const evidence = evidenceFixture()
  const { valid, dropped } = validatePoints([
    { text: '餐饮合计 180 元。', recordIds: [999] }
  ], evidence)

  assert.equal(valid.length, 0)
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].reason, 'fabricated_record_id')
})

// 4. 编造数字被拦截：文本数字与证据块不一致 → 丢弃该 point
test('validatePoints 拦截证据块中不存在的数字', () => {
  const evidence = evidenceFixture()
  const { valid, dropped } = validatePoints([
    { text: '餐饮超支 23%。', recordIds: [8, 9, 10] }
  ], evidence)

  assert.equal(valid.length, 0)
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].reason, 'fabricated_number')
})

// 5. 无 LLM 有效内容时降级为纯确定性表述
test('无有效 LLM 内容时降级为确定性模板（points + text 均可追溯）', async () => {
  const node = createSynthesisNode({
    model: {
      async invoke() { return JSON.stringify({ summary: '', points: [] }) }
    },
    datasetStore: { async get() { return datasetFixture() } }
  })

  const result = await node(
    fixtureState([{ datasetRef: 'ds_tx' }]),
    { context: { requestId: 'request-7' } }
  )

  assert.equal(result.response.type, 'financial_analysis')
  const points = result.response.evidence.points
  assert.ok(points.length > 0, '降级后应有确定性 points')
  assert.match(points[0].text, /共支出 210 元/)
  assert.equal(points[0].records.length, 4)
  assert.equal(points[0].records[0].recordId, 8)

  const text = result.messages[0].content
  assert.match(text, /本月共支出 210 元/)
  assert.match(text, /免责声明/)
})

// 5b. summary 编造数字同样被丢弃
test('validateSummary 丢弃含编造数字的 summary', () => {
  const evidence = evidenceFixture()
  assert.equal(validateSummary('本月支出共 999 元。', evidence), '')
  assert.equal(validateSummary('本月支出共 210 元。', evidence), '本月支出共 210 元。')
})

// 6. 接口兼容：整条图链路最终响应携带 evidence，message 保持字符串
test('分析链路最终响应携带 evidence 且不破坏现有字段', async () => {
  const queryTool = tool(async () => ({
    datasetRef: 'ds_tx',
    count: 4,
    scope: { month: '2026-08' }
  }), {
    name: 'query_transactions',
    description: 'query transactions',
    schema: z.object({})
  })

  const model = {
    bindTools() {
      return {
        async invoke() {
          return new AIMessage({
            content: '',
            tool_calls: [{
              id: 'query-1',
              name: 'query_transactions',
              args: {},
              type: 'tool_call'
            }]
          })
        }
      }
    },
    async invoke() {
      return JSON.stringify({
        summary: '本月餐饮支出偏高。',
        points: [{ text: '餐饮合计 180 元，占 86%。', recordIds: [8, 9, 10] }]
      })
    }
  }

  const graph = createAgentGraph({
    model,
    tools: [queryTool],
    checkpointer: false,
    config: { agent: { maxToolCalls: 3, adminSqlEnabled: false } },
    datasetStore: { async get() { return datasetFixture() } }
  })

  const result = await graph.invoke({
    messages: [new HumanMessage('帮我分析本月支出情况')],
    userId: 7,
    sessionId: 'session-7',
    requestStartTime: 0,
    isAdmin: false
  }, {
    configurable: { thread_id: '7:session-7' },
    context: { userId: 7, sessionId: 'session-7', requestId: 'request-7' },
    recursionLimit: 20
  })

  assert.equal(result.response.success, true)
  assert.equal(result.response.intent, 'analysis')
  assert.equal(typeof result.response.message, 'string')
  assert.match(result.response.message, /本月餐饮支出偏高/)
  assert.match(result.response.message, /餐饮合计 180 元，占 86%/)
  assert.deepEqual(result.response.errorCodes, [])

  assert.ok(result.response.evidence, '最终响应应携带 evidence')
  assert.equal(result.response.evidence.summary, '本月餐饮支出偏高。')
  assert.equal(result.response.evidence.points.length, 1)
  assert.equal(result.response.evidence.points[0].text, '餐饮合计 180 元，占 86%。')
  assert.equal(result.response.evidence.points[0].records.length, 3)
  assert.deepEqual(
    result.response.evidence.points[0].records.map(r => r.recordId),
    [8, 9, 10]
  )
})

test('deterministicAnalysisText 在无数据时返回诚实的降级文案', () => {
  const text = deterministicAnalysisText(buildEvidence([]))
  assert.match(text, /【财务分析】/)
  assert.match(text, /数据不足/)
  assert.match(text, /免责声明/)
})
