const { getToken, clearToken } = require('./auth.js')

function getDeviceId() {
  let id = wx.getStorageSync('device_id')
  if (!id) {
    id = 'wx-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    wx.setStorageSync('device_id', id)
  }
  return id
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const token = getToken()
    const headers = {
      'X-Device-Id': getDeviceId(),
      'Content-Type': 'application/json',
      ...options.header
    }
    if (token) {
      headers['Authorization'] = 'Bearer ' + token
    }

    wx.request({
      url: path,
      method: options.method || 'GET',
      data: options.body,
      header: headers,
      success(res) {
        if (res.statusCode === 401) {
          clearToken()
        }
        resolve(res.data)
      },
      fail(err) {
        reject(err)
      }
    })
  })
}

function uploadFile(path, filePath, formData = {}) {
  return new Promise((resolve, reject) => {
    const token = getToken()
    wx.uploadFile({
      url: path,
      filePath: filePath,
      name: 'image',
      formData,
      header: {
        'Authorization': 'Bearer ' + token,
        'X-Device-Id': getDeviceId()
      },
      success(res) {
        if (res.statusCode === 401) clearToken()
        resolve(JSON.parse(res.data))
      },
      fail(err) {
        reject(err)
      }
    })
  })
}

const BASE = 'https://lisheng666.xyz'

const api = {
  setToken(token) { wx.setStorageSync('auth_token', token) },

  // Login
  register(username, password) {
    return request(BASE + '/api/auth/register', { method: 'POST', body: { username, password } })
  },
  login(username, password) {
    return request(BASE + '/api/auth/login', { method: 'POST', body: { username, password } })
  },
  wechatMiniLogin(code) {
    return request(BASE + '/api/auth/wechat-mini', { method: 'POST', body: { code } })
  },
  wechatPhoneLogin(code, encryptedData, iv) {
    return request(BASE + '/api/auth/wechat-phone', { method: 'POST', body: { code, encryptedData, iv } })
  },
  getMe() {
    return request(BASE + '/api/auth/me')
  },

  // Chat
  chat(message) {
    return request(BASE + '/api/chat', { method: 'POST', body: { message } })
  },

  // Records
  getRecords(params = {}) {
    const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&')
    return request(BASE + '/api/records?' + qs)
  },
  updateRecord(id, data) {
    return request(BASE + '/api/records/' + id, { method: 'PUT', body: data })
  },

  // OCR
  ocrReceipt(filePath) {
    return uploadFile(BASE + '/api/records/ocr', filePath)
  },
  confirmOcr(ocrSessionId, records) {
    return request(BASE + '/api/records/ocr/confirm', { method: 'POST', body: { ocrSessionId, records } })
  },
  cancelOcr(ocrSessionId) {
    return request(BASE + '/api/records/ocr/cancel', { method: 'POST', body: { ocrSessionId } })
  },

  // Reports
  getReportTimerange(period = 'month') {
    return request(BASE + '/api/reports/timerange?period=' + period)
  },
  getTodayReport() {
    return request(BASE + '/api/reports/today')
  },
  getMonthlyReport(month) {
    const qs = month ? '?month=' + month : ''
    return request(BASE + '/api/reports/monthly' + qs)
  },

  // Goals
  getGoals() {
    return request(BASE + '/api/goals')
  },
  createGoal(data) {
    return request(BASE + '/api/goals', { method: 'POST', body: data })
  },
  updateGoal(id, data) {
    return request(BASE + '/api/goals/' + id, { method: 'PUT', body: data })
  },
  deleteGoal(id) {
    return request(BASE + '/api/goals/' + id, { method: 'DELETE' })
  },
  getBudgets() {
    return request(BASE + '/api/goals/budgets')
  },
  setBudget(data) {
    return request(BASE + '/api/goals/budgets', { method: 'POST', body: data })
  },

  // Reminders
  getReminders(params = {}) {
    const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&')
    return request(BASE + '/api/reminders?' + qs)
  },
  getReminderCount() {
    return request(BASE + '/api/reminders/count')
  },
  getReminderHighlights(limit = 3) {
    return request(BASE + '/api/reminders/highlights?limit=' + limit)
  },
  markReminderRead(id) {
    return request(BASE + '/api/reminders/' + id + '/read', { method: 'PUT' })
  },
  markAllRead() {
    return request(BASE + '/api/reminders/read-all', { method: 'PUT' })
  },

  // Exchange rates
  getExchangeRates() {
    return request(BASE + '/api/exchange/latest')
  },
  getExchangeDetail(currency) {
    return request(BASE + '/api/exchange/detail/' + currency)
  },

  // Feedback
  submitFeedback(formData) {
    return request(BASE + '/api/feedback', { method: 'POST', body: formData })
  },
  checkSurvey() {
    return request(BASE + '/api/feedback/survey')
  },
  submitSurvey(rating, comment) {
    return request(BASE + '/api/feedback/survey', { method: 'POST', body: { rating, comment } })
  }
}

module.exports = { api }
