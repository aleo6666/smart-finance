import { fetchRates } from './exchangeRate.js'

export function startScheduler() {
  // 启动时立即拉取汇率
  fetchRates().then(ok => {
    if (ok) console.log('[Scheduler] Initial exchange rates fetched')
  }).catch(err => {
    console.error('[Scheduler] Initial fetch failed:', err.message)
  })

  // 每 2 小时更新
  const TWO_HOURS = 2 * 60 * 60 * 1000
  setInterval(() => {
    fetchRates().catch(err => console.error('[Scheduler] Exchange fetch failed:', err.message))
  }, TWO_HOURS)

  console.log('[Scheduler] Exchange rate fetcher started (every 2h)')
}
