const { api } = require('../../utils/api.js')
const { getToken } = require('../../utils/auth.js')

Page({
  data: {
    goals: [], budgets: [], loading: true, error: '',
    showGoalModal: false, showProgressModal: false, showBudgetModal: false,
    goalForm: { name: '', target_amount: '', deadline: '' },
    progressGoalId: null, progressGoalName: '', progressAmount: '',
    budgetForm: { categoryIndex: 0, amount: '' },
    budgetCategories: ['总预算', '餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他']
  },

  onShow() {
    if (!getToken()) { wx.redirectTo({ url: '/pages/login/login' }); return }
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const [gRes, bRes] = await Promise.all([api.getGoals(), api.getBudgets()])
      if (!gRes.success && gRes.error === '登录已过期') { wx.redirectTo({ url: '/pages/login/login' }); return }
      if (gRes.success) {
        const goals = (gRes.data || []).map(g => ({
          ...g, current_amount: Number(g.current_amount) || 0, target_amount: Number(g.target_amount) || 0,
          currentText: (Number(g.current_amount) || 0).toFixed(0), targetText: (Number(g.target_amount) || 0).toFixed(0),
          percent: g.target_amount > 0 ? Math.round(Number(g.current_amount) / Number(g.target_amount) * 100) : 0
        }))
        this.setData({ goals })
      }
      if (bRes.success) {
        const budgets = (bRes.data || []).map(b => {
          const amount = Number(b.amount) || 0, spent = Number(b.spent) || 0
          return { ...b, amount, spent, amountText: amount.toFixed(0), spentText: spent.toFixed(0), percent: amount > 0 ? Math.round(spent / amount * 100) : 0 }
        })
        this.setData({ budgets })
      }
    } catch { this.setData({ error: '网络错误，请刷新重试' }) }
    finally { this.setData({ loading: false }) }
  },

  showGoalForm() { this.setData({ showGoalModal: true, goalForm: { name: '', target_amount: '', deadline: '' } }) },
  closeGoalModal() { this.setData({ showGoalModal: false }) },
  onGoalField(e) { this.setData({ ['goalForm.' + e.currentTarget.dataset.field]: e.detail.value }) },

  async createGoal() {
    const { name, target_amount, deadline } = this.data.goalForm
    if (!name || !target_amount) return
    await api.createGoal({ name, target_amount: Number(target_amount), deadline })
    this.closeGoalModal(); this.loadData()
  },

  addProgress(e) {
    const goal = this.data.goals.find(g => g.id === e.currentTarget.dataset.id)
    if (!goal) return
    this.setData({ showProgressModal: true, progressGoalId: goal.id, progressGoalName: goal.name, progressAmount: '' })
  },
  closeProgressModal() { this.setData({ showProgressModal: false }) },
  onProgressAmount(e) { this.setData({ progressAmount: e.detail.value }) },

  async saveProgress() {
    const { progressGoalId, progressAmount } = this.data
    const goal = this.data.goals.find(g => g.id === progressGoalId)
    if (!goal || !progressAmount) return
    await api.updateGoal(progressGoalId, { current_amount: Number(goal.current_amount) + Number(progressAmount) })
    this.setData({ showProgressModal: false }); this.loadData()
  },

  async completeGoal(e) { await api.updateGoal(e.currentTarget.dataset.id, { completed: 1 }); this.loadData() },
  async deleteGoal(e) { await api.deleteGoal(e.currentTarget.dataset.id); this.loadData() },

  showBudgetForm() { this.setData({ showBudgetModal: true, budgetForm: { categoryIndex: 0, amount: '' } }) },
  closeBudgetModal() { this.setData({ showBudgetModal: false }) },
  onBudgetCategory(e) { this.setData({ 'budgetForm.categoryIndex': e.detail.value }) },
  onBudgetField(e) { this.setData({ ['budgetForm.' + e.currentTarget.dataset.field]: e.detail.value }) },

  async saveBudget() {
    const { categoryIndex, amount } = this.data.budgetForm
    if (!amount) return
    await api.setBudget({ category: categoryIndex > 0 ? this.data.budgetCategories[categoryIndex] : null, amount: Number(amount) })
    this.setData({ showBudgetModal: false }); this.loadData()
  }
})
