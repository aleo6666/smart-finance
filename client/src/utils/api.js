function getDeviceId() {
  let id = localStorage.getItem('device_id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('device_id', id)
  }
  return id
}

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Device-Id': getDeviceId(),
    ...options.headers
  }

  const res = await fetch(path, { ...options, headers })
  const json = await res.json()

  // 如果服务端返回了新的设备ID
  const newId = res.headers.get('X-Device-Id')
  if (newId) localStorage.setItem('device_id', newId)

  return json
}

export const api = {
  // 聊天
  chat(message) {
    return request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message })
    })
  },

  // 记录
  getRecords(params = {}) {
    const qs = new URLSearchParams(params).toString()
    return request(`/api/records?${qs}`)
  },
  createRecord(data) {
    return request('/api/records', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  deleteRecord(id) {
    return request(`/api/records/${id}`, { method: 'DELETE' })
  },

  // 报告
  getMonthlyReport(month) {
    const qs = month ? `?month=${month}` : ''
    return request(`/api/reports/monthly${qs}`)
  },
  getCategoryReport(month) {
    const qs = month ? `?month=${month}` : ''
    return request(`/api/reports/category${qs}`)
  },
  getTrend(months = 6) {
    return request(`/api/reports/trend?months=${months}`)
  },
  getTodayReport() {
    return request('/api/reports/today')
  },

  // 目标
  getGoals() {
    return request('/api/goals')
  },
  createGoal(data) {
    return request('/api/goals', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  updateGoal(id, data) {
    return request(`/api/goals/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },
  deleteGoal(id) {
    return request(`/api/goals/${id}`, { method: 'DELETE' })
  },
  getBudgets() {
    return request('/api/goals/budgets')
  },
  setBudget(data) {
    return request('/api/goals/budgets', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  }
}
