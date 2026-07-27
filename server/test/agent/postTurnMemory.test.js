import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createPostTurnMemoryNode } from '../../src/agent/nodes/postTurnMemory.js'

function fakeWindowMemory(initialMessages = []) {
  const messages = [...initialMessages]
  return {
    read: async () => messages.slice(),
    append: async (_userId, _sessionId, newMsgs) => {
      messages.push(...newMsgs)
      return messages.slice()
    }
  }
}

function fakeRecentSummary(summary = null, { upsertCalls } = {}) {
  return {
    read: async () => summary ?? {
      currentTopics: [],
      recentReferences: [],
      unfinishedTasks: [],
      analysisConclusions: [],
      plannedActions: [],
      temporaryContext: {}
    },
    upsert: async (input) => {
      if (upsertCalls) upsertCalls.push(input)
      return input.summary
    }
  }
}

function fixtureState(overrides = {}) {
  return {
    userId: overrides.userId ?? 7,
    sessionId: overrides.sessionId ?? 's-1',
    messages: overrides.messages ?? [
      { role: 'user', content: '查本月餐饮' },
      { role: 'assistant', content: '本月餐饮支出共 1,234.56 元。' }
    ],
    response: overrides.response ?? {
      success: true,
      intent: 'query',
      message: '本月餐饮支出共 1,234.56 元。'
    },
    errors: overrides.errors ?? [],
    ...overrides
  }
}

describe('postTurnMemory', () => {
  it('writes last turn to L4 window', async () => {
    const window = fakeWindowMemory()
    const summary = fakeRecentSummary()
    const node = createPostTurnMemoryNode({
      windowMemory: window,
      recentSummary: summary,
      summaryTriggerMessages: 12
    })

    await node(fixtureState())

    const msgs = await window.read(7, 's-1')
    assert.equal(msgs.length, 2)
    assert.equal(msgs[0].role, 'user')
    assert.equal(msgs[1].role, 'assistant')
  })

  it('updates L3 summary at threshold', async () => {
    const upsertCalls = []
    const window = fakeWindowMemory(
      Array.from({ length: 11 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
        ts: Date.now()
      }))
    )
    const summary = fakeRecentSummary(null, { upsertCalls })
    const node = createPostTurnMemoryNode({
      windowMemory: window,
      recentSummary: summary,
      summaryTriggerMessages: 12
    })

    await node(fixtureState())

    // After appending 2 new messages, total should be 13 >= 12 → triggers
    const msgs = await window.read(7, 's-1')
    assert.ok(msgs.length >= 12, `expected >= 12 messages, got ${msgs.length}`)
    assert.equal(upsertCalls.length, 1)
  })

  it('does NOT update L3 below threshold', async () => {
    const upsertCalls = []
    const window = fakeWindowMemory([
      { role: 'user', content: 'hello', ts: Date.now() }
    ])
    const summary = fakeRecentSummary(null, { upsertCalls })
    const node = createPostTurnMemoryNode({
      windowMemory: window,
      recentSummary: summary,
      summaryTriggerMessages: 12
    })

    await node(fixtureState())

    // 1 + 2 = 3 < 12 → no trigger
    assert.equal(upsertCalls.length, 0)
  })

  it('returns non-fatal error on summary failure without throwing', async () => {
    const window = fakeWindowMemory(
      Array.from({ length: 11 }, (_, i) => ({
        role: 'user',
        content: `msg${i}`,
        ts: Date.now()
      }))
    )
    const summary = {
      read: async () => ({ currentTopics: [], recentReferences: [], unfinishedTasks: [], analysisConclusions: [], plannedActions: [], temporaryContext: {} }),
      upsert: async () => { throw new Error('DB unavailable') }
    }
    const node = createPostTurnMemoryNode({
      windowMemory: window,
      recentSummary: summary,
      summaryTriggerMessages: 12
    })

    const result = await node(fixtureState())

    assert.deepEqual(result.errors, [{ code: 'SUMMARY_UPDATE_FAILED', degraded: true }])
  })

  it('handles missing response gracefully', async () => {
    const window = fakeWindowMemory()
    const summary = fakeRecentSummary()
    const node = createPostTurnMemoryNode({
      windowMemory: window,
      recentSummary: summary,
      summaryTriggerMessages: 12
    })

    const result = await node(fixtureState({
      response: { message: '' }
    }))

    // Should still complete without throwing
    assert.deepEqual(result.errors ?? [], [])
  })
})
