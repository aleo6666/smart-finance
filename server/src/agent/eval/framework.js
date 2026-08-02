/**
 * Agent 评估框架 — 量化衡量 LangGraph Agent 的行为质量
 *
 * 设计原则:
 * - 确定性: 使用 mock LLM 响应，保证每次运行结果一致
 * - 快速: 所有评估在 2 秒内完成，适合 CI/CD
 * - 可扩展: 新增评估用例只需添加到 cases 数组
 *
 * 评估维度:
 * - tool_selection   工具选择准确率
 * - parameter_accuracy 参数填充准确率
 * - routing          路由决策正确率
 * - safety           安全防护有效性
 * - confirmation     敏感操作确认流
 * - idempotency      幂等操作正确性
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { StateGraph, START, END } from '@langchain/langgraph'
import { AgentState } from '../state.js'

/**
 * @typedef {Object} EvalCase
 * @property {string} name - 用例名称
 * @property {string} category - 分类: record|query|analysis|safety|budget|memory
 * @property {string} userInput - 用户输入
 * @property {Array} expectedTools - 期望调用的工具列表
 * @property {Object} [expectedArgs] - 期望的工具参数（部分匹配）
 * @property {string} [expectedIntent] - 期望的意图类型
 * @property {boolean} [expectConfirm] - 是否期望触发确认流程
 * @property {boolean} [expectReject] - 是否期望被安全拒绝
 * @property {string[]} [blockedTools] - 不应被调用的工具
 */

/**
 * @typedef {Object} EvalResult
 * @property {string} name
 * @property {string} category
 * @property {boolean} passed
 * @property {Object} scores - 各维度得分
 * @property {Array} details - 详细信息
 */

/**
 * 创建评估运行器
 * @param {Object} options
 * @param {Object} options.graph - LangGraph StateGraph 实例
 * @param {Function} options.buildState - (userInput) => initial state
 * @param {Array<EvalCase>} options.cases - 评估用例
 * @returns {Promise<{ results: EvalResult[], summary: Object }>}
 */
export async function runEvaluation({ graph, buildState, cases }) {
  const results = []
  const startTime = performance.now()

  for (const testCase of cases) {
    const result = await evaluateCase({ graph, buildState, testCase })
    results.push(result)
  }

  const duration = Math.round(performance.now() - startTime)
  const passed = results.filter(r => r.passed).length
  const total = results.length
  const byCategory = {}
  for (const r of results) {
    byCategory[r.category] = byCategory[r.category] || { total: 0, passed: 0 }
    byCategory[r.category].total++
    if (r.passed) byCategory[r.category].passed++
  }

  return {
    results,
    summary: {
      total,
      passed,
      failed: total - passed,
      passRate: total > 0 ? (passed / total * 100).toFixed(1) + '%' : 'N/A',
      durationMs: duration,
      byCategory
    }
  }
}

