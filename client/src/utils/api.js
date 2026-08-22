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

  const res = await fetch(path, { cache: 'no-store', ...options, headers })
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

  // 简单用户名注册（无需验证码）
  simpleRegister(username, password) {
    return request('/api/auth/simple-register', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    })
  },

  // 简单用户名登录（无需验证码）
  simpleLogin(username, password) {
    return request('/api/auth/simple-login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
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

  // 简单邮箱注册（无需验证码）
  emailQuickRegister(email, password) {
    return request('/api/auth/email/register-simple', {
      method: 'POST',
      body: JSON.stringify({ email, password })
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

  // ====== 语音转写 ======
  transcribeAudio(formData) {
    return request('/api/speech/transcribe', {
      method: 'POST',
      body: formData
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
  },

  // ====== 资产台账 ======
  getAssetsOverview() {
    return request('/api/assets/overview')
  },
  getAssets() {
    return request('/api/assets')
  },
  createAsset(data) {
    return request('/api/assets', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  updateAsset(id, data) {
    return request(`/api/assets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },
  deleteAsset(id) {
    return request(`/api/assets/${id}`, { method: 'DELETE' })
  },
  createLiability(data) {
    return request('/api/assets/liabilities', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  updateLiability(id, data) {
    return request(`/api/assets/liabilities/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },
  deleteLiability(id) {
    return request(`/api/assets/liabilities/${id}`, { method: 'DELETE' })
  },

  // ====== 债务还款 ======
  getDebts() {
    return request('/api/debts')
  },
  getDebtsOverview() {
    return request('/api/debts/overview')
  },
  createDebt(data) {
    return request('/api/debts', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  updateDebt(id, data) {
    return request(`/api/debts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },
  deleteDebt(id) {
    return request(`/api/debts/${id}`, { method: 'DELETE' })
  },

  // ====== 投资组合 ======
  getInvestments() {
    return request('/api/investments')
  },
  getInvestmentsOverview() {
    return request('/api/investments/overview')
  },
  createInvestment(data) {
    return request('/api/investments', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  updateInvestment(id, data) {
    return request(`/api/investments/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },
  deleteInvestment(id) {
    return request(`/api/investments/${id}`, { method: 'DELETE' })
  },

  // ====== 订阅管家 ======
  getSubscriptions(params = {}) {
    const qs = new URLSearchParams(params).toString()
    return request(`/api/subscriptions${qs ? `?${qs}` : ''}`)
  },
  getSubscriptionsOverview() {
    return request('/api/subscriptions/overview')
  },
  getSubscriptionsUpcoming(days = 30) {
    return request(`/api/subscriptions/upcoming?days=${days}`)
  },
  createSubscription(data) {
    return request('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  updateSubscription(id, data) {
    return request(`/api/subscriptions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },
  deleteSubscription(id) {
    return request(`/api/subscriptions/${id}`, { method: 'DELETE' })
  },

  // ====== 个税测算 ======
  calculateTax(data) {
    return request('/api/tax/calculate', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  getTaxRecords() {
    return request('/api/tax/records')
  },
  deleteTaxRecord(id) {
    return request(`/api/tax/records/${id}`, { method: 'DELETE' })
  },

  // ====== 保单管理 ======
  getInsurancePolicies() {
    return request('/api/insurance')
  },
  getInsuranceOverview() {
    return request('/api/insurance/overview')
  },
  createInsurancePolicy(data) {
    return request('/api/insurance', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  updateInsurancePolicy(id, data) {
    return request(`/api/insurance/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },
  deleteInsurancePolicy(id) {
    return request(`/api/insurance/${id}`, { method: 'DELETE' })
  },

  // ====== 财务健康 ======
  getHealthScore() {
    return request('/api/health-score')
  },

  // ====== 通知中心 ======
  getNotifications(limit = 50) {
    return request(`/api/notifications?limit=${limit}`)
  },
  getNotificationsCount() {
    return request('/api/notifications/count')
  },
  markNotificationRead(id) {
    return request(`/api/notifications/${id}/read`, { method: 'PUT' })
  },
  markNotificationsAllRead() {
    return request('/api/notifications/read-all', { method: 'PUT' })
  },
  deleteNotification(id) {
    return request(`/api/notifications/${id}`, { method: 'DELETE' })
  },

  // ====== 家庭共享 ======
  getFamilyTeams() {
    return request('/api/family/teams')
  },
  createFamilyTeam(data) {
    return request('/api/family/teams', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  joinFamilyTeam(inviteCode) {
    return request('/api/family/teams/join', {
      method: 'POST',
      body: JSON.stringify({ invite_code: inviteCode })
    })
  },
  getFamilyTeamDetail(id) {
    return request(`/api/family/teams/${id}`)
  },
  addFamilyMember(teamId, email) {
    return request(`/api/family/teams/${teamId}/members`, {
      method: 'POST',
      body: JSON.stringify({ email })
    })
  },
  removeFamilyMember(teamId, memberId) {
    return request(`/api/family/teams/${teamId}/members/${memberId}`, { method: 'DELETE' })
  },
  disbandFamilyTeam(id) {
    return request(`/api/family/teams/${id}`, { method: 'DELETE' })
  },
  getSharedLedgers() {
    return request('/api/family/ledgers')
  },
  shareLedger(teamId, ledgerId) {
    return request('/api/family/ledgers', {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId, ledger_id: ledgerId })
    })
  },
  unshareLedger(memberId) {
    return request(`/api/family/ledgers/${memberId}`, { method: 'DELETE' })
  },
  getSharedLedgerRecords(ledgerId, limit = 50) {
    return request(`/api/family/ledgers/${ledgerId}/records?limit=${limit}`)
  },

  // ====== 隐私中心 ======
  getConsents() {
    return request('/api/privacy/consents')
  },
  upsertConsent(data) {
    return request('/api/privacy/consents', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  getPrivacyData() {
    return request('/api/privacy/data')
  },

  // ====== 会话扩展 ======
  refreshToken() {
    return request('/api/auth/refresh', { method: 'POST' })
  },
  logout() {
    return request('/api/auth/logout', { method: 'POST' })
  },
  deleteAccount() {
    return request('/api/auth/account', { method: 'DELETE' })
  }
}
