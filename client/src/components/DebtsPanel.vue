<template>
  <div class="report-panel">
    <!-- 错误提示 -->
    <div v-if="error" class="error-banner" style="margin-bottom: 16px;">
      {{ error }}
      <button class="btn btn-sm btn-outline" @click="loadData()" style="margin-left: 12px;">重试</button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="empty-state">
      <p>加载中...</p>
    </div>

    <template v-if="!loading">
      <!-- 总览 -->
      <div class="report-card overview-card">
        <div class="overview-header">
          <div>
            <div class="overview-label">负债总额</div>
            <div class="overview-value num">{{ fmtMoney(overview.total_debt) }}</div>
            <div class="overview-sub num">月供合计 {{ fmtMoney(overview.total_monthly_payment) }} · {{ overview.debt_count }} 笔</div>
          </div>
          <button class="btn btn-primary" @click="openAddModal">+ 添加负债</button>
        </div>
      </div>

      <!-- 还款优先级 -->
      <div class="report-card" style="margin-top: 20px;">
        <h3>还款优先级建议（高息优先）</h3>
        <template v-if="overview.repayment_plan && overview.repayment_plan.length">
          <div v-for="(p, i) in overview.repayment_plan" :key="p.id" class="plan-row">
            <div class="plan-rank" :class="'rank-' + Math.min(i + 1, 3)">{{ i + 1 }}</div>
            <div class="plan-info">
              <div class="plan-name">{{ p.name }} <span class="plan-type">{{ TYPE_MAP[p.type] || p.type }}</span></div>
              <div class="plan-sub">
                利率 {{ fmtRate(p.interest_rate) }} · 月供 {{ fmtMoney(p.monthly_payment) }} · 月息 {{ fmtMoney(p.monthly_interest) }}
              </div>
              <div class="plan-advice">{{ p.repayment_advice }}</div>
            </div>
            <div class="plan-figures">
              <div class="plan-value num">{{ fmtMoney(p.amount) }}</div>
              <div v-if="p.payoff_months !== null && p.payoff_months !== undefined" class="plan-months">
                ≈ {{ p.payoff_months }} 个月还清
              </div>
            </div>
          </div>
        </template>
        <div v-else class="empty-state" style="padding: 40px 20px;">
          <p>暂无带月供的负债</p>
          <p style="font-size: 12px;">设置月供后，系统将自动估算还清时间并排序</p>
        </div>
      </div>

      <!-- 负债列表 -->
      <div class="report-card" style="margin-top: 20px;">
        <h3>全部负债</h3>
        <template v-if="items.length">
          <div v-for="it in items" :key="it.id" class="debt-row">
            <div class="debt-info">
              <div class="debt-name">{{ it.name }} <span class="debt-type">{{ TYPE_MAP[it.type] || it.type }}</span></div>
              <div class="debt-sub">
                <span v-if="it.interest_rate !== null && it.interest_rate !== undefined">年化 {{ fmtRate(it.interest_rate) }}</span>
                <span v-if="it.monthly_payment !== null && it.monthly_payment !== undefined"> · 月供 {{ fmtMoney(it.monthly_payment) }}</span>
                <span v-if="it.due_date"> · 到期 {{ it.due_date }}</span>
              </div>
            </div>
            <div class="debt-figures">
              <div class="debt-amount num">{{ fmtMoney(it.amount) }}</div>
              <div class="debt-actions">
                <button class="btn btn-sm btn-outline" @click="openEditModal(it)">编辑</button>
                <button class="btn btn-sm btn-outline" style="color: var(--danger);" @click="removeItem(it)">删除</button>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="empty-state" style="padding: 40px 20px;">
          <p>还没有负债记录</p>
          <p style="font-size: 12px;">点击「添加负债」记录房贷、车贷、信用卡等</p>
        </div>
      </div>
    </template>

    <!-- 添加/编辑弹层 -->
    <div class="modal-overlay" v-if="showModal" @click.self="closeModal">
      <div class="modal">
        <h2>{{ editing ? '编辑负债' : '添加负债' }}</h2>
        <div class="form-group">
          <label>名称</label>
          <input v-model.trim="form.name" placeholder="如：房贷 / 招行信用卡" />
        </div>
        <div class="form-group">
          <label>类型</label>
          <select v-model="form.type">
            <option value="mortgage">房贷</option>
            <option value="loan">贷款</option>
            <option value="credit_card">信用卡</option>
            <option value="other">其他</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>金额 (元)</label>
            <input v-model.number="form.amount" type="number" step="0.01" placeholder="0.00" />
          </div>
          <div class="form-group">
            <label>年化利率 (%)</label>
            <input v-model.number="form.interest_rate_pct" type="number" step="0.01" placeholder="如 4.5" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>每月还款 (元，可选)</label>
            <input v-model.number="form.monthly_payment" type="number" step="0.01" placeholder="0.00" />
          </div>
          <div class="form-group">
            <label>到期日（可选）</label>
            <input v-model="form.due_date" type="date" />
          </div>
        </div>
        <div v-if="saveError" class="modal-error">{{ saveError }}</div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="closeModal">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? '提交中...' : '确认保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'
import { api } from '../utils/api.js'

const store = useAppStore()
const router = useRouter()

const TYPE_MAP = { mortgage: '房贷', loan: '贷款', credit_card: '信用卡', other: '其他' }

