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
            <div class="overview-label">持仓总市值</div>
            <div class="overview-value num">{{ fmtMoney(overview.total_value) }}</div>
            <div class="overview-change num" :class="profitClass(overview.total_profit)">
              累计盈亏 {{ fmtSigned(overview.total_profit) }}
              <span v-if="overview.profit_rate !== null && overview.profit_rate !== undefined">
                （{{ fmtPct(overview.profit_rate) }}）
              </span>
            </div>
          </div>
          <button class="btn btn-primary" @click="openAddModal">+ 添加持仓</button>
        </div>
        <div class="overview-metrics">
          <div class="metric">
            <span>持仓成本</span>
            <b class="num">{{ fmtMoney(overview.total_cost) }}</b>
          </div>
          <div class="metric">
            <span>持仓数量</span>
            <b class="num">{{ overview.count }}</b>
          </div>
          <div class="metric">
            <span>已更新市值</span>
            <b class="num">{{ overview.priced_count }}</b>
          </div>
        </div>
      </div>

      <!-- 列表 -->
      <div class="report-card" style="margin-top: 20px;">
        <h3>投资组合</h3>
        <template v-if="items.length">
          <div v-for="it in items" :key="it.id" class="inv-row">
            <div class="inv-info">
              <div class="inv-name">{{ it.name }} <span class="inv-type">{{ TYPE_MAP[it.type] || it.type }}</span></div>
              <div class="inv-sub">
                {{ it.symbol || '—' }} · 数量 {{ it.quantity }} · 成本价 {{ fmtMoney(it.cost_price) }}
                <span v-if="it.current_price !== null && it.current_price !== undefined"> · 现价 {{ fmtMoney(it.current_price) }}</span>
              </div>
              <div v-if="it.notes" class="inv-note">{{ it.notes }}</div>
            </div>
            <div class="inv-figures">
              <div class="inv-value num">{{ fmtMoney(it.current_value) }}</div>
              <div v-if="it.profit !== null && it.profit !== undefined" class="inv-profit num" :class="profitClass(it.profit)">
                {{ fmtSigned(it.profit) }}（{{ fmtPct(it.profit_rate) }}）
              </div>
              <div class="inv-actions">
                <button class="btn btn-sm btn-outline" @click="openEditModal(it)">编辑</button>
                <button class="btn btn-sm btn-outline" style="color: var(--danger);" @click="removeItem(it)">删除</button>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="empty-state" style="padding: 40px 20px;">
          <p>还没有投资持仓</p>
          <p style="font-size: 12px;">点击「添加持仓」记录你的投资组合</p>
        </div>
      </div>
    </template>

    <!-- 添加/编辑弹层 -->
    <div class="modal-overlay" v-if="showModal" @click.self="closeModal">
      <div class="modal">
        <h2>{{ editing ? '编辑持仓' : '添加持仓' }}</h2>
        <div class="form-group">
          <label>名称</label>
          <input v-model.trim="form.name" placeholder="如：沪深300ETF" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>类型</label>
            <select v-model="form.type">
              <option value="fund">基金</option>
              <option value="stock">股票</option>
              <option value="bond">债券</option>
              <option value="gold">黄金</option>
              <option value="crypto">加密货币</option>
              <option value="other">其他</option>
            </select>
          </div>
          <div class="form-group">
            <label>代码/符号（可选）</label>
            <input v-model.trim="form.symbol" placeholder="如：510300" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>数量</label>
            <input v-model.number="form.quantity" type="number" step="0.0001" placeholder="0" />
          </div>
          <div class="form-group">
            <label>成本价 (元)</label>
            <input v-model.number="form.cost_price" type="number" step="0.0001" placeholder="0.00" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>当前价 (元，可选)</label>
            <input v-model.number="form.current_price" type="number" step="0.0001" placeholder="0.00" />
          </div>
          <div class="form-group">
            <label>买入日期（可选）</label>
            <input v-model="form.acquired_date" type="date" />
          </div>
        </div>
        <div class="form-group">
          <label>备注（可选）</label>
          <input v-model.trim="form.notes" placeholder="备注信息" />
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

const TYPE_MAP = { fund: '基金', stock: '股票', bond: '债券', gold: '黄金', crypto: '加密货币', other: '其他' }

