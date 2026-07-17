import db from '../db.js'

const COST_SPIKE_THRESHOLD = 0.5

function money(value) {
  return Number(value || 0).toFixed(4)
}

function dateText(date) {
  return date.toISOString().slice(0, 10)
}

function sinceDate(now, days) {
  const since = new Date(now)
  since.setUTCDate(since.getUTCDate() - days)
  return since.toISOString().slice(0, 19).replace('T', ' ')
}

async function hasPendingToday({ userId, type, now, dbClient }) {
  const rows = await dbClient('reminders')
    .where({ user_id: userId, type, status: 'pending' })
  const today = dateText(now)
  return rows.some(row => String(row.created_at || '').slice(0, 10) === today)
}

async function createReminder({ userId, type, title, message, severity, dbClient }) {
  await dbClient('reminders').insert({
    user_id: userId,
    type,
    title,
    message,
    channel: 'inapp',
    status: 'pending'
  })
  return { type, severity }
}

async function createOnceToday(input) {
  if (await hasPendingToday(input)) return null
  return createReminder(input)
}

async function getActiveRule({ userId, dbClient }) {
  const userRule = await dbClient('cost_alert_rules')
    .where({ user_id: userId, enabled: 1 })
    .first()
  if (userRule) return userRule
  return dbClient('cost_alert_rules')
    .where({ enabled: 1 })
    .whereNull('user_id')
    .first()
}

async function sumPeriodCost({ userId, periodDays, now, dbClient }) {
  const since = sinceDate(now, periodDays)
  const rows = await dbClient('llm_calls').where({ user_id: userId })
  return rows
    .filter(row => !row.created_at || new Date(row.created_at) >= new Date(since))
    .reduce((sum, row) => sum + Number(row.cost_usd || 0), 0)
}

async function recentFailures({ userId, dbClient }) {
  const rows = await dbClient('llm_calls')
    .where({ user_id: userId })
    .orderBy('created_at', 'desc')
    .limit(3)
  return rows.length === 3 && rows.every(row => Number(row.success) === 0)
}

export async function checkObserveAlerts({
  userId,
  lastCall = {},
  now = new Date(),
  dbClient = db
}) {
  const created = []
  if (!userId) return { created }

  const costUsd = Number(lastCall.costUsd ?? lastCall.cost_usd ?? 0)
  if (costUsd > COST_SPIKE_THRESHOLD) {
    const alert = await createOnceToday({
      userId,
      type: 'alert:cost_spike',
      title: '[WARNING] AI 成本告警',
      message: `AI 单次调用成本较高：$${money(costUsd)}`,
      severity: 'warning',
      now,
      dbClient
    })
    if (alert) created.push(alert)
  }

  const rule = await getActiveRule({ userId, dbClient })
  if (rule) {
    const total = await sumPeriodCost({ userId, periodDays: Number(rule.period_days || 1), now, dbClient })
    const threshold = Number(rule.threshold_usd || 0)
    if (threshold > 0 && total > threshold) {
      const alert = await createOnceToday({
        userId,
        type: 'alert:cost_threshold',
        title: '[CRITICAL] AI 成本告警',
        message: `AI 成本已超过阈值：$${money(total)} / $${money(threshold)}`,
        severity: 'critical',
        now,
        dbClient
      })
      if (alert) created.push(alert)
    }
  }

  if (await recentFailures({ userId, dbClient })) {
    const alert = await createOnceToday({
      userId,
      type: 'alert:llm_failures',
      title: '[CRITICAL] AI 调用失败',
      message: 'AI 调用连续失败 3 次，请检查服务配置',
      severity: 'critical',
      now,
      dbClient
    })
    if (alert) created.push(alert)
  }

  return { created }
}
