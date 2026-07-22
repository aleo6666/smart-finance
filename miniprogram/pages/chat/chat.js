const { api } = require('../../utils/api.js')
const { getToken } = require('../../utils/auth.js')

Page({
  data: {
    messages: [],
    input: '',
    loading: false,
    scrollToId: '',
    ocrPending: false,
    ocrRecords: [],
    ocrSessionId: '',
    savingOcr: false,
    showRates: false,
    rates: []
  },

  onShow() {
    if (!getToken()) {
      wx.redirectTo({ url: '/pages/login/login' })
      return
    }
    this.loadRates()
  },

  onInput(e) { this.setData({ input: e.detail.value }) },

  async send() {
    const text = this.data.input.trim()
    if (!text || this.data.loading) return
    const messages = [...this.data.messages, { role: 'user', content: text, time: this.formatTime() }]
    this.setData({ input: '', messages, loading: true })
    this.scrollBottom()
    try {
      const res = await api.chat(text)
      if (res.success) {
        messages.push({ role: 'assistant', content: res.data.message, intent: res.data.intent, time: this.formatTime() })
      } else {
        messages.push({ role: 'assistant', content: '抱歉，出了点问题，请重试 😅', time: this.formatTime() })
      }
    } catch {
      messages.push({ role: 'assistant', content: '网络错误，请稍后重试 😅', time: this.formatTime() })
    }
    this.setData({ messages, loading: false })
    this.scrollBottom()
  },

  sendQuick(e) {
    this.setData({ input: e.currentTarget.dataset.text })
    this.send()
  },

  formatTime() {
    const d = new Date()
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
  },

  scrollBottom() {
    const len = this.data.messages.length
    if (len > 0) this.setData({ scrollToId: 'msg-' + (len - 1) })
  },

  takePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera'],
      success: (res) => this.doOcr(res.tempFiles[0].tempFilePath)
    })
  },

  async doOcr(filePath) {
    this.setData({ loading: true })
    try {
      const res = await api.ocrReceipt(filePath)
      if (res.success && res.data.records && res.data.records.length > 0) {
        this.setData({
          ocrSessionId: res.data.ocrSessionId || '',
          ocrRecords: res.data.records.map(r => ({ ...r, date: r.date || new Date().toISOString().slice(0, 10) })),
          ocrPending: true,
          loading: false
        })
      } else {
        const messages = [...this.data.messages, { role: 'assistant', content: res.data?.summary || '未能识别图片中的消费信息', time: this.formatTime() }]
        this.setData({ messages, loading: false })
        this.scrollBottom()
      }
    } catch {
      const messages = [...this.data.messages, { role: 'assistant', content: '图片识别失败，请重试', time: this.formatTime() }]
      this.setData({ messages, loading: false })
      this.scrollBottom()
    }
  },

  onOcrRemove(e) {
    const records = [...this.data.ocrRecords]
    records.splice(e.detail.index, 1)
    this.setData({ ocrRecords: records })
    if (records.length === 0) this.onOcrCancel()
  },

  async onOcrCancel() {
    const sessionId = this.data.ocrSessionId
    this.setData({ ocrPending: false, ocrRecords: [], ocrSessionId: '' })
    if (sessionId) await api.cancelOcr(sessionId).catch(() => {})
  },

  async onOcrConfirm() {
    const sessionId = this.data.ocrSessionId
    if (!sessionId) { this.setData({ ocrPending: false, ocrRecords: [] }); return }
    this.setData({ savingOcr: true })
    try {
      const records = this.data.ocrRecords.filter(r => r.amount && r.category && r.date).map(r => ({
        type: r.type || 'expense', amount: Number(r.amount), category: r.category,
        description: r.description || r.category, date: r.date, merchant: r.merchant || null
      }))
      const res = await api.confirmOcr(sessionId, records)
      if (res.success) {
        const saved = res.data.records || []
        const total = saved.reduce((s, r) => s + Number(r.amount_cny || r.amount || 0), 0)
        this.data.messages.push({ role: 'assistant', content: '📷 已保存 ' + saved.length + ' 条消费记录，合计 ¥' + total.toFixed(2), time: this.formatTime() })
      }
    } catch {}
    this.setData({ savingOcr: false, ocrPending: false, ocrRecords: [], ocrSessionId: '' })
    this.scrollBottom()
  },

  toggleRates() {
    this.setData({ showRates: !this.data.showRates })
    if (this.data.showRates && this.data.rates.length === 0) this.loadRates()
  },

  async loadRates() {
    try {
      const res = await api.getExchangeRates()
      if (res.data) {
        const config = [{ code: 'USD', flag: '🇺🇸' }, { code: 'EUR', flag: '🇪🇺' }, { code: 'JPY', flag: '🇯🇵' }, { code: 'GBP', flag: '🇬🇧' }, { code: 'HKD', flag: '🇭🇰' }, { code: 'KRW', flag: '🇰🇷' }]
        const rates = config.map(c => ({ code: c.code, flag: c.flag, rateText: res.data[c.code] ? Number(res.data[c.code].rate).toFixed(4) : '—' }))
        this.setData({ rates })
      }
    } catch {}
  }
})
