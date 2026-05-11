import db from '../db.js'

// 获取用户的长期记忆
export function getUserMemory(deviceId) {
  const memories = db.prepare(
    'SELECT key, value FROM memory WHERE device_id = ?'
  ).all(deviceId)

  const result = {}
  for (const m of memories) {
    result[m.key] = JSON.parse(m.value)
  }
  return result
}

// 更新用户记忆
export function updateMemory(deviceId, key, value) {
  db.prepare(
    `INSERT INTO memory (device_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(device_id, key) DO UPDATE SET value = ?, updated_at = datetime('now','localtime')`
  ).run(deviceId, key, JSON.stringify(value), JSON.stringify(value))
}

// 自动更新消费习惯记忆
export function updateHabitMemory(deviceId, category, amount) {
  const key = `habit_${category}`
  const existing = getUserMemory(deviceId)
  const habit = existing[key] || { count: 0, total: 0, avg: 0 }

  habit.count += 1
  habit.total += amount
  habit.avg = Math.round(habit.total / habit.count * 100) / 100

  updateMemory(deviceId, key, habit)
}

// 获取用户消费习惯摘要（用于注入 Prompt）
export function getMemoryContext(deviceId) {
  const mem = getUserMemory(deviceId)
  const habits = []

  for (const [k, v] of Object.entries(mem)) {
    if (k.startsWith('habit_')) {
      const cat = k.replace('habit_', '')
      habits.push(`${cat}: 共${v.count}次, 平均${v.avg}元/次`)
    }
  }

  const goals = db.prepare(
    'SELECT * FROM goals WHERE device_id = ? AND completed = 0'
  ).all(deviceId)

  return { habits, goals, preferences: mem.preferences || {} }
}