const loading = ref(true)
const error = ref('')
const overview = ref({ total_debt: 0, total_monthly_payment: 0, debt_count: 0, repayment_plan: [] })
const items = ref([])

const showModal = ref(false)
const editing = ref(null)
const saving = ref(false)
const saveError = ref('')
const form = ref({ name: '', type: 'mortgage', amount: null, interest_rate_pct: null, monthly_payment: null, due_date: '' })

function fmtMoney(n) {
  const v = Number(n) || 0
  return '¥' + Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtRate(n) {
  if (n === null || n === undefined) return '—'
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return (v * 100).toFixed(2) + '%'
}

onMounted(async () => {
  if (!store.token) { router.push('/login'); return }
  await loadData()
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [resOv, resList] = await Promise.all([api.getDebtsOverview(), api.getDebts()])
    if (resOv && resOv.success === false && resOv.error === '登录已过期') {
      store.logout(); router.push('/login'); return
    }
    if (resOv && resOv.success) {
      overview.value = Object.assign(overview.value, resOv.data || {})
    } else {
      error.value = (resOv && resOv.error) || '债务数据加载失败，请稍后重试'
    }
    if (resList && resList.success) {
      items.value = resList.data || []
    }
  } catch (e) {
    error.value = '网络错误，请检查连接后重试'
  } finally {
    loading.value = false
  }
}

function openAddModal() {
  editing.value = null
  form.value = { name: '', type: 'mortgage', amount: null, interest_rate_pct: null, monthly_payment: null, due_date: '' }
  saveError.value = ''
  showModal.value = true
}

function openEditModal(it) {
  editing.value = it
  form.value = {
    name: it.name || '',
    type: it.type || 'mortgage',
    amount: it.amount !== null && it.amount !== undefined ? Number(it.amount) : null,
    interest_rate_pct: it.interest_rate !== null && it.interest_rate !== undefined ? Number(it.interest_rate) * 100 : null,
    monthly_payment: it.monthly_payment !== null && it.monthly_payment !== undefined ? Number(it.monthly_payment) : null,
    due_date: it.due_date || ''
  }
  saveError.value = ''
  showModal.value = true
}

function closeModal() {
  showModal.value = false
}

async function save() {
  if (!form.value.name) { saveError.value = '请输入负债名称'; return }
  if (form.value.amount === '' || form.value.amount === null || !Number.isFinite(Number(form.value.amount)) || Number(form.value.amount) <= 0) {
    saveError.value = '请输入有效的金额'
    return
  }
  saving.value = true
  saveError.value = ''
  const payload = {
    name: form.value.name,
    type: form.value.type,
    amount: Number(form.value.amount),
    interest_rate: form.value.interest_rate_pct === '' || form.value.interest_rate_pct === null ? null : Number(form.value.interest_rate_pct) / 100,
    monthly_payment: form.value.monthly_payment === '' || form.value.monthly_payment === null ? null : Number(form.value.monthly_payment),
    due_date: form.value.due_date || undefined
  }
  try {
    const res = editing.value
      ? await api.updateDebt(editing.value.id, payload)
      : await api.createDebt(payload)
    if (res && res.success === false) {
      saveError.value = res.error || '保存失败，请重试'
      return
    }
    showModal.value = false
    await loadData()
  } catch (e) {
    saveError.value = '网络错误，保存失败'
  } finally {
    saving.value = false
  }
}

async function removeItem(it) {
  if (!window.confirm(`确定删除「${it.name}」吗？`)) return
  try {
    const res = await api.deleteDebt(it.id)
    if (res && res.success === false) {
      error.value = res.error || '删除失败'
      return
    }
    await loadData()
  } catch (e) {
    error.value = '网络错误，删除失败'
  }
}
</script>

<style scoped>
.overview-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.overview-label {
  font-size: 13px;
  color: var(--text-secondary);
}
.overview-value {
  font-size: 36px;
  font-weight: 300;
  color: var(--text-title);
  letter-spacing: -0.02em;
  margin-top: 6px;
}
.overview-sub {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 8px;
}
.plan-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--border);
}
.plan-row:last-child { border-bottom: none; }
.plan-rank {
  flex: 0 0 30px;
  height: 30px;
  line-height: 30px;
  text-align: center;
  border-radius: 50%;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: var(--text-secondary);
}
.plan-rank.rank-1 { background: var(--danger); }
.plan-rank.rank-2 { background: var(--warning); }
.plan-rank.rank-3 { background: #9b6829; opacity: 0.75; }
.plan-info { flex: 1; min-width: 0; }
.plan-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-title);
}
.plan-type {
  display: inline-block;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  margin-left: 6px;
}
.plan-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 3px;
}
.plan-advice {
  font-size: 12px;
  color: var(--warning);
  margin-top: 4px;
  line-height: 1.6;
}
.plan-figures { text-align: right; flex: 0 0 auto; }
.plan-value {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-title);
}
.plan-months {
  font-size: 12px;
  color: var(--primary);
  margin-top: 3px;
}
.debt-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.debt-row:last-child { border-bottom: none; }
.debt-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-title);
}
.debt-type {
  display: inline-block;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  margin-left: 6px;
}
.debt-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 3px;
}
.debt-figures { text-align: right; }
.debt-amount {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-title);
}
.debt-actions {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.form-row {
  display: flex;
  gap: 12px;
}
.form-row .form-group { flex: 1; }
</style>
