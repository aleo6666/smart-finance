function getDeviceId() {
  let id = localStorage.getItem('device_id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('device_id', id)
  }
  return id
}

function isFormData(body) {
  return body && typeof body === 'object' && body.constructor && body.constructor.name === 'FormData'
}

async function request(path, options = {}) {
  const isForm = isFormData(options.body)
  const headers = {
    'X-Device-Id': getDeviceId(),
    ...options.headers
  }
  // 非 FormData 请求才设置 JSON Content-Type
  if (!isForm) {
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(path, { ...options, headers })
  const json = await res.json()

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
  },

  // 提醒
  getReminders() {
    return request('/api/reminders')
  },
  getReminderCount() {
    return request('/api/reminders/count')
  },
  markReminderRead(id) {
    return request(`/api/reminders/${id}/read`, { method: 'PUT' })
  },
  markAllRead() {
    return request('/api/reminders/read-all', { method: 'PUT' })
  },

  // 反馈（支持 FormData 传递截图）
  submitFeedback(formData) {
    return request('/api/feedback', {
      method: 'POST',
      body: formData
    })
  },
  getFeedback(params = {}) {
    const qs = new URLSearchParams(params).toString()
    return request(`/api/feedback?${qs}`)
  },
  getFeedbackStatus(id) {
    return request(`/api/feedback/status/${id}`)
  },
  checkSurvey() {
    return request('/api/feedback/survey')
  },
  submitSurvey(rating, comment) {
    return request('/api/feedback/survey', {
      method: 'POST',
      body: JSON.stringify({ rating, comment })
    })
  },

  // 识图上传
  async uploadReceipt(file) {
    const formData = new FormData()
    formData.append('image', file)
    const res = await fetch('/api/vision', {
      method: 'POST',
      headers: { 'X-Device-Id': getDeviceId() },
      body: formData
    })
    return res.json()
  },

  // 汇率
  getExchangeRates() {
    return request('/api/exchange/latest')
  },
  getExchangeDetail(currency) {
    return request(`/api/exchange/detail/${currency}`)
  },
  getExchangeAlerts() {
    return request('/api/exchange/alerts')
  },
  getExchangeWeekly() {
    return request('/api/exchange/weekly')
  }
}
