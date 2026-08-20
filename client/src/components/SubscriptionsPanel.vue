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
            <div class="overview-label">活跃订阅</div>
            <div class="overview-value num">{{ overview.count }} 项</div>
            <div class="overview-sub num">月均 {{ fmtMoney(overview.monthly_equivalent) }} · 年均 {{ fmtMoney(overview.yearly_equivalent) }}</div>
          </div>
          <button class="btn btn-primary" @click="openAddModal">+ 添加订阅</button>
        </div>
      </div>

      <!-- 近期扣费 -->
      <div class="report-card" style="margin-top: 20px;">
        <h3>30 天内待扣费</h3>
        <template v-if="overview.due_soon && overview.due_soon.length">
          <div v-for="s in overview.due_soon" :key="s.id" class="due-row">
            <div class="due-date num">{{ fmtDate(s.next_billing_date) }}</div>
            <div class="due-info">
              <div class="due-name">{{ s.name }}</div>
              <div class="due-sub">{{ CYCLE_MAP[s.billing_cycle] || s.billing_cycle }} · {{ s.category || '未分类' }}</div>
            </div>
            <div class="due-amount num">{{ fmtMoney(s.amount) }}</div>
          </div>
        </template>
        <div v-else class="empty-state" style="padding: 30px 20px;">
          <p>未来 30 天没有待扣费的订阅 🎉</p>
        </div>
      </div>

      <!-- 订阅列表 -->
      <div class="report-card" style="margin-top: 20px;">
        <div class="list-header">
          <h3>全部订阅</h3>
          <div class="filter-tabs">
            <button v-for="f in FILTERS" :key="f.value" class="filter-tab" :class="{ active: statusFilter === f.value }" @click="statusFilter = f.value">
              {{ f.label }}
            </button>
          </div>
        </div>
        <template v-if="filtered.length">
          <div v-for="s in filtered" :key="s.id" class="sub-row">
            <div class="sub-status" :class="'status-' + s.status"></div>
            <div class="sub-info">
              <div class="sub-name">{{ s.name }} <span class="sub-cat">{{ s.category || '未分类' }}</span></div>
              <div class="sub-sub">
                {{ CYCLE_MAP[s.billing_cycle] || s.billing_cycle }} · 下次扣费 {{ fmtDate(s.next_billing_date) }}
                <span v-if="s.notes"> · {{ s.notes }}</span>
              </div>
            </div>
            <div class="sub-figures">
              <div class="sub-amount num">{{ fmtMoney(s.amount) }}</div>
              <div class="sub-actions">
                <button class="btn btn-sm btn-outline" @click="toggleStatus(s)">
                  {{ s.status === 'active' ? '暂停' : (s.status === 'paused' ? '恢复' : '—') }}
                </button>
                <button class="btn btn-sm btn-outline" @click="openEditModal(s)">编辑</button>
                <button class="btn btn-sm btn-outline" style="color: var(--danger);" @click="removeItem(s)">删除</button>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="empty-state" style="padding: 40px 20px;">
          <p>暂无订阅</p>
          <p style="font-size: 12px;">点击「添加订阅」管理视频、音乐、云存储等会员</p>
        </div>
      </div>
    </template>

    <!-- 添加/编辑弹层 -->
    <div class="modal-overlay" v-if="showModal" @click.self="closeModal">
      <div class="modal">
        <h2>{{ editing ? '编辑订阅' : '添加订阅' }}</h2>
        <div class="form-row">
          <div class="form-group">
            <label>名称</label>
            <input v-model.trim="form.name" placeholder="如：Netflix / iCloud" />
          </div>
          <div class="form-group">
            <label>分类（可选）</label>
            <input v-model.trim="form.category" placeholder="如：视频 / 音乐 / 云存储" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>金额 (元)</label>
            <input v-model.number="form.amount" type="number" step="0.01" placeholder="0.00" />
          </div>
          <div class="form-group">
            <label>计费周期</label>
            <select v-model="form.billing_cycle">
              <option value="monthly">按月</option>
              <option value="quarterly">按季</option>
              <option value="yearly">按年</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>下次扣费日期</label>
            <input v-model="form.next_billing_date" type="date" required />
          </div>
          <div class="form-group">
            <label>状态</label>
            <select v-model="form.status">
              <option value="active">生效中</option>
              <option value="paused">已暂停</option>
              <option value="cancelled">已取消</option>
            </select>
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
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'
import { api } from '../utils/api.js'

const store = useAppStore()
const router = useRouter()

const CYCLE_MAP = { monthly: '按月', quarterly: '按季', yearly: '按年' }
const STATUS_MAP = { active: '生效中', paused: '已暂停', cancelled: '已取消' }
const FILTERS = [
  { value: '', label: '全部' },
  { value: 'active', label: '生效中' },
  { value: 'paused', label: '已暂停' },
  { value: 'cancelled', label: '已取消' }
]

