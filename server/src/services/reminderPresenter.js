function safeJsonParse(value) {
  if (!value || typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function money(value) {
  const number = Number(value || 0)
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, '')
}

function percentText(value) {
  const number = Number(value || 0)
  return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, '')
}

function budgetCategory(category) {
  return category === 'total' || !category ? '总预算' : String(category)
}

function budgetLabel(category) {
  return category === '总预算' ? category : `${category}预算`
}

function createGenericDisplay(reminder) {
  return {
    kind: 'generic',
    level: 'info',
    levelText: '提醒',
    summary: reminder.title || '提醒',
    detail: reminder.message || '',
    accent: 'primary'
  }
}

function createBudgetDisplay(reminder) {
  const payload = safeJsonParse(reminder.message)
  if (!payload) return createGenericDisplay(reminder)

  const category = budgetCategory(payload.category)
  const label = budgetLabel(category)
  const level = payload.level === 'critical' ? 'critical' : 'warn'
  const levelText = level === 'critical' ? '已超预算' : '接近预算'
  const accent = level === 'critical' ? 'danger' : 'warning'
  const percent = Number(payload.percent || 0)
  const budget = Number(payload.budget || 0)
  const spent = Number(payload.spent || 0)
  const month = payload.month || ''

  return {
    kind: 'budget',
    level,
    levelText,
    summary: `${label}已使用 ${percentText(percent)}%`,
    detail: `${month} ${label} ¥${money(budget)}，已花 ¥${money(spent)}。`.trim(),
    category,
    month,
    percent,
    budget,
    spent,
    accent
  }
}

export function formatReminder(reminder) {
  const display = reminder?.type === 'budget_alert'
    ? createBudgetDisplay(reminder)
    : createGenericDisplay(reminder || {})

  return {
    ...reminder,
    display
  }
}

function priority(reminder) {
  if (reminder.display?.kind === 'budget' && reminder.display.level === 'critical') return 0
  if (reminder.display?.kind === 'budget' && reminder.display.level === 'warn') return 1
  return 2
}

export function sortReminderHighlights(reminders) {
  return [...reminders].sort((a, b) => {
    const byPriority = priority(a) - priority(b)
    if (byPriority !== 0) return byPriority
    return new Date(b.created_at || 0) - new Date(a.created_at || 0)
  })
}
