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
            <div class="overview-label">生效中保单</div>
            <div class="overview-value num">{{ overview.count }} 份</div>
            <div class="overview-sub num">总保额 {{ fmtMoney(overview.total_insured) }} · 年缴 {{ fmtMoney(overview.total_annual_premium) }}</div>
          </div>
          <button class="btn btn-primary" @click="openAddModal">+ 添加保单</button>
        </div>
      </div>

      <!-- 即将到期 -->
      <div class="report-card" style="margin-top: 20px;">
        <h3>60 天内到期提醒</h3>
        <template v-if="overview.expiring_soon && overview.expiring_soon.length">
          <div v-for="p in overview.expiring_soon" :key="p.id" class="exp-row">
            <div class="exp-date num">{{ p.end_date }}</div>
            <div class="exp-info">
              <div class="exp-name">{{ p.name }}</div>
              <div class="exp-sub">{{ p.type }} · {{ p.company || '—' }}</div>
            </div>
            <div class="exp-amount num">{{ fmtMoney(p.annual_premium) }}/年</div>
          </div>
        </template>
        <div v-else class="empty-state" style="padding: 30px 20px;">
          <p>未来 60 天没有保单到期 👍</p>
        </div>
      </div>

      <!-- 保单列表 -->
      <div class="report-card" style="margin-top: 20px;">
        <h3>全部保单</h3>
        <template v-if="items.length">
          <div v-for="p in items" :key="p.id" class="pol-row">
            <div class="pol-info">
              <div class="pol-name">
                {{ p.name }}
                <span class="pol-type">{{ p.type }}</span>
                <span class="pol-status" :class="'st-' + p.status">{{ STATUS_MAP[p.status] || p.status }}</span>
              </div>
              <div class="pol-sub">
                {{ p.company || '—' }}<template v-if="p.policy_number"> · {{ p.policy_number }}</template>
                <template v-if="p.holder"> · 被保人 {{ p.holder }}</template>
              </div>
              <div class="pol-sub">
                保额 {{ fmtMoney(p.insured_amount) }} · {{ FREQ_MAP[p.payment_frequency] || p.payment_frequency }} {{ fmtMoney(p.annual_premium) }}
                <template v-if="p.start_date || p.end_date"> · {{ p.start_date || '?' }} ~ {{ p.end_date || '长期' }}</template>
              </div>
              <div v-if="p.notes" class="pol-note">{{ p.notes }}</div>
            </div>
            <div class="pol-figures">
              <div class="pol-amount num">{{ fmtMoney(p.annual_premium) }}/年</div>
              <div class="pol-actions">
                <button class="btn btn-sm btn-outline" @click="openEditModal(p)">编辑</button>
                <button class="btn btn-sm btn-outline" style="color: var(--danger);" @click="removeItem(p)">删除</button>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="empty-state" style="padding: 40px 20px;">
          <p>还没有保单记录</p>
          <p style="font-size: 12px;">点击「添加保单」管理你的保障配置</p>
        </div>
      </div>
    </template>

    <!-- 添加/编辑弹层 -->
    <div class="modal-overlay" v-if="showModal" @click.self="closeModal">
      <div class="modal">
        <h2>{{ editing ? '编辑保单' : '添加保单' }}</h2>
        <div class="form-group">
          <label>保单名称</label>
          <input v-model.trim="form.name" placeholder="如：平安e生保" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>类型</label>
            <select v-model="form.type">
              <option value="人寿">人寿</option>
              <option value="医疗">医疗</option>
              <option value="重疾">重疾</option>
              <option value="意外">意外</option>
              <option value="财产">财产</option>
              <option value="其他">其他</option>
            </select>
          </div>
          <div class="form-group">
            <label>承保公司</label>
            <input v-model.trim="form.company" placeholder="如：中国平安" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>保单号</label>
            <input v-model.trim="form.policy_number" placeholder="保单号" />
          </div>
          <div class="form-group">
            <label>被保人</label>
            <input v-model.trim="form.holder" placeholder="被保人姓名" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>保额 (元)</label>
            <input v-model.number="form.insured_amount" type="number" step="0.01" placeholder="0.00" />
          </div>
          <div class="form-group">
            <label>年缴保费 (元)</label>
            <input v-model.number="form.annual_premium" type="number" step="0.01" placeholder="0.00" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>缴费频率</label>
            <select v-model="form.payment_frequency">
              <option value="yearly">按年</option>
              <option value="quarterly">按季</option>
              <option value="monthly">按月</option>
              <option value="one_time">一次性</option>
            </select>
          </div>
          <div class="form-group">
            <label>状态</label>
            <select v-model="form.status">
              <option value="active">生效中</option>
              <option value="expired">已过期</option>
              <option value="cancelled">已退保</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>生效日期（可选）</label>
            <input v-model="form.start_date" type="date" />
          </div>
          <div class="form-group">
            <label>到期日期（可选）</label>
            <input v-model="form.end_date" type="date" />
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

const FREQ_MAP = { yearly: '年缴', quarterly: '季缴', monthly: '月缴', one_time: '一次性' }
const STATUS_MAP = { active: '生效中', expired: '已过期', cancelled: '已退保' }

const loading = ref(true)
const error = ref('')
const overview = ref({ count: 0, total_insured: 0, total_annual_premium: 0, expiring_soon: [] })
const items = ref([])

