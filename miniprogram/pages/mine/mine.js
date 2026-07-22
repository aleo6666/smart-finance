const { api } = require('../../utils/api.js')
const { clearToken } = require('../../utils/auth.js')
const app = getApp()

Page({
  data: {
    user: {},
    showFeedbackModal: false,
    showAboutModal: false,
    feedbackContent: '',
    feedbackType: 'suggestion',
    submitting: false,
    submitOk: false
  },

  onShow() {
    this.setData({ user: app.globalData.user || {} })
  },

  showFeedback() { this.setData({ showFeedbackModal: true, submitOk: false }) },
  closeFeedback() { this.setData({ showFeedbackModal: false }) },
  showAbout() { this.setData({ showAboutModal: true }) },
  closeAbout() { this.setData({ showAboutModal: false }) },

  onFeedbackInput(e) { this.setData({ feedbackContent: e.detail.value }) },
  setFeedbackType(e) { this.setData({ feedbackType: e.currentTarget.dataset.type }) },

  async submitFeedback() {
    if (!this.data.feedbackContent.trim()) return
    this.setData({ submitting: true })
    try {
      await api.submitFeedback({ type: this.data.feedbackType, content: this.data.feedbackContent.trim() })
      this.setData({ submitOk: true, submitting: false, feedbackContent: '' })
      setTimeout(() => this.closeFeedback(), 1500)
    } catch { this.setData({ submitting: false }) }
  },

  logout() {
    clearToken()
    app.globalData.user = null
    app.globalData.token = ''
    wx.reLaunch({ url: '/pages/login/login' })
  }
})
