import { randomUUID } from 'crypto'
import db from '../db.js'
import { cacheGet, cacheSet, getRedisClient } from '../redis.js'

function taskKey(taskId) {
  return `agent:task:${taskId}`
}

export async function markTaskStatus(taskId, status, data = {}) {
  const current = (await cacheGet(taskKey(taskId))) || {}
  await cacheSet(taskKey(taskId), { ...current, ...data, taskId, status, updatedAt: Date.now() }, 3600)

  try {
    const updates = {
      status,
      updated_at: db.fn.now()
    }
    if (data.result) updates.result_json = JSON.stringify(data.result)
    if (data.errorMessage) updates.error_message = data.errorMessage
    if (['succeeded', 'failed', 'timeout'].includes(status)) updates.completed_at = db.fn.now()

    await db('agent_tasks')
      .where({ task_id: taskId })
      .update(updates)
  } catch (error) {
    console.warn('[AgentQueue] MySQL task status skipped:', error.message)
  }
}

export async function enqueueTask(agentType, payload, { taskId = randomUUID(), redis = getRedisClient() } = {}) {
  const task = { taskId, agentType, payload, status: 'queued', createdAt: Date.now() }
  await markTaskStatus(taskId, 'queued', task)

  try {
    if (redis.status === 'wait') await redis.connect()
    await redis.xadd(`stream:agent:${agentType}`, '*', 'payload', JSON.stringify(task), 'taskId', taskId)
  } catch (error) {
    console.warn('[AgentQueue] Redis enqueue fallback:', error.message)
  }

  try {
    await db('agent_tasks').insert({
      task_id: taskId,
      user_id: payload.userId || null,
      agent_type: agentType,
      intent: payload.intent || 'record',
      status: 'queued',
      payload_json: JSON.stringify(payload)
    }).onConflict('task_id').merge()
  } catch (error) {
    console.warn('[AgentQueue] MySQL task insert skipped:', error.message)
  }

  return task
}

export async function waitForTaskResult(taskId, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const task = await cacheGet(taskKey(taskId))
    if (task && ['succeeded', 'failed', 'timeout'].includes(task.status)) return task
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }

  await markTaskStatus(taskId, 'timeout')
  return cacheGet(taskKey(taskId))
}