const loading = ref(true)
const error = ref('')
const overview = ref({ total_cost: 0, total_value: 0, total_profit: 0, profit_rate: null, count: 0, priced_count: 0 })
const items = ref([])

const showModal = ref(false)
const editing = ref(null)
const saving = ref(false)
const saveError = ref('')
const form = ref({ name: '', symbol: '', type: 'fund', quantity: null, cost_price: null, current_price: null, acquired_date: '', notes: '' })

function fmtMoney(n) {
  const v = Number(n) || 0
  return '¥' + Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtSigned(n) {
  const v = Number(n) || 0
  return (v >= 0 ? '+' : '-') + '¥' + Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtPct(n) {
  const v = Number(n) || 0
  return (v * 100).toFixed(2) + '%'
}
// 中国习惯：盈利红、亏损绿
function profitClass(n) {
  const v = Number(n) || 0
  return v >= 0 ? 'profit-up' : 'profit-down'
}

onMounted(async () => {
  if (!store.token) { router.push('/login'); return }
  await loadData()
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [resOv, resList] = await Promise.all([api.getInvestmentsOverview(), api.getInvestments()])
    if (resOv && resOv.success === false && resOv.error === '登录已过期') {
      store.logout(); router.push('/login'); return
    }
    if (resOv && resOv.success) {
      overview.value = Object.assign(overview.value, resOv.data || {})
    } else {
      error.value = (resOv && resOv.error) || '投资数据加载失败，请稍后重试'
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
  form.value = { name: '', symbol: '', type: 'fund', quantity: null, cost_price: null, current_price: null, acquired_date: '', notes: '' }
  saveError.value = ''
  showModal.value = true
}

function openEditModal(it) {
  editing.value = it
  form.value = {
    name: it.name || '',
    symbol: it.symbol || '',
    type: it.type || 'fund',
    quantity: it.quantity !== null && it.quantity !== undefined ? Number(it.quantity) : null,
    cost_price: it.cost_price !== null && it.cost_price !== undefined ? Number(it.cost_price) : null,
    current_price: it.current_price !== null && it.current_price !== undefined ? Number(it.current_price) : null,
    acquired_date: it.acquired_date || '',
    notes: it.notes || ''
  }
  saveError.value = ''
  showModal.value = true
}

function closeModal() {
  showModal.value = false
}

async function save() {
  if (!form.value.name) { saveError.value = '请输入持仓名称'; return }
  if (form.value.quantity === '' || form.value.quantity === null || !Number.isFinite(Number(form.value.quantity)) || Number(form.value.quantity) <= 0) {
    saveError.value = '请输入有效的数量'
    return
  }
  if (form.value.cost_price === '' || form.value.cost_price === null || !Number.isFinite(Number(form.value.cost_price))) {
    saveError.value = '请输入有效的成本价'
    return
  }
  saving.value = true
  saveError.value = ''
  const payload = {
    name: form.value.name,
    symbol: form.value.symbol || undefined,
    type: form.value.type,
    quantity: Number(form.value.quantity),
    cost_price: Number(form.value.cost_price),
    current_price: form.value.current_price === '' || form.value.current_price === null ? null : Number(form.value.current_price),
    acquired_date: form.value.acquired_date || undefined,
    notes: form.value.notes || undefined
  }
  try {
    const res = editing.value
      ? await api.updateInvestment(editing.value.id, payload)
      : await api.createInvestment(payload)
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
    const res = await api.deleteInvestment(it.id)
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
.overview-change {
  font-size: 13px;
  margin-top: 8px;
}
.profit-up { color: var(--danger); }
.profit-down { color: var(--success); }
.overview-metrics {
  display: flex;
  gap: 32px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.metric span {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}
.metric b {
  font-size: 16px;
  color: var(--text-title);
}
.inv-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.inv-row:last-child { border-bottom: none; }
.inv-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-title);
}
.inv-type {
  display: inline-block;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  margin-left: 6px;
  vertical-align: 1px;
}
.inv-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 3px;
}
.inv-note {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}
.inv-figures { text-align: right; }
.inv-value {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-title);
}
.inv-profit { font-size: 13px; margin-top: 2px; }
.inv-actions {
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