const showModal = ref(false)
const editing = ref(null)
const saving = ref(false)
const saveError = ref('')
const form = ref({
  name: '', type: '医疗', company: '', policy_number: '', holder: '',
  insured_amount: null, annual_premium: null, payment_frequency: 'yearly',
  start_date: '', end_date: '', status: 'active', notes: ''
})

function fmtMoney(n) {
  const v = Number(n) || 0
  return '¥' + v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

onMounted(async () => {
  if (!store.token) { router.push('/login'); return }
  await loadData()
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [resOv, resList] = await Promise.all([api.getInsuranceOverview(), api.getInsurancePolicies()])
    if (resOv && resOv.success === false && resOv.error === '登录已过期') {
      store.logout(); router.push('/login'); return
    }
    if (resOv && resOv.success) {
      overview.value = Object.assign(overview.value, resOv.data || {})
    } else {
      error.value = (resOv && resOv.error) || '保单数据加载失败，请稍后重试'
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
  form.value = {
    name: '', type: '医疗', company: '', policy_number: '', holder: '',
    insured_amount: null, annual_premium: null, payment_frequency: 'yearly',
    start_date: '', end_date: '', status: 'active', notes: ''
  }
  saveError.value = ''
  showModal.value = true
}

function openEditModal(p) {
  editing.value = p
  form.value = {
    name: p.name || '',
    type: p.type || '医疗',
    company: p.company || '',
    policy_number: p.policy_number || '',
    holder: p.holder || '',
    insured_amount: p.insured_amount !== null && p.insured_amount !== undefined ? Number(p.insured_amount) : null,
    annual_premium: p.annual_premium !== null && p.annual_premium !== undefined ? Number(p.annual_premium) : null,
    payment_frequency: p.payment_frequency || 'yearly',
    start_date: p.start_date || '',
    end_date: p.end_date || '',
    status: p.status || 'active',
    notes: p.notes || ''
  }
  saveError.value = ''
  showModal.value = true
}

function closeModal() {
  showModal.value = false
}

async function save() {
  if (!form.value.name) { saveError.value = '请输入保单名称'; return }
  if (form.value.insured_amount === '' || form.value.insured_amount === null || !Number.isFinite(Number(form.value.insured_amount))) {
    saveError.value = '请输入有效的保额'
    return
  }
  if (form.value.annual_premium === '' || form.value.annual_premium === null || !Number.isFinite(Number(form.value.annual_premium))) {
    saveError.value = '请输入有效的年缴保费'
    return
  }
  saving.value = true
  saveError.value = ''
  const payload = {
    name: form.value.name,
    type: form.value.type,
    company: form.value.company || undefined,
    policy_number: form.value.policy_number || undefined,
    holder: form.value.holder || undefined,
    insured_amount: Number(form.value.insured_amount),
    annual_premium: Number(form.value.annual_premium),
    payment_frequency: form.value.payment_frequency,
    start_date: form.value.start_date || undefined,
    end_date: form.value.end_date || undefined,
    status: form.value.status,
    notes: form.value.notes || undefined
  }
  try {
    const res = editing.value
      ? await api.updateInsurancePolicy(editing.value.id, payload)
      : await api.createInsurancePolicy(payload)
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

async function removeItem(p) {
  if (!window.confirm(`确定删除「${p.name}」吗？`)) return
  try {
    const res = await api.deleteInsurancePolicy(p.id)
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
.overview-label { font-size: 13px; color: var(--text-secondary); }
.overview-value {
  font-size: 36px;
  font-weight: 300;
  color: var(--text-title);
  letter-spacing: -0.02em;
  margin-top: 6px;
}
.overview-sub { font-size: 13px; color: var(--text-secondary); margin-top: 8px; }
.exp-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 4px;
  border-bottom: 1px solid var(--border);
}
.exp-row:last-child { border-bottom: none; }
.exp-date {
  flex: 0 0 92px;
  font-size: 12px;
  font-weight: 600;
  color: var(--danger);
  background: var(--danger-soft);
  border-radius: var(--radius-sm);
  text-align: center;
  padding: 8px 4px;
}
.exp-info { flex: 1; min-width: 0; }
.exp-name { font-size: 14px; font-weight: 600; color: var(--text-title); }
.exp-sub { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.exp-amount { font-size: 13px; font-weight: 600; color: var(--text-title); }
.pol-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.pol-row:last-child { border-bottom: none; }
.pol-name { font-size: 14px; font-weight: 600; color: var(--text-title); }
.pol-type {
  display: inline-block;
  font-size: 11px;
  color: var(--primary);
  background: var(--primary-soft);
  border-radius: 4px;
  padding: 1px 6px;
  margin-left: 6px;
}
.pol-status {
  display: inline-block;
  font-size: 11px;
  border-radius: 999px;
  padding: 1px 8px;
  margin-left: 6px;
}
.st-active { color: var(--success); background: var(--success-soft); }
.st-expired { color: var(--warning); background: var(--warning-soft); }
.st-cancelled { color: var(--text-secondary); background: var(--bg-track); }
.pol-sub { font-size: 12px; color: var(--text-secondary); margin-top: 3px; }
.pol-note { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.pol-figures { text-align: right; }
.pol-amount { font-size: 14px; font-weight: 600; color: var(--text-title); }
.pol-actions {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }
</style>
