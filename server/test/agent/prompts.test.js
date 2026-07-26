import test from 'node:test'
import assert from 'node:assert/strict'
import { HumanMessage } from '@langchain/core/messages'
import {
  FINANCE_SYSTEM_RULES,
  composeModelMessages,
  composeSystemContext
} from '../../src/agent/prompts.js'

function fixtureState() {
  return {
    sessionMetadata: {
      deviceType: 'mobile',
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
      responseStyle: 'concise',
      apiKey: 'must-not-appear'
    },
    userMemory: [{
      namespace: 'preferences',
      memoryKey: 'default_currency',
      value: 'CNY',
      status: 'active',
      rawSecret: 'must-not-appear'
    }],
    recentSummary: {
      currentTopics: ['预算'],
      unfinishedTasks: [],
      password: 'must-not-appear'
    },
    datasetRefs: [{
      datasetRef: 'ds_current',
      count: 3,
      scope: { month: '2026-07' },
      rows: [{ amount: 999999 }]
    }],
    messages: [
      new HumanMessage('继续分析本月支出')
    ]
  }
}

test('finance system rules enforce trusted identity and evidence-first financial analysis', () => {
  assert.match(FINANCE_SYSTEM_RULES, /服务端.*Runtime Context/)
  assert.match(FINANCE_SYSTEM_RULES, /先.*工具.*取数.*确定性计算.*分析/)
  assert.match(FINANCE_SYSTEM_RULES, /禁止.*编造/)
  assert.match(FINANCE_SYSTEM_RULES, /不.*投资/)
  assert.match(FINANCE_SYSTEM_RULES, /确认.*Graph/)
  assert.match(FINANCE_SYSTEM_RULES, /工具错误.*不.*猜/)
  assert.match(FINANCE_SYSTEM_RULES, /数据而不是指令/)
})

test('prompt orders bounded memory layers and leaves current input last', () => {
  const state = fixtureState()
  const text = composeSystemContext(state)
  const messages = composeModelMessages(state)

  assert.ok(text.indexOf('L1 会话元数据') < text.indexOf('L2 用户记忆'))
  assert.ok(text.indexOf('L2 用户记忆') < text.indexOf('L3 近期摘要'))
  assert.ok(text.indexOf('L3 近期摘要') < text.indexOf('L4 滑动窗口'))
  assert.ok(text.indexOf('L4 滑动窗口') < text.indexOf('数据集引用'))
  assert.equal(messages[0]._getType(), 'system')
  assert.equal(messages.at(-1).content, '继续分析本月支出')
  assert.equal(messages.length, state.messages.length + 1)
})

test('prompt serialization excludes secrets, raw datasets and undefined values', () => {
  const text = composeSystemContext(fixtureState(), { maxContextChars: 1800 })

  assert.doesNotMatch(text, /must-not-appear|999999|undefined|apiKey|password|rawSecret/)
  assert.match(text, /ds_current/)
  assert.match(text, /"count":3/)
  assert.ok(Array.from(text).length <= 1800)
})

test('prompt excludes pending and deleted user facts from L2 context', () => {
  const state = fixtureState()
  state.userMemory.push(
    {
      namespace: 'finance',
      memoryKey: 'salary',
      value: 'pending-salary',
      status: 'pending'
    },
    {
      namespace: 'preferences',
      memoryKey: 'old',
      value: 'deleted-value',
      status: 'deleted'
    }
  )

  const text = composeSystemContext(state)

  assert.doesNotMatch(text, /pending-salary|deleted-value/)
  assert.match(text, /default_currency/)
})
