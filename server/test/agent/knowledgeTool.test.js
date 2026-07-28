import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createKnowledgeTool } from '../../src/agent/tools/knowledgeTool.js'

function fakeRuntime(props = {}) {
  return {
    userId: props.userId ?? 7,
    sessionId: props.sessionId ?? 's-1',
    requestId: props.requestId ?? 'r-1',
    isAdmin: props.isAdmin ?? false,
    deviceType: props.deviceType ?? 'mobile',
    timezone: props.timezone ?? 'Asia/Shanghai',
    locale: props.locale ?? 'zh-CN',
    inputMode: props.inputMode ?? 'text'
  }
}

describe('knowledgeTool', () => {
  it('always filters by user and knowledge space', async () => {
    const calls = []
    const runtime = fakeRuntime({ userId: 7 })
    const search = async (input) => {
      calls.push(input)
      return []
    }
    const tool = createKnowledgeTool({ runtime, search })
    await tool.invoke({ query: '去年类似方案', knowledgeSpaceId: 'personal' })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].userId, 7)
    assert.equal(calls[0].knowledgeSpaceId, 'personal')
    assert.ok(calls[0].query.includes('去年类似方案'))
  })

  it('prevents cross-user data access via search filter', async () => {
    const calls = []
    const runtime = fakeRuntime({ userId: 42 })
    const search = async (input) => {
      calls.push(input)
      return [{ title: 'test', sourceType: 'pdf', text: 'secret' }]
    }
    const tool = createKnowledgeTool({ runtime, search })
    const result = await tool.invoke({ query: '方案', knowledgeSpaceId: 'work' })

    assert.equal(calls[0].userId, 42)
    assert.notEqual(calls[0].userId, 7)
    assert.equal(result.status, 'ok')
    assert.equal(result.results[0].text, 'secret')
  })

  it('returns empty results on search failure without throwing', async () => {
    const runtime = fakeRuntime({ userId: 7 })
    const search = async () => {
      throw new Error('Qdrant unavailable')
    }
    const tool = createKnowledgeTool({ runtime, search })
    const result = await tool.invoke({ query: 'something', knowledgeSpaceId: 'personal' })

    assert.equal(result.status, 'unavailable')
    assert.equal(result.count, 0)
  })

  it('tool schema excludes userId and isAdmin', () => {
    const runtime = fakeRuntime()
    const tool = createKnowledgeTool({ runtime, search: async () => [] })
    const schemaKeys = Object.keys(tool.schema?.shape ?? tool.schema ?? {})

    assert.ok(!schemaKeys.includes('userId'), 'schema must not include userId')
    assert.ok(!schemaKeys.includes('isAdmin'), 'schema must not include isAdmin')
  })
})
