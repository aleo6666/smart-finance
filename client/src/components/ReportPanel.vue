<template>
  <div class="report-panel">
    <div class="report-toolbar">
      <div class="period-switcher">
        <button v-for="p in periods" :key="p.key" class="period-btn" :class="{ active: activePeriod === p.key }" @click="switchPeriod(p.key)">{{ p.label }}</button>
      </div>
      <div style="flex:1"></div>
      <div class="export-dropdown" v-if="report">
        <button class="btn btn-sm btn-outline" @click="showExport = !showExport">📤 导出</button>
        <div class="export-menu" v-if="showExport">
          <button @click="doExport('excel')">📥 Excel (.xlsx)</button>
          <button @click="doExport('pdf')">📄 PDF (.pdf)</button>
          <button @click="doExport('image')">🖼 图片 (.png)</button>
        </div>
      </div>
    </div>

    <div v-if="loadError" class="error-banner" style="margin-bottom:12px;">
      ⚠️ {{ loadError }}
      <button class="btn btn-sm btn-outline" @click="loadAll()" style="margin-left:12px;">重试</button>
    </div>

    <div class="report-grid">
      <div class="report-card">
        <h3>📋 {{ periodLabel }}</h3>
        <!-- 加载中 -->
        <div v-if="!report && !loadError" class="empty-state" style="padding:30px;"><p>加载中...</p></div>
        <!-- 已加载（始终显示统计数字，无数据也显示 ¥0） -->
        <div v-else-if="report">
          <div class="stat-row">
            <div class="stat-item income"><div class="stat-value">¥{{ fmt(report.income) }}</div><div class="stat-label">收入</div></div>
            <div class="stat-item expense"><div class="stat-value">¥{{ fmt(report.expense) }}</div><div class="stat-label">支出</div></div>
            <div class="stat-item" :style="{color:report.balance>=0?'var(--success)':'var(--danger)'}"><div class="stat-value">{{ report.balance>=0?'+':'' }}{{ fmt(report.balance) }}</div><div class="stat-label">结余</div></div>
          </div>
          <div style="margin-top:14px;font-size:13px;color:var(--text-secondary);">
            共 {{ report.count }} 笔 | 储蓄率 {{ report.savingsRate }}%
            <div style="font-size:11px;margin-top:2px;">{{ report.fromDate }} ~ {{ report.toDate }}</div>
          </div>
        </div>
        <!-- 加载失败 -->
        <div v-else class="empty-state" style="padding:30px;">
          <div class="empty-icon">📭</div>
          <p>数据加载失败</p>
        </div>
      </div>

      <div class="report-card">
        <h3>🍩 支出分类</h3>
        <div v-if="hasCategories" ref="pieRef" style="width:100%;height:280px;"></div>
        <div v-if="!hasCategories" class="empty-state" style="padding:30px;"><p>暂无支出记录</p></div>
      </div>
    </div>

    <div class="report-card risk-card" style="margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h3>⚠️ 本月风险提醒</h3>
        <button v-if="store.reminderHighlights.length > 0" class="btn btn-sm btn-outline" @click="store.refreshReminderHighlights()">刷新</button>
      </div>
      <div v-if="store.reminderHighlights.length > 0" class="risk-list">
        <div v-for="r in store.reminderHighlights" :key="r.id" class="risk-item" :class="r.display?.accent">
          <div style="flex:1">
            <div class="risk-summary">{{ r.display?.summary || r.title }}</div>
            <div class="risk-detail">{{ r.display?.detail || r.message }}</div>
          </div>
          <button class="btn btn-sm btn-outline" @click="store.markReminderRead(r.id)">已读</button>
        </div>
      </div>
      <div v-else class="empty-state" style="padding:18px;">
        <p>暂无预算风险，继续保持 ✨</p>
      </div>
    </div>

    <div class="report-card" style="margin-bottom:20px;">
      <h3>📈 消费趋势</h3>
      <div v-if="hasTrends" ref="trendRef" style="width:100%;height:320px;"></div>
      <div v-if="!hasTrends" class="empty-state" style="padding:30px;"><p>数据不足</p></div>
    </div>

    <!-- 明细列表（含编辑按钮） -->
    <div class="report-card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h3>📝 最近记录</h3>
        <span style="font-size:12px;color:var(--text-secondary);">{{ records.length }} 条</span>
      </div>
      <div v-if="records.length > 0">
        <div class="record-item" v-for="r in records" :key="r.id">
          <div style="flex:1">
            <div class="record-desc">
              {{ r.description || r.category }}
              <span v-if="r.merchant" class="record-tag">🏪 {{ r.merchant }}</span>
            </div>
            <div class="record-cat">{{ r.date }} · {{ r.category }} · {{ r.type === 'income' ? '收入' : '支出' }}</div>
          </div>
          <div class="record-amount" :class="r.type">
            {{ r.type === 'income' ? '+' : '-' }}{{ r.amount.toFixed(2) }}
          </div>
          <button class="btn-edit" @click="openEdit(r)" title="编辑">✎</button>
        </div>
      </div>
      <div v-else class="empty-state" style="padding:20px;"><p>暂无记录</p></div>
    </div>

    <!-- 编辑弹窗 -->
    <div class="modal-overlay" v-if="editRec" @click.self="editRec = null">
      <div class="modal" style="max-width:420px;">
        <h2>✎ 编辑记录</h2>
        <div class="form-group">
          <label>类型</label>
          <select v-model="editForm.type" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;">
            <option value="expense">支出</option>
            <option value="income">收入</option>
          </select>
        </div>
        <div class="form-group">
          <label>金额</label>
          <input v-model.number="editForm.amount" type="number" step="0.01" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;" />
        </div>
        <div class="form-group">
          <label>分类</label>
          <select v-model="editForm.category" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;">
            <option v-for="c in allCats" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>日期</label>
          <input v-model="editForm.date" type="date" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;" />
        </div>
        <div class="form-group">
          <label>商家</label>
          <input v-model="editForm.merchant" type="text" placeholder="选填" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;" />
        </div>
        <div class="form-group">
          <label>描述</label>
          <input v-model="editForm.description" type="text" placeholder="选填" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="editRec = null">取消</button>
          <button class="btn btn-primary" @click="saveEdit" :disabled="savingEdit">{{ savingEdit ? '保存中...' : '保存' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'
import { api } from '../utils/api.js'
import * as echarts from 'echarts'

const store = useAppStore()
const router = useRouter()

const periods = [
  { key: 'week', label: '近一周' },
  { key: 'month', label: '近一月' },
  { key: 'quarter', label: '近一季' }
]
const activePeriod = ref('month')
const showExport = ref(false)

const report = ref(null)
const records = ref([])
const pieRef = ref(null)
const trendRef = ref(null)
let pieInst = null
let trendInst = null

// 编辑状态
const editRec = ref(null)
const editForm = ref({})
const savingEdit = ref(false)

const periodLabel = computed(() => {
  const m = { week: '最近一周概览', month: '最近一月概览', quarter: '最近一季概览' }
  return m[activePeriod.value] || '概览'
})
const hasCategories = computed(() => report.value?.categories?.length > 0)
const hasTrends = computed(() => report.value?.trends?.length > 0)
const allCats = ref(['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他'])

function fmt(n) { return n != null ? n.toFixed(0) : '0' }

async function switchPeriod(key) { activePeriod.value = key; await loadAll() }

const loadError = ref('')

async function loadAll() {
  loadError.value = ''
  try {
    // 关键数据：报告 + 记录，10s 超时
    const [rRes, recRes] = await Promise.race([
      Promise.all([
        api.getReportTimerange(activePeriod.value, store.selectedLedgerId),
        api.getRecords({
          limit: 50,
          ...(store.selectedLedgerId ? { ledgerId: store.selectedLedgerId } : {})
        }),
        store.refreshReminderHighlights()
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
    ])

    // auth 过期 → 跳转登录
    if (!rRes.success && rRes.error === '登录已过期') { store.logout(); router.push('/login'); return }
    if (!recRes.success && recRes.error === '登录已过期') { store.logout(); router.push('/login'); return }

    if (rRes.success) {
      report.value = rRes.data
    } else {
      loadError.value = '消费分析数据加载失败'
    }

    if (recRes.success) {
      // 归一化数值（MySQL DECIMAL 返回字符串）
      records.value = (recRes.data || []).map(r => ({
        ...r,
        amount: Number(r.amount) || 0,
        amount_cny: Number(r.amount_cny) || 0
      }))
    }
  } catch (e) {
    console.error('ReportPanel error:', e)
    loadError.value = e.message === 'timeout'
      ? '请求超时，请检查网络后刷新重试'
      : '网络错误，请刷新重试'
  }
}

watch([hasCategories, hasTrends], async ([cats, trends]) => {
  await nextTick()
  if (cats) renderPie()
  if (trends) renderTrend()
})

watch(() => store.selectedLedgerId, () => {
  loadAll()
})

function renderPie() {
  if (!pieRef.value || !report.value?.categories?.length) return
  if (pieInst) pieInst.dispose()
  pieInst = echarts.init(pieRef.value)
  pieInst.setOption({
    tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)' },
    series: [{
      type: 'pie', radius: ['45%', '75%'], center: ['50%', '55%'],
      itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 3 },
      label: { fontSize: 11, formatter: '{b}\n{d}%' },
      data: report.value.categories.map(c => ({ name: c.category, value: c.total }))
    }]
  })
}

function renderTrend() {
  if (!trendRef.value || !report.value?.trends?.length) return
  if (trendInst) trendInst.dispose()
  trendInst = echarts.init(trendRef.value)
  const labels = report.value.trends.map(t => t.label)
  const shortLabels = labels.map(l => activePeriod.value === 'quarter' ? l : l.slice(5))
  trendInst.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['支出', '收入'], bottom: 0 },
    grid: { left: 55, right: 20, top: 20, bottom: 40 },
    xAxis: { type: 'category', data: shortLabels, axisLabel: { fontSize: 11, rotate: activePeriod.value === 'month' ? 45 : 0 } },
    yAxis: { type: 'value' },
    series: [
      { name: '支出', type: 'line', data: report.value.trends.map(t => t.expense), smooth: true, areaStyle: { color: 'rgba(239,68,68,0.06)' }, lineStyle: { color: '#ef4444', width: 2 }, itemStyle: { color: '#ef4444' } },
      { name: '收入', type: 'line', data: report.value.trends.map(t => t.income), smooth: true, areaStyle: { color: 'rgba(16,185,129,0.06)' }, lineStyle: { color: '#10b981', width: 2 }, itemStyle: { color: '#10b981' } }
    ]
  })
}

