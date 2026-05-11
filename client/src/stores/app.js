import { defineStore } from 'pinia'
import { api } from '../utils/api.js'

export const useAppStore = defineStore('app', {
  state: () => ({
    messages: [],
    todayExpense: 0,
    monthlyStats: null,
    loading: false,
    sidebarOpen: true
  }),

  actions: {
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

        // 如果是记账，刷新今日汇总
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

    toggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen
    }
  }
})
