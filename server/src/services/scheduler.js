import cron from 'node-cron'
import db from '../db.js'
import { getContextData, getAnomalies, getBudgetStatus } from './analyzer.js'
import { fetchRates, detectAnomalies } from './exchangeRate.js'

// 获取今天日期
function today() {
  return new Date().toISOString().slice(0, 10)
}

// 检查是否存在同类未读提醒
function hasPendingReminder(deviceId, type) {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM reminders
     WHERE device_id = ? AND type = ? AND status = 'pending'
     AND date(created_at) = date('now','localtime')`
  ).get(deviceId, type)
  return row.cnt > 0
}

// 创建提醒
function createReminder(deviceId, type, title, message) {
  if (hasPendingReminder(deviceId, type)) return
  db.prepare(
    `INSERT INTO reminders (device_id, type, title, message)
     VALUES (?, ?, ?, ?)`
  ).run(deviceId, type, title, message)
  console.log(`[Scheduler] 提醒已生成: ${title}`)
}

// 为所有活跃用户生成提醒
function getActiveDevices() {
  return db.prepare(
    `SELECT DISTINCT device_id FROM records
     WHERE date >= date('now', '-30 days')`
  ).all().map(r => r.device_id)
}

// 每日记账提醒 (每晚20:57)
export function startScheduler() {
  console.log('[Scheduler] 定时服务已启动')

  // ----- 汇率数据 -----
  // 每小时拉取一次汇率
  cron.schedule('0 * * * *', async () => {
    await fetchRates()
  })

  // 汇率异常检测 + 推送通知（每小时05分）
  cron.schedule('5 * * * *', async () => {
    const alerts = detectAnomalies()
    if (alerts.length === 0) return

    const devices = getActiveDevices()
    for (const alert of alerts) {
      for (const deviceId of devices) {
        createReminder(deviceId, 'exchange', alert.title, alert.message)
      }
    }
  })

  // 汇率周报（每周一 10:00）
  cron.schedule('57 9 * * 1', async () => {
    const { generateWeeklyReport } = await import('./exchangeRate.js')
    const report = generateWeeklyReport()
    const lines = Object.entries(report.currencies || {}).map(([cur, d]) =>
      `${cur}: ${d.start}→${d.end} (${d.trend}${d.weekChange}%) | 最高${d.high} 最低${d.low}`
    )
    if (lines.length > 0) {
      const devices = getActiveDevices()
      for (const deviceId of devices) {
        createReminder(deviceId, 'exchange', '📊 本周汇率周报', lines.join('\n'))
      }
    }
  })

  // ----- 原有定时任务 -----

  // 每日记账提醒 (每天08:00)
  cron.schedule('57 7 * * *', async () => {
    console.log('[Scheduler] 执行每日提醒检查...')
    const devices = getActiveDevices()
    for (const deviceId of devices) {
      const td = db.prepare(
        `SELECT COUNT(*) as cnt FROM records
         WHERE device_id = ? AND date = ? AND type = 'expense'`
      ).get(deviceId, today())
      if (td.cnt === 0) {
        createReminder(deviceId, 'daily', '今天还没记账哦~', '记得记录今天的消费，养成记账好习惯！💪')
      }
    }
  })

  // 月末报告提醒 (每月1日 09:00)
  cron.schedule('57 8 1 * *', async () => {
    console.log('[Scheduler] 执行月末报告生成...')
    const devices = getActiveDevices()
    for (const deviceId of devices) {
      const stats = db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) as expense,
                COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) as income
         FROM records WHERE device_id = ? AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month'))`
      ).get(deviceId)
      if (stats.expense > 0) {
        const rate = stats.income > 0 ? ((stats.income - stats.expense) / stats.income * 100).toFixed(1) : 0
        createReminder(deviceId, 'monthly', '📊 上月财务报告已生成',
          `上月收入: ¥${stats.income.toFixed(0)} | 支出: ¥${stats.expense.toFixed(0)} | 储蓄率: ${rate}%`)
      }
    }
  })

  // 预算预警 (每天10:00) - 检查是否接近超支
  cron.schedule('57 9 * * *', async () => {
    const devices = getActiveDevices()
    for (const deviceId of devices) {
      const budgets = getBudgetStatus(deviceId)
      for (const b of budgets) {
        if (b.percent >= 80 && b.percent < 100) {
          createReminder(deviceId, 'budget', `⚠️ 预算预警: ${b.category}`,
            `${b.category}已使用${b.percent}%（¥${b.spent.toFixed(0)}/¥${b.budget}），请注意控制消费~`)
        } else if (b.percent >= 100) {
          createReminder(deviceId, 'budget', `🔴 预算已超支: ${b.category}`,
            `${b.category}已超出预算！（¥${b.spent.toFixed(0)}/¥${b.budget}），建议暂停该类消费`)
        }
      }

      // 消费异常提醒
      const anomalies = getAnomalies(deviceId)
      for (const a of anomalies) {
        if (parseFloat(a.change) > 50) {
          createReminder(deviceId, 'anomaly', `📈 消费异常: ${a.category}`,
            `${a.category}消费环比增长${a.change}%，上月¥${a.previous}→本月¥${a.current}`)
        }
      }
    }
  })
}
