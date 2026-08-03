function getDeviceId() {
  let id = localStorage.getItem('device_id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('device_id', id)
  }
  return id
}

function getToken() {
  return localStorage.getItem('auth_token')
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

  const token = getToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  if (!isForm) {
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(path, { ...options, headers })
  const json = await res.json()

  const newId = res.headers.get('X-Device-Id')
  if (newId) localStorage.setItem('device_id', newId)

  return json
}

/* 下载二进制文件 */
async function downloadBlob(path, filename) {
  const res = await fetch(path, {
    headers: {
      'Authorization': `Bearer ${getToken()}`,
      'X-Device-Id': getDeviceId()
    }
  })
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export const api = {
  // ====== v2: 鉴权 ======
  setToken(token) {
    localStorage.setItem('auth_token', token)
  },
  clearToken() {
    localStorage.removeItem('auth_token')
  },
  isLoggedIn() {
    return !!getToken()
  },

  // 用户名密码注册
  register(phone, code, password) {
    return request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ phone, code, password })
    })
  },

  // 用户名密码登录
  login(phone, password) {
    return request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone, password })
    })
  },

  // 发送短信验证码
  sendCode(phone) {
    return request('/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ phone })
    })
  },

  // 忘记密码 — 重置
  resetPassword(phone, code, password) {
    return request('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ phone, code, password })
    })
  },

  emailSendCode(email, purpose) {
    return request('/api/auth/email/send-code', {
      method: 'POST',
      body: JSON.stringify({ email, purpose })
    })
  },

  emailRegister(email, code, password) {
    return request('/api/auth/email/register', {
      method: 'POST',
      body: JSON.stringify({ email, code, password })
    })
  },

  emailLogin(email, password) {
    return request('/api/auth/email/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    })
  },

  emailResetPassword(email, code, password) {
    return request('/api/auth/email/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email, code, password })
    })
  },

  // 小程序登录
  wechatMiniLogin(code) {
    return request('/api/auth/wechat-mini', {
      method: 'POST',
      body: JSON.stringify({ code })
    })
  },

  // 开发环境模拟登录（跳过微信）
  mockLogin() {
    return request('/api/auth/mock-login', { method: 'POST' })
  },

  // 绑定手机号
  bindPhone(phone) {
    return request('/api/auth/bind-phone', {
      method: 'POST',
      body: JSON.stringify({ phone })
    })
  },

  // 获取当前用户信息 + 账本列表
  getMe() {
    return request('/api/auth/me')
  },

  // ====== v2: 账本 ======
  getLedgers() {
    return request('/api/ledgers')
  },
  createLedger(data) {
    return request('/api/ledgers', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  updateLedger(id, data) {
    return request(`/api/ledgers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },
  deleteLedger(id) {
    return request(`/api/ledgers/${id}`, { method: 'DELETE' })
  },

  // ====== 聊天 ======
  chat(message, options = {}) {
    return request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message, use3Agent: true, ...options })
    })
  },

  // ====== v2: 记录（多维筛选） ======
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
  updateRecord(id, data) {
    return request(`/api/records/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },
  deleteRecord(id) {
    return request(`/api/records/${id}`, { method: 'DELETE' })
  },

  // OCR 识别（不自动保存，返回识别结果供用户确认）
  ocrImage(file) {
    return this.ocrReceipt(file)
  },
  ocrReceipt(file) {
    const formData = new FormData()
    formData.append('image', file)
    return request('/api/records/ocr', {
      method: 'POST',
      body: formData
    })
  },
  confirmOcr(ocrSessionId, records) {
    return request('/api/records/ocr/confirm', {
      method: 'POST',
      body: JSON.stringify({ ocrSessionId, records })
    })
  },
  cancelOcr(ocrSessionId) {
    return request('/api/records/ocr/cancel', {
      method: 'POST',
      body: JSON.stringify({ ocrSessionId })
    })
  },
  importRecords(csv) {
    return request('/api/records/import', {
      method: 'POST',
      body: JSON.stringify({ csv })
    })
  },

  // ====== v2: 报表 ======
  getReportTimerange(period = 'month', ledgerId = null) {
    const params = new URLSearchParams({ period })
    if (ledgerId) params.set('ledgerId', ledgerId)
    return request(`/api/reports/timerange?${params.toString()}`)
  },
  getReportSummary(params = {}) {
    const qs = new URLSearchParams(params).toString()
    return request(`/api/reports/summary?${qs}`)
  },
  generateReport(data) {
    return request('/api/reports/generate', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  getReportHistory() {
    return request('/api/reports/history')
  },
  shareReport(id) {
    return request(`/api/reports/share/${id}`, { method: 'POST' })
  },

  // ====== v2: 导出 ======
  exportExcel(params = {}) {
    const qs = new URLSearchParams(params).toString()
    return downloadBlob(`/api/export/excel?${qs}`, 'report.xlsx')
  },
  exportPdf(params = {}) {
    const qs = new URLSearchParams(params).toString()
    return downloadBlob(`/api/export/pdf?${qs}`, 'report.pdf')
  },
  exportImage(params = {}) {
    const qs = new URLSearchParams(params).toString()
    return downloadBlob(`/api/export/image?${qs}`, 'report.png')
  },
  createShareUrl(data) {
    return request('/api/export/share', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },

  // ====== 旧版兼容（仍可用） ======
  getMonthlyReport(month, ledgerId = null) {
    const params = new URLSearchParams()
    if (month) params.set('month', month)
    if (ledgerId) params.set('ledgerId', ledgerId)
    const qs = params.toString()
    return request(`/api/reports/monthly${qs ? `?${qs}` : ''}`)
  },
  getCategoryReport(month) {
    const qs = month ? `?month=${month}` : ''
    return request(`/api/reports/category${qs}`)
  },
  getTrend(months = 6) {
    return request(`/api/reports/trend?months=${months}`)
  },
  getTodayReport(ledgerId = null) {
    const qs = ledgerId ? `?ledgerId=${ledgerId}` : ''
    return request(`/api/reports/today${qs}`)
  },

  // ====== 目标 ======
  getGoals(ledgerId) {
    const qs = ledgerId ? `?ledgerId=${ledgerId}` : ''
    return request(`/api/goals${qs}`)
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
  getBudgets(ledgerId) {
    const qs = ledgerId ? `?ledgerId=${ledgerId}` : ''
    return request(`/api/goals/budgets${qs}`)
  },
  setBudget(data) {
    return request('/api/goals/budgets', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },

  // ====== 提醒 + 订阅 ======
  getReminders(params = {}) {
    const qs = new URLSearchParams(params).toString()
    return request(`/api/reminders${qs ? `?${qs}` : ''}`)
  },
  getReminderCount() {
    return request('/api/reminders/count')
  },
  getReminderHighlights(limit = 3) {
    return request(`/api/reminders/highlights?limit=${limit}`)
  },
  markReminderRead(id) {
    return request(`/api/reminders/${id}/read`, { method: 'PUT' })
  },
  markAllRead() {
    return request('/api/reminders/read-all', { method: 'PUT' })
  },
  subscribeMessage(openid) {
    return request('/api/reminders/subscribe', {
      method: 'POST',
      body: JSON.stringify({ openid })
    })
  },

  // ====== 识图上传（旧版兼容） ======
  async uploadReceipt(file) {
    const formData = new FormData()
    formData.append('image', file)
    const res = await fetch('/api/vision', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'X-Device-Id': getDeviceId()
      },
      body: formData
    })
    return res.json()
  },

  // ====== 汇率 ======
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
  },

  // ====== 反馈 ======
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

  // ====== 账单导入 ======
  importUploadFile(file, ledgerId) {
    const formData = new FormData()
    formData.append('file', file)
    if (ledgerId) formData.append('ledgerId', ledgerId)
    return request('/api/import/upload', {
      method: 'POST',
      body: formData
    })
  },
  importPaste(content, ledgerId) {
    return request('/api/import/paste', {
      method: 'POST',
      body: JSON.stringify({ content, ledgerId })
    })
  },
  getImportBatches(page = 1, pageSize = 20) {
    return request(`/api/import/batches?page=${page}&pageSize=${pageSize}`)
  },
  getImportBatch(id) {
    return request(`/api/import/${id}`)
  },
  updateImportRecord(batchId, recordId, updates) {
    return request(`/api/import/${batchId}/records/${recordId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })
  },
  selectImportRecords(batchId, recordIds, selected) {
    return request(`/api/import/${batchId}/select`, {
      method: 'POST',
      body: JSON.stringify({ recordIds, selected })
    })
  },
  confirmImport(batchId, selectedIds) {
    return request(`/api/import/${batchId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ selectedIds })
    })
  },
  rollbackImport(batchId) {
    return request(`/api/import/${batchId}/rollback`, {
      method: 'POST'
    })
  }
}