// ====== 编辑功能 ======
function openEdit(rec) {
  editRec.value = rec
  editForm.value = {
    type: rec.type,
    amount: rec.amount,
    category: rec.category,
    date: rec.date,
    merchant: rec.merchant || '',
    description: rec.description || ''
  }
}

async function saveEdit() {
  if (!editRec.value || savingEdit.value) return
  savingEdit.value = true
  try {
    await api.updateRecord(editRec.value.id, editForm.value)
    editRec.value = null
    await loadAll() // 刷新列表
  } catch (e) {
    console.error('编辑失败', e)
  } finally {
    savingEdit.value = false
  }
}

function doExport(format) {
  showExport.value = false
  const params = { periodType: 'month', periodValue: new Date().toISOString().slice(0, 7) }
  if (format === 'excel') api.exportExcel(params)
  else if (format === 'pdf') api.exportPdf(params)
  else if (format === 'image') api.exportImage(params)
}

function onResize() { pieInst?.resize(); trendInst?.resize() }
function onClickDoc(e) { if (!e.target.closest('.export-dropdown')) showExport.value = false }

onMounted(async () => {
  if (!store.token) { router.push('/login'); return }
  await loadAll()
  document.addEventListener('click', onClickDoc)
  window.addEventListener('resize', onResize)
})

