import db from '../db.js'

export async function recordAgentEvent({
  userId = null,
  provider = 'local',
  model = 'agent',
  callType = 'agent',
  latencyMs = 0,
  success = true,
  errorMessage = null,
  dbClient = db
}) {
  await dbClient('llm_calls').insert({
    user_id: userId,
    provider,
    model,
    call_type: callType,
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: latencyMs,
    cost_usd: 0,
    success: success ? 1 : 0,
    error_message: errorMessage
  })

  return { status: success ? 'succeeded' : 'failed' }
}

export async function getObserveStats({ userId, dbClient = db } = {}) {
  const query = dbClient('llm_calls')
    .select('call_type')
    .count({ calls: '*' })
    .sum({ total_cost_usd: 'cost_usd' })
    .avg({ avg_latency_ms: 'latency_ms' })
    .groupBy('call_type')

  if (userId) query.where('user_id', userId)

  const llmStats = await query
  return { llmStats }
}
