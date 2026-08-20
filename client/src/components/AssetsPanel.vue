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
      <!-- 净资产总览 -->
      <div class="report-card networth-card">
        <div class="networth-header">
          <div>
            <div class="networth-label">净资产</div>
            <div class="networth-value num">
              {{ overview ? fmtMoney(overview.netWorth) : '--' }}
            </div>
            <div
              v-if="overview && overview.changePercent !== null"
              class="networth-change num"
              :class="overview.changePercent >= 0 ? 'up' : 'down'"
            >
              环比 {{ overview.changePercent >= 0 ? '+' : '' }}{{ overview.changePercent.toFixed(1) }}%
            </div>
          </div>
          <button class="btn btn-primary" @click="openAddModal">+ 添加账户</button>
        </div>
      </div>

      <div class="report-grid" style="margin-top: 20px;">
        <!-- 账户列表（按类型分组） -->
        <div class="report-card">
          <h3>账户列表</h3>
          <template v-if="groups.length">
            <div v-for="g in groups" :key="g.type" class="account-group">
              <div class="account-group-header">
                <span>{{ g.type }}</span>
                <span class="num">{{ fmtMoney(g.total) }}</span>
              </div>
              <div v-for="a in g.accounts" :key="a.id ?? a.name" class="account-row">
                <div class="account-info">
                  <div class="account-name">{{ a.name }}</div>
                  <div v-if="a.note" class="account-note">{{ a.note }}</div>
                </div>
                <div class="account-figures">
                  <div class="account-balance num" :class="a.balance >= 0 ? 'positive' : 'negative'">
                    {{ fmtMoney(a.balance) }}
                  </div>
                  <div class="account-share num">占比 {{ a.share.toFixed(1) }}%</div>
                </div>
              </div>
            </div>
          </template>
          <div v-else class="empty-state" style="padding: 40px 20px;">
            <p>还没有账户</p>
            <p style="font-size: 12px;">点击「添加账户」开始记录你的资产</p>
          </div>
        </div>

        <!-- 近 30 天净资产趋势 -->
        <div class="report-card">
          <h3>近 30 天净资产趋势</h3>
          <div v-if="trend.length" ref="trendRef" class="trend-chart"></div>
          <div v-else class="empty-state" style="padding: 40px 20px;">
            <p>暂无趋势数据</p>
            <p style="font-size: 12px;">添加账户后，趋势数据将在此展示</p>
          </div>
        </div>
      </div>
    </template>

    <!-- 添加账户弹层 -->
    <div class="modal-overlay" v-if="showAddModal" @click.self="showAddModal = false">
      <div class="modal">
        <h2>添加账户</h2>
        <div class="form-group">
          <label>账户名称</label>
          <input v-model.trim="form.name" placeholder="如：招商银行储蓄卡" />
        </div>
        <div class="form-group">
          <label>类型</label>
          <select v-model="form.type">
            <option value="cash">现金</option>
            <option value="bank_deposit">银行存款</option>
            <option value="investment">投资</option>
            <option value="property">房产</option>
            <option value="vehicle">车辆</option>
            <option value="other">其他</option>
          </select>
        </div>
        <div class="form-group">
          <label>金额 (元)</label>
          <input v-model.number="form.balance" type="number" placeholder="0.00" />
        </div>
        <div class="form-group">
          <label>备注（可选）</label>
          <input v-model.trim="form.note" placeholder="备注信息" />
        </div>
        <div v-if="saveError" class="modal-error">{{ saveError }}</div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showAddModal = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="createAccount">
            {{ saving ? '提交中...' : '确认添加' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import * as echarts from 'echarts'
import { useAppStore } from '../stores/app.js'
import { api } from '../utils/api.js'

const store = useAppStore()
const router = useRouter()

const TYPE_MAP = {
  cash: '现金', bank_deposit: '银行存款', investment: '投资', property: '房产', vehicle: '车辆', other: '其他',
  现金: '现金', 银行存款: '银行存款', 投资: '投资', 房产: '房产', 车辆: '车辆', 其他: '其他'
}
const TYPE_ORDER = ['现金', '银行存款', '投资', '房产', '车辆', '负债', '其他']

const loading = ref(true)
const error = ref('')
const overview = ref(null) // { netWorth, changePercent }
const accounts = ref([])
const trend = ref([]) // [{ label, value }]

const showAddModal = ref(false)
const saving = ref(false)
const saveError = ref('')
const form = ref({ name: '', type: 'cash', balance: null, note: '' })

const trendRef = ref(null)
let trendInst = null

// 账户按类型分组，并计算占净资产（绝对值总额）的比例
const groups = computed(() => {
  const totalAbs = accounts.value.reduce((s, a) => s + Math.abs(a.balance), 0)
  const map = new Map()
  for (const a of accounts.value) {
    const type = TYPE_MAP[a.type] || '其他'
    if (!map.has(type)) map.set(type, [])
    map.get(type).push({
      ...a,
      share: totalAbs > 0 ? Math.abs(a.balance) / totalAbs * 100 : 0
    })
  }
  return [...map.entries()]
    .sort((x, y) => TYPE_ORDER.indexOf(x[0]) - TYPE_ORDER.indexOf(y[0]))
    .map(([type, list]) => ({
      type,
      accounts: list,
      total: list.reduce((s, a) => s + a.balance, 0)
    }))
})

function fmtMoney(n) {
  const v = Number(n) || 0
  const abs = Math.abs(v).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
  return (v < 0 ? '-¥' : '¥') + abs
}

onMounted(async () => {
  if (!store.token) { router.push('/login'); return }
  await loadData()
  window.addEventListener('resize', onResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  trendInst?.dispose()
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [res, resList] = await Promise.all([api.getAssetsOverview(), api.getAssets()])
    if (res && res.success === false && res.error === '登录已过期') {
      store.logout(); router.push('/login'); return
    }
    if (res && res.success) {
      applyOverview(res.data || {})
    } else {
      // 接口未就绪或失败：保留已有数据，仅提示
      error.value = '资产数据加载失败，请稍后重试'
    }
    if (resList && resList.success) {
      const g = resList.data || {}
      applyAccounts([].concat(...Object.values(g)))
    }
  } catch (e) {
    error.value = '网络错误，请检查连接后重试'
  } finally {
    loading.value = false
    await nextTick()
    renderTrend()
  }
}

// 归一化后端返回（兼容后端并行开发的 summary/curve 结构）
function applyOverview(d) {
  const s = d.summary || {}
  const netWorth = Number(s.netWorth ?? s.net_worth ?? d.netWorth ?? d.net_worth ?? 0) || 0
  const prev = Number(d.prevNetWorth ?? d.prev_net_worth)
  let changePercent = Number(d.changePercent ?? d.change_percent)
  if (!Number.isFinite(changePercent)) {
    changePercent = Number.isFinite(prev) && prev !== 0
      ? (netWorth - prev) / Math.abs(prev) * 100
      : null
  }
  overview.value = {
    netWorth,
    totalAssets: Number(s.totalAssets ?? s.total_assets ?? 0) || 0,
    totalLiabilities: Number(s.totalLiabilities ?? s.total_liabilities ?? 0) || 0,
    changePercent
  }

  trend.value = (d.curve || d.trend || d.trends || [])
    .map(t => {
      const raw = String(t.date ?? t.label ?? t.day ?? '')
      return {
        label: raw.length > 5 ? raw.slice(-5) : raw,
        value: Number(t.netWorth ?? t.net_worth ?? t.value ?? t.amount)
      }
    })
    .filter(t => t.label && Number.isFinite(t.value))
}

function applyAccounts(list) {
  accounts.value = (list || []).map(a => ({
    id: a.id,
    name: a.name ?? '未命名账户',
    type: a.type ?? 'cash',
    balance: Number(a.amount ?? a.balance ?? 0) || 0,
    note: a.notes ?? a.note ?? a.remark ?? ''
  }))
}

function renderTrend() {
  if (!trendRef.value || !trend.value.length) return
  if (trendInst) trendInst.dispose()
  trendInst = echarts.init(trendRef.value)
  trendInst.setOption({
    tooltip: {
      trigger: 'axis',
      valueFormatter: v => fmtMoney(v)
    },
    grid: { left: 70, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: 'category',
      data: trend.value.map(t => t.label),
      axisLabel: { fontSize: 11 }
    },
    yAxis: {
      type: 'value',
      axisLabel: { fontSize: 11 }
    },
    series: [{
      name: '净资产',
      type: 'line',
      smooth: true,
      showSymbol: false,
      data: trend.value.map(t => t.value),
      lineStyle: { color: '#533afd', width: 2 },
      itemStyle: { color: '#533afd' },
      areaStyle: { color: 'rgba(83, 58, 253, 0.06)' }
    }]
  })
}

function onResize() { trendInst?.resize() }

function openAddModal() {
  saveError.value = ''
  showAddModal.value = true
}

async function createAccount() {
  if (!form.value.name) { saveError.value = '请输入账户名称'; return }
  if (form.value.balance === '' || form.value.balance === null || !Number.isFinite(Number(form.value.balance))) {
    saveError.value = '请输入有效余额'
    return
  }
  saving.value = true
  saveError.value = ''
  try {
    const res = await api.createAsset({
      name: form.value.name,
      type: form.value.type,
      amount: Number(form.value.balance),
      notes: form.value.note || undefined
    })
    if (res && res.success === false) {
      saveError.value = res.error || '保存失败，请重试'
      return
    }
    showAddModal.value = false
    form.value = { name: '', type: 'cash', balance: null, note: '' }
    await loadData()
  } catch (e) {
    saveError.value = '网络错误，保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.networth-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.networth-label {
  font-size: 13px;
  color: var(--text-secondary);
}
.networth-value {
  font-size: 36px;
  font-weight: 300;
  color: var(--text-title);
  letter-spacing: -0.02em;
  margin-top: 6px;
}
.networth-change {
  font-size: 13px;
  margin-top: 8px;
}
.networth-change.up { color: var(--success); }
.networth-change.down { color: var(--danger); }

.account-group {
  margin-bottom: 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.account-group:last-child { margin-bottom: 0; }
.account-group-header {
  flex: 0 0 100%;
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
/* 账户卡片：弹性不等宽错落排布 */
.account-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex: 1 1 240px;
  min-width: 240px;
  max-width: 360px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  transition: box-shadow 0.25s ease, transform 0.25s ease;
}
.account-row:nth-child(odd) { flex-grow: 1.35; }
.account-row:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
}
.account-name {
  font-size: 14px;
  color: var(--text-title);
}
.account-note {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}
.account-figures { text-align: right; }
.account-balance {
  font-size: 14px;
  font-weight: 600;
}
.account-balance.positive { color: var(--success); }
.account-balance.negative { color: var(--danger); }
.account-share {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.trend-chart { height: 260px; }

.modal-error {
  color: var(--danger);
  font-size: 13px;
  margin-top: 4px;
}
</style>