onUnmounted(() => {
  document.removeEventListener('click', onClickDoc)
  window.removeEventListener('resize', onResize)
  pieInst?.dispose()
  trendInst?.dispose()
})
</script>

<style scoped>
.report-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.period-switcher{display:flex;background:var(--bg);border-radius:10px;padding:3px;gap:2px}
.period-btn{padding:6px 18px;border:none;background:transparent;border-radius:8px;cursor:pointer;font-size:14px;color:var(--text-secondary);font-weight:500;transition:all .2s}
.period-btn:hover{color:var(--text)}
.period-btn.active{background:var(--bg-card);color:var(--primary);box-shadow:0 1px 3px rgba(0,0,0,.1)}
.export-dropdown{position:relative}
.export-menu{position:absolute;right:0;top:36px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);z-index:100;min-width:170px;overflow:hidden}
.export-menu button{display:block;width:100%;padding:10px 16px;border:none;background:transparent;cursor:pointer;text-align:left;font-size:13px;color:var(--text)}
.export-menu button:hover{background:var(--bg)}
.record-tag{display:inline-block;padding:1px 6px;background:var(--bg);border-radius:4px;font-size:11px;color:var(--text-secondary);margin-left:6px}
.risk-list{display:flex;flex-direction:column;gap:10px}
.risk-item{display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--border);border-left:4px solid var(--primary);border-radius:10px;background:#fff}
.risk-item.warning{border-left-color:var(--warning);background:#fffbeb}
.risk-item.danger{border-left-color:var(--danger);background:#fef2f2}
.risk-summary{font-weight:600;font-size:14px;color:var(--text)}
.risk-detail{font-size:12px;color:var(--text-secondary);margin-top:4px}
/* 编辑按钮 */
.btn-edit{background:none;border:none;cursor:pointer;font-size:15px;opacity:0.4;padding:4px 8px;margin-left:4px;border-radius:4px;transition:all .2s}
.btn-edit:hover{opacity:1;background:var(--bg);color:var(--primary)}
</style>
