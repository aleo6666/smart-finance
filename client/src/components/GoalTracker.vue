<template>
  <div class="goal-panel">
    <!-- 预算设置 -->
    <div class="report-card" style="margin-bottom: 20px;">
      <h3>💰 月度预算</h3>
      <div v-if="budgets.length > 0">
        <div v-for="b in budgets" :key="b.id" style="margin-bottom: 14px;">
          <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px;">
            <span>{{ b.category || '总预算' }}</span>
            <span>¥{{ b.spent?.toFixed(0) || 0 }} / ¥{{ b.amount }}</span>
          </div>
          <div class="progress-bar">
            <div
              class="progress-fill"
              :class="(b.percent || 0) > 80 ? 'danger' : (b.percent || 0) > 60 ? 'warn' : 'good'"
              :style="{ width: Math.min(b.percent || 0, 100) + '%' }"
            ></div>
          </div>
        </div>
      </div>
      <button class="btn btn-outline btn-sm" @click="showBudgetModal = true" style="margin-top: 10px;">
        + 设置预算
      </button>
    </div>

    <!-- 储蓄目标 -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h2 style="font-size: 16px;">🎯 储蓄目标</h2>
      <button class="btn btn-primary btn-sm" @click="showGoalModal = true">+ 新建目标</button>
    </div>

    <div v-if="goals.length > 0">
      <div class="goal-card" v-for="g in goals" :key="g.id">
        <div class="goal-header">
          <span class="goal-name">{{ g.name }}</span>
          <span class="goal-amount">
            ¥{{ g.current_amount.toFixed(0) }} / ¥{{ g.target_amount.toFixed(0) }}
          </span>
        </div>
        <div class="progress-bar">
          <div
            class="progress-fill"
            :class="getProgressClass(g)"
            :style="{ width: getPercent(g) + '%' }"
          ></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-secondary);">
          <span>进度 {{ getPercent(g) }}%</span>
          <span v-if="g.deadline">截止: {{ g.deadline }}</span>
        </div>
        <div class="goal-actions">
          <button class="btn btn-outline btn-sm" @click="addProgress(g)">+ 存入</button>
          <button class="btn btn-outline btn-sm" @click="completeGoal(g)" v-if="!g.completed">
            {{ getPercent(g) >= 100 ? '✓ 完成' : '标记完成' }}
          </button>
          <button class="btn btn-outline btn-sm" @click="deleteGoal(g.id)" style="color: var(--danger);">删除</button>
        </div>
      </div>
    </div>

    <div v-else class="empty-state">
      <div class="empty-icon">🎯</div>
      <p>还没有储蓄目标</p>
      <p style="font-size: 12px;">设定一个目标，开始你的储蓄计划吧！</p>
    </div>

    <!-- 新建目标弹窗 -->
    <div class="modal-overlay" v-if="showGoalModal" @click.self="showGoalModal = false">
      <div class="modal">
        <h2>新建储蓄目标</h2>
        <div class="form-group">
          <label>目标名称</label>
          <input v-model="goalForm.name" placeholder="如：买新手机" />
        </div>
        <div class="form-group">
          <label>目标金额 (元)</label>
          <input v-model.number="goalForm.target_amount" type="number" placeholder="5000" />
        </div>
        <div class="form-group">
          <label>截止日期</label>
          <input v-model="goalForm.deadline" type="date" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showGoalModal = false">取消</button>
          <button class="btn btn-primary" @click="createGoal">确认创建</button>
        </div>
      </div>
    </div>

    <!-- 存入进度弹窗 -->
    <div class="modal-overlay" v-if="showProgressModal" @click.self="showProgressModal = false">
      <div class="modal">
        <h2>存入金额 - {{ progressGoal?.name }}</h2>
        <div class="form-group">
          <label>金额 (元)</label>
          <input v-model.number="progressAmount" type="number" placeholder="500" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showProgressModal = false">取消</button>
          <button class="btn btn-primary" @click="saveProgress">确认存入</button>
        </div>
      </div>
    </div>

    <!-- 设置预算弹窗 -->
    <div class="modal-overlay" v-if="showBudgetModal" @click.self="showBudgetModal = false">
      <div class="modal">
        <h2>设置预算</h2>
        <div class="form-group">
          <label>类别（留空为总预算）</label>
          <select v-model="budgetForm.category">
            <option value="">总预算</option>
            <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>预算金额 (元/月)</label>
          <input v-model.number="budgetForm.amount" type="number" placeholder="2000" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showBudgetModal = false">取消</button>
          <button class="btn btn-primary" @click="saveBudget">确认设置</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../utils/api.js'

const categories = ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他']
const goals = ref([])
const budgets = ref([])
const showGoalModal = ref(false)
const showProgressModal = ref(false)
const showBudgetModal = ref(false)
const progressGoal = ref(null)
const progressAmount = ref(500)

const goalForm = ref({ name: '', target_amount: 0, deadline: '' })
const budgetForm = ref({ category: '', amount: 0 })

onMounted(loadData)

async function loadData() {
  const [gRes, bRes] = await Promise.all([
    api.getGoals(),
    api.getBudgets()
  ])
  goals.value = gRes.data || []

  // 计算预算使用情况
  budgets.value = (bRes.data || []).map(b => {
    const spent = b.spent || 0
    return { ...b, spent, percent: b.amount > 0 ? Math.round(spent / b.amount * 100) : 0 }
  })
}

function getPercent(g) {
  return g.target_amount > 0 ? Math.round(g.current_amount / g.target_amount * 100) : 0
}

function getProgressClass(g) {
  const p = getPercent(g)
  return p >= 100 ? 'good' : p >= 50 ? 'warn' : 'good'
}

async function createGoal() {
  if (!goalForm.value.name || !goalForm.value.target_amount) return
  await api.createGoal(goalForm.value)
  goalForm.value = { name: '', target_amount: 0, deadline: '' }
  showGoalModal.value = false
  await loadData()
}

function addProgress(g) {
  progressGoal.value = g
  progressAmount.value = 500
  showProgressModal.value = true
}

async function saveProgress() {
  if (!progressAmount.value || !progressGoal.value) return
  const newAmount = progressGoal.value.current_amount + progressAmount.value
  await api.updateGoal(progressGoal.value.id, { current_amount: newAmount })
  showProgressModal.value = false
  await loadData()
}

async function completeGoal(g) {
  await api.updateGoal(g.id, { completed: 1 })
  await loadData()
}

async function deleteGoal(id) {
  await api.deleteGoal(id)
  await loadData()
}

async function saveBudget() {
  if (!budgetForm.value.amount) return
  await api.setBudget({
    category: budgetForm.value.category || null,
    amount: budgetForm.value.amount
  })
  budgetForm.value = { category: '', amount: 0 }
  showBudgetModal.value = false
  await loadData()
}
</script>
