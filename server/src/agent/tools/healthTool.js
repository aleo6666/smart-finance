/**
 * Health status tool for the LangGraph agent.
 * Returns basic runtime health metrics.
 */
export function getHealthStatus() {
  return { status: 'ok', uptime: process.uptime() };
}