async function evaluateCase({ graph, buildState, testCase }) {
  const details = []
  let passed = true
  const toolCalls = []
  let routedToConfirm = false
  let routedToFinalize = false

  try {
    // Build initial state from user input
    const state = buildState(testCase.userInput, testCase.initialState)

    // Invoke the graph
    const result = await graph.invoke(state, {
      configurable: { thread_id: 'eval-' + testCase.name },
      recursionLimit: 8
    })

    // Collect tool calls from the conversation
    const messages = result.messages || []
    for (const msg of messages) {
      if (msg instanceof AIMessage && Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          toolCalls.push({ name: call.name, args: call.args || {} })
        }
      }
    }

    // Check for confirmation flow
    routedToConfirm = result.pendingConfirmation !== null &&
      result.pendingConfirmation !== undefined

    // Check for finalize
    routedToFinalize = result.response !== null &&
      result.response !== undefined

    // --- Evaluate expectations ---

    // 1. Tool selection
    if (testCase.expectedTools && testCase.expectedTools.length > 0) {
      const expectedSet = new Set(testCase.expectedTools)
      const actualSet = new Set(toolCalls.map(c => c.name))
      const missing = testCase.expectedTools.filter(t => !actualSet.has(t))
      const extra = toolCalls.filter(c => !expectedSet.has(c.name) && c.name !== '')

      if (missing.length > 0) {
        passed = false
        details.push({ type: 'missing_tool', expected: missing, actual: [...actualSet] })
      }
      if (extra.length > 0) {
        passed = false
        details.push({ type: 'unexpected_tool', tools: extra.map(c => c.name) })
      }
    }

    // 2. Blocked tools
    if (testCase.blockedTools) {
      const blockedCalled = toolCalls.filter(c => testCase.blockedTools.includes(c.name))
      if (blockedCalled.length > 0) {
        passed = false
        details.push({ type: 'blocked_tool_called', tools: blockedCalled.map(c => c.name) })
      }
    }

    // 3. Confirmation expectation
    if (testCase.expectConfirm === true && !routedToConfirm) {
      passed = false
      details.push({ type: 'missing_confirmation', expected: true, actual: false })
    }
    if (testCase.expectConfirm === false && routedToConfirm) {
      passed = false
      details.push({ type: 'unexpected_confirmation', expected: false, actual: true })
    }

    // 4. Rejection expectation
    if (testCase.expectReject === true && result.response?.success !== false) {
      passed = false
      details.push({ type: 'expected_rejection', actual: result.response })
    }

    // 5. Parameter accuracy (partial match)
    if (testCase.expectedArgs && toolCalls.length > 0) {
      const targetCall = toolCalls.find(c =>
        testCase.expectedTools?.includes(c.name)
      )
      if (targetCall) {
        for (const [key, value] of Object.entries(testCase.expectedArgs)) {
          if (targetCall.args[key] !== value) {
            details.push({
              type: 'param_mismatch',
              param: key,
              expected: value,
              actual: targetCall.args[key]
            })
          }
        }
      }
    }

  } catch (error) {
    passed = false
    details.push({ type: 'exception', message: error.message })
  }

  return {
    name: testCase.name,
    category: testCase.category,
    passed,
    findings: {
      toolCalls: toolCalls.map(c => c.name),
      routedToConfirm,
      routedToFinalize
    },
    details
  }
}

/**
 * 生成评估报告
 */
export function formatReport({ results, summary }) {
  const lines = []
  lines.push('='.repeat(60))
  lines.push('  Smart Finance Agent 评估报告')
  lines.push('='.repeat(60))
  lines.push('')
  lines.push(`总用例: ${summary.total}  |  通过: ${summary.passed}  |  失败: ${summary.failed}  |  通过率: ${summary.passRate}`)
  lines.push(`耗时: ${summary.durationMs}ms`)
  lines.push('')

  // By category
  lines.push('--- 按类别 ---')
  for (const [cat, stats] of Object.entries(summary.byCategory)) {
    const icon = stats.passed === stats.total ? '✅' : stats.passed > 0 ? '⚠️' : '❌'
    lines.push(`  ${icon} ${cat}: ${stats.passed}/${stats.total}`)
  }

  // Details for failures
  const failures = results.filter(r => !r.passed)
  if (failures.length > 0) {
    lines.push('')
    lines.push('--- 失败详情 ---')
    for (const f of failures) {
      lines.push(`  ❌ ${f.name}`)
      for (const d of f.details) {
        lines.push(`     └ ${d.type}: ${JSON.stringify(d)}`)
      }
    }
  }

  // All results
  lines.push('')
  lines.push('--- 全部结果 ---')
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌'
    const tools = r.findings.toolCalls.join(', ') || '(无工具调用)'
    lines.push(`  ${icon} [${r.category}] ${r.name} → ${tools}`)
  }

  return lines.join('\n')
}

export default { runEvaluation, formatReport }
