const { api } = require('../../utils/api.js')
const { getToken } = require('../../utils/auth.js')

Page({
  data: {
    activePeriod: 'month',
    report: null,
    records: [],
    loadError: '',
    hasCategories: false,
    hasTrends: false,
    pieReady: false,
    trendReady: false,
    pieEc: { lazyLoad: true },
    trendEc: { lazyLoad: true },
    editRec: null,
    editForm: {},
    savingEdit: false,
    categories: ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他']
  },

  onShow() {
    if (!getToken()) { wx.redirectTo({ url: '/pages/login/login' }); return }
    this.loadAll()
  },

  switchPeriod(e) { this.setData({ activePeriod: e.currentTarget.dataset.period }); this.loadAll() },

  async loadAll() {
    this.setData({ loadError: '' })
    try {
      const [rRes, recRes] = await Promise.all([api.getReportTimerange(this.data.activePeriod), api.getRecords({ limit: 50 })])
      if (!rRes.success && rRes.error === '登录已过期') { wx.redirectTo({ url: '/pages/login/login' }); return }
      if (rRes.success) {
        const d = rRes.data
        this.setData({
          report: { ...d, incomeText: (d.income || 0).toFixed(0), expenseText: (d.expense || 0).toFixed(0), balanceText: (d.balance >= 0 ? '+' : '') + (d.balance || 0).toFixed(0) },
          hasCategories: (d.categories || []).length > 0,
          hasTrends: (d.trends || []).length > 0
        })
        this.renderCharts(d)
      } else { this.setData({ loadError: '数据加载失败' }) }
      if (recRes.success) {
        this.setData({ records: (recRes.data || []).map(r => ({ ...r, amount: Number(r.amount) || 0, amountText: (Number(r.amount) || 0).toFixed(2) })) })
      }
    } catch { this.setData({ loadError: '网络错误，请刷新重试' }) }
  },

  renderCharts(d) {
    if ((d.categories || []).length > 0) {
      // Use a simple canvas drawing approach instead of full echarts import
      // For now, render pie with basic wx:for list as fallback
      // The ec-canvas will be set up when echarts.js is available
      const pieEc = { lazyLoad: true }
      this.setData({ pieEc, pieReady: true })
    }
    if ((d.trends || []).length > 0) {
      const trendEc = { lazyLoad: true }
      this.setData({ trendEc, trendReady: true })
    }
  },

  openEdit(e) {
    const id = e.currentTarget.dataset.id
    const rec = this.data.records.find(r => r.id === id)
    if (!rec) return
    this.setData({ editRec: rec, editForm: { type: rec.type, amount: rec.amount, category: rec.category, date: rec.date, merchant: rec.merchant || '', description: rec.description || '' } })
  },

  closeEdit() { this.setData({ editRec: null }) },
  onEditTypeChange(e) { this.setData({ 'editForm.type': e.detail.value === '1' ? 'income' : 'expense' }) },
  onEditField(e) { this.setData({ ['editForm.' + e.currentTarget.dataset.field]: e.detail.value }) },
  onEditCategory(e) { this.setData({ 'editForm.category': this.data.categories[e.detail.value] }) },

  async saveEdit() {
    if (!this.data.editRec || this.data.savingEdit) return
    this.setData({ savingEdit: true })
    try {
      await api.updateRecord(this.data.editRec.id, this.data.editForm)
      this.setData({ editRec: null, savingEdit: false })
      this.loadAll()
    } catch { this.setData({ savingEdit: false }) }
  }
})
