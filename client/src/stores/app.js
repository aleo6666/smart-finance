import { defineStore } from 'pinia'
import { api } from '../utils/api.js'

export const useAppStore = defineStore('app', {
  state: () => ({
    messages: [],
    todayExpense: 0,
    monthlyStats: null,
    loading: false,
    sidebarOpen: true,
    reminderCount: 0,
    reminders: [],
    reminderHighlights: [],
    showReminderPanel: false,

    // v2: 登录态
    user: null,
    ledgers: [],
    selectedLedgerId: null,
    token: localStorage.getItem('auth_token') || null
  }),

  getters: {
    isLoggedIn: (state) => !!state.token && !!state.user,
    currentLedgerName: (state) => {
      const l = state.ledgers.find(l => l.id === state.selectedLedgerId)
      return l ? l.name : '全部账本'
    }
  },

  actions: {
    // ====== 登录 ======
    setToken(token) {
      this.token = token
      api.setToken(token)
    },

    async loginByWechatMini(code) {
      const res = await api.wechatMiniLogin(code)
      if (res.success) {
        this.setToken(res.data.token)
        await this.loadUser()
      }
      return res
    },

    async loadUser() {
      try {
        const res = await api.getMe()
        if (res.success) {
          this.user = res.data.user
          this.ledgers = res.data.ledgers
          if (this.ledgers.length > 0 && !this.selectedLedgerId) {
            this.selectedLedgerId = this.ledgers[0].id
          }
        }
      } catch {
        this.logout()
      }
    },

    logout() {
      this.token = null
      this.user = null
      this.ledgers = []
      this.selectedLedgerId = null
      api.clearToken()
    },

    selectLedger(id) {
      this.selectedLedgerId = id
    },

    // ====== 聊天 ======
    async sendMessage(text) {
      this.messages.push({ role: 'user', content: text, time: new Date() })
      this.loading = true

      try {
        const res = await api.chat(text)
        const data = res.data

        this.messages.push({
          role: 'assistant',
          content: data.message,
          intent: data.intent,
          data: data.data,
          time: new Date()
        })

        if (data.intent === 'record') {
          await this.refreshToday()
        }

        return data
      } catch {
        this.messages.push({
          role: 'assistant',
          content: '抱歉，网络出了点问题，请稍后再试 😅',
          intent: 'chat',
          time: new Date()
        })
      } finally {
        this.loading = false
      }
    },

    async uploadImage(file) {
      this.messages.push({ role: 'user', content: '📷 上传了一张购物小票...', time: new Date(), isImage: true })
      this.loading = true

      try {
        const res = this.isLoggedIn ? await api.ocrReceipt(file) : await api.uploadReceipt(file)
        if (res.success && res.data.records && res.data.records.length > 0) {
          const data = res.data
          const recordLines = data.records.map(r =>
            `${r.category} ¥${r.amount.toFixed(2)} (${r.description})`
          ).join('\n')

          this.messages.push({
            role: 'assistant',
            content: `📷 ${data.summary}\n\n识别到 ${data.count} 条消费记录：\n${recordLines}\n\n总计：¥${data.totalAmount.toFixed(2)}，已自动记账~`,
            intent: 'record',
            time: new Date()
          })

          await this.refreshToday()
          await this.refreshMonthly()
        } else {
          this.messages.push({
            role: 'assistant',
            content: (res.data && res.data.summary) || '未能识别图片中的消费信息，请确认图片清晰可见或手动输入。',
            intent: 'chat',
            time: new Date()
          })
        }
      } catch {
        this.messages.push({
          role: 'assistant',
          content: '图片上传失败，请检查网络后重试 😅',
          intent: 'chat',
          time: new Date()
        })
      } finally {
        this.loading = false
      }
    },

    async refreshToday() {
      try {
        const res = await api.getTodayReport()
        this.todayExpense = res.data.total
        return res.data
      } catch { return null }
    },

    async refreshMonthly() {
      try {
        const res = await api.getMonthlyReport()
        this.monthlyStats = res.data
        return res.data
      } catch { return null }
    },

    async refreshReminders() {
      try {
        const [cntRes, listRes] = await Promise.all([
          api.getReminderCount(),
          api.getReminders()
        ])
        this.reminderCount = cntRes.data
        this.reminders = listRes.data || []
      } catch { /* ignore */ }
    },

    async refreshReminderHighlights(limit = 3) {
      try {
        const res = await api.getReminderHighlights(limit)
        this.reminderHighlights = res.data || []
      } catch {
        this.reminderHighlights = []
      }
    },

    async markReminderRead(id) {
      await api.markReminderRead(id)
      this.reminders = this.reminders.filter(item => item.id !== id)
      this.reminderHighlights = this.reminderHighlights.filter(item => item.id !== id)
      await this.refreshReminders()
      await this.refreshReminderHighlights()
    },

    async markAllRead() {
      await api.markAllRead()
      this.reminderCount = 0
      this.reminders = []
      this.reminderHighlights = []
    },

    toggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen
    },

    toggleReminderPanel() {
      this.showReminderPanel = !this.showReminderPanel
      if (this.showReminderPanel) this.refreshReminders()
    }
  }
})