const loading = ref(true)
const error = ref('')
const overview = ref({ count: 0, monthly_equivalent: 0, yearly_equivalent: 0, due_soon: [] })
const items = ref([])
const statusFilter = ref('')

const showModal = ref(false)
const editing = ref(null)
const saving = ref(false)
const saveError = ref('')
const form = ref({ name: '', category: '', amount: null, billing_cycle: 'monthly', next_billing_date: '', status: 'active', notes: '' })

const filtered = computed(() => {
  if (!statusFilter.value) return items.value
  return items.value.filter(s => s.status === statusFilter.value)
})

function fmtMoney(n) {
  const v = Number(n) || 0
  return '¥' + v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtDate(d) {
  if (!d) return '—'
  const parts = String(d).slice(0, 10).split('-')
  return parts.length === 3 ? `${parts[1]}月${parts[2]}日` : String(d).slice(0, 10)
}

onMounted(async () => {
  if (!store.token) { router.push('/login'); return }
  await loadData()
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [resOv, resList] = await Promise.all([api.getSubscriptionsOverview(), api.getSubscriptions()])
    if (resOv && resOv.success === false && resOv.error === '登录已过期') {
      store.logout(); router.push('/login'); return
    }
    if (resOv && resOv.success) {
      overview.value = Object.assign(overview.value, resOv.data || {})
    } else {
      error.value = (resOv && resOv.error) || '订阅数据加载失败，请稍后重试'
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
  form.value = { name: '', category: '', amount: null, billing_cycle: 'monthly', next_billing_date: '', status: 'active', notes: '' }
  saveError.value = ''
  showModal.value = true
}

function openEditModal(s) {
  editing.value = s
  form.value = {
    name: s.name || '',
    category: s.category || '',
    amount: s.amount !== null && s.amount !== undefined ? Number(s.amount) : null,
    billing_cycle: s.billing_cycle || 'monthly',
    next_billing_date: s.next_billing_date || '',
    status: s.status || 'active',
    notes: s.notes || ''
  }
  saveError.value = ''
  showModal.value = true
}

function closeModal() {
  showModal.value = false
}

async function save() {
  if (!form.value.name) { saveError.value = '请输入订阅名称'; return }
  if (form.value.amount === '' || form.value.amount === null || !Number.isFinite(Number(form.value.amount)) || Number(form.value.amount) <= 0) {
    saveError.value = '请输入有效的金额'
    return
  }
  if (!form.value.next_billing_date) {
    saveError.value = '请选择下次扣费日期'
    return
  }
  saving.value = true
  saveError.value = ''
  const payload = {
    name: form.value.name,
    category: form.value.category || undefined,
    amount: Number(form.value.amount),
    billing_cycle: form.value.billing_cycle,
    next_billing_date: form.value.next_billing_date,
    status: form.value.status,
    notes: form.value.notes || undefined
  }
  try {
    const res = editing.value
      ? await api.updateSubscription(editing.value.id, payload)
      : await api.createSubscription(payload)
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

async function toggleStatus(s) {
  const next = s.status === 'active' ? 'paused' : 'active'
  try {
    const res = await api.updateSubscription(s.id, { status: next })
    if (res && res.success === false) {
      error.value = res.error || '操作失败'
      return
    }
    await loadData()
  } catch (e) {
    error.value = '网络错误，操作失败'
  }
}

async function removeItem(s) {
  if (!window.confirm(`确定删除「${s.name}」吗？`)) return
  try {
    const res = await api.deleteSubscription(s.id)
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
.due-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 4px;
  border-bottom: 1px solid var(--border);
}
.due-row:last-child { border-bottom: none; }
.due-date {
  flex: 0 0 64px;
  font-size: 13px;
  font-weight: 600;
  color: var(--primary);
  background: var(--primary-soft);
  border-radius: var(--radius-sm);
  text-align: center;
  padding: 8px 4px;
}
.due-info { flex: 1; min-width: 0; }
.due-name { font-size: 14px; font-weight: 600; color: var(--text-title); }
.due-sub { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.due-amount { font-size: 14px; font-weight: 600; color: var(--text-title); }
.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.filter-tabs { display: flex; gap: 6px; }
.filter-tab {
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 12px;
  border-radius: 999px;
  padding: 4px 12px;
  cursor: pointer;
}
.filter-tab.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.sub-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.sub-row:last-child { border-bottom: none; }
.sub-status {
  flex: 0 0 8px;
  height: 8px;
  border-radius: 50%;
}
.status-active { background: var(--success); }
.status-paused { background: var(--warning); }
.status-cancelled { background: var(--text-secondary); }
.sub-info { flex: 1; min-width: 0; }
.sub-name { font-size: 14px; font-weight: 600; color: var(--text-title); }
.sub-cat {
  display: inline-block;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  margin-left: 6px;
}
.sub-sub { font-size: 12px; color: var(--text-secondary); margin-top: 3px; }
.sub-figures { text-align: right; }
.sub-amount { font-size: 15px; font-weight: 600; color: var(--text-title); }
.sub-actions {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }
</style>
