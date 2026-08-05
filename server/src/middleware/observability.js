/**
 * Agent 可观测性 — 轻量级指标收集
 * 用内存存储（重启清空），记录最近 1 小时数据
 */
const metrics = {
  agent_calls: 0,
  agent_errors: 0,
  total_tokens: 0,
  total_latency_ms: 0,
  by_agent: {},
  start_time: Date.now(),
}

export function recordAgentCall(agentName, tokens, latencyMs, success = true) {
  metrics.agent_calls++
  metrics.total_tokens += tokens
  metrics.total_latency_ms += latencyMs

  if (!success) {
    metrics.agent_errors++
  }

  if (!metrics.by_agent[agentName]) {
    metrics.by_agent[agentName] = { calls: 0, errors: 0, tokens: 0, latency_ms: 0 }
  }
  const a = metrics.by_agent[agentName]
  a.calls++
  a.tokens += tokens
  a.latency_ms += latencyMs
  if (!success) a.errors++
}

export function getMetrics() {
  const uptimeMs = Date.now() - metrics.start_time
  const avgLatency = metrics.agent_calls > 0
    ? Math.round(metrics.total_latency_ms / metrics.agent_calls)
    : 0

  return {
    uptime_seconds: Math.round(uptimeMs / 1000),
    agent: {
      calls: metrics.agent_calls,
      errors: metrics.agent_errors,
      error_rate: metrics.agent_calls > 0
        ? (metrics.agent_errors / metrics.agent_calls * 100).toFixed(1) + '%'
        : '0%',
      total_tokens: metrics.total_tokens,
      avg_latency_ms: avgLatency,
    },
    by_agent: Object.entries(metrics.by_agent).map(([name, data]) => ({
      name,
      calls: data.calls,
      errors: data.errors,
      tokens: data.tokens,
      avg_latency_ms: data.calls > 0 ? Math.round(data.latency_ms / data.calls) : 0,
    })),
  }
}
