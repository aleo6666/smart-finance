<template>
  <div class="report-panel">
    <!-- 顶部：标题 + 月份切换 -->
    <div class="month-header">
      <h2>月度报告 · {{ monthLabel }}</h2>
      <input class="month-input" type="month" v-model="month" @change="loadData" />
    </div>

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
      <!-- 月度概览 -->
      <div class="report-card overview-card">
        <h3>月度概览</h3>
        <div class="stat-row">
          <div class="stat-item income">
            <div class="stat-value">{{ summary ? fmtMoney(summary.income) : '--' }}</div>
            <div class="stat-label">收入</div>
          </div>
          <div class="stat-item expense">
            <div class="stat-value">{{ summary ? fmtMoney(summary.expense) : '--' }}</div>
            <div class="stat-label">支出</div>
          </div>
          <div class="stat-item balance" :class="{ negative: summary && summary.balance < 0 }">
            <div class="stat-value">{{ summary ? fmtMoney(summary.balance) : '--' }}</div>
            <div class="stat-label">结余</div>
          </div>
        </div>
      </div>

      <div class="report-grid" style="margin-top: 20px;">
        <!-- 分类支出排行 -->
        <div class="report-card">
          <h3>分类支出排行</h3>
          <template v-if="categories.length">
            <div v-for="(c, i) in categories" :key="c.category" class="cat-row">
              <span class="cat-rank" :class="{ top: i < 3 }">{{ i + 1 }}</span>
              <span class="cat-name">{{ c.category }}</span>
              <div class="cat-bar">
                <div class="cat-fill" :style="{ width: Math.min(c.percent, 100) + '%' }"></div>
              </div>
              <span class="cat-percent num">{{ c.percent.toFixed(1) }}%</span>
              <span class="cat-amount num">{{ fmtMoney(c.total) }}</span>
            </div>
          </template>
          <div v-else class="empty-state" style="padding: 40px 20px;">
            <p>暂无分类支出数据</p>
          </div>
        </div>

        <!-- 预算对比 -->
        <div class="report-card">
          <h3>预算对比（实际 vs 预算）</h3>
          <template v-if="budgets.length">
            <div v-for="b in budgets" :key="b.id ?? b.category ?? 'total'" style="margin-bottom: 14px;">
              <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px;">
                <span>{{ b.category || '总预算' }}</span>
                <span class="num">{{ fmtMoney(b.spent) }} / {{ fmtMoney(b.amount) }}</span>
              </div>
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  :class="b.percent > 100 ? 'danger' : b.percent > 80 ? 'warn' : 'good'"
                  :style="{ width: Math.min(b.percent, 100) + '%' }"
                ></div>
              </div>
              <div style="font-size: 12px; color: var(--text-secondary);">
                已用 {{ b.percent }}%<span v-if="b.percent > 100">，超出预算</span>
              </div>
            </div>
          </template>
          <div v-else class="empty-state" style="padding: 40px 20px;">
            <p>暂无预算数据</p>
            <p style="font-size: 12px;">可在「目标」页面设置月度预算</p>
          </div>
        </div>

        <!-- 财务健康分 -->
        <div class="report-card">
          <h3>财务健康分</h3>
          <div v-if="healthScore !== null" class="health-wrap">
            <div class="health-score num" :class="healthClass">{{ healthScore }}</div>
            <div class="health-label" :class="healthClass">{{ healthLabel }}</div>
          </div>
          <div v-else class="empty-state" style="padding: 40px 20px;">
            <p>暂无健康分数据</p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'
import { api } from '../utils/api.js'

const store = useAppStore()
const router = useRouter()

function currentMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const month = ref(currentMonth())
const loading = ref(true)
const error = ref('')
const summary = ref(null) // { income, expense, balance }
const categories = ref([]) // [{ category, total, percent }]
const budgets = ref([]) // [{ category, amount, spent, percent }]
const healthScore = ref(null)

const monthLabel = computed(() => {
  const [y, m] = month.value.split('-')
  return `${y}年${Number(m)}月`
})

const healthClass = computed(() => {
  const s = healthScore.value
  if (s === null) return ''
  return s >= 80 ? 'good' : s >= 60 ? 'fine' : s >= 40 ? 'warn' : 'bad'
})

const healthLabel = computed(() => {
  const s = healthScore.value
  if (s === null) return ''
  return s >= 80 ? '财务状况优秀' : s >= 60 ? '财务状况良好' : s >= 40 ? '财务状况一般' : '财务健康需关注'
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
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [mRes, cRes, bRes] = await Promise.all([
      api.getMonthlyReport(month.value),
      api.getCategoryReport(month.value),
      api.getBudgets()
    ])

    // 任一接口返回登录过期则跳转登录
    for (const r of [mRes, cRes, bRes]) {
      if (r && r.success === false && r.error === '登录已过期') {
        store.logout(); router.push('/login'); return
      }
    }

    // 月度概览 + 健康分
    if (mRes && mRes.success) {
      const d = mRes.data || {}
      const income = Number(d.income ?? d.total_income ?? 0) || 0
      const expense = Number(d.expense ?? d.total_expense ?? 0) || 0
      const balance = Number(d.balance ?? d.net ?? (income - expense)) || 0
      summary.value = { income, expense, balance }
      const hs = Number(d.healthScore ?? d.health_score ?? d.score)
      healthScore.value = Number.isFinite(hs) ? hs : null
    } else {
      summary.value = null
      healthScore.value = null
    }

    // 分类支出排行（占比缺失时按总额推算）
    if (cRes && cRes.success) {
      const list = cRes.data || []
      const sum = list.reduce((s, c) => s + (Number(c.total ?? c.amount ?? 0) || 0), 0)
      categories.value = list
        .map(c => {
          const total = Number(c.total ?? c.amount ?? 0) || 0
          const percent = Number(c.percent ?? c.ratio)
          return {
            category: c.category ?? c.name ?? '未分类',
            total,
            percent: Number.isFinite(percent) ? percent : (sum > 0 ? total / sum * 100 : 0)
          }
        })
        .sort((a, b) => b.total - a.total)
    } else {
      categories.value = []
    }

    // 预算对比
    if (bRes && bRes.success) {
      budgets.value = (bRes.data || []).map(b => {
        const amount = Number(b.amount) || 0
        const spent = Number(b.spent) || 0
        return {
          ...b,
          amount,
          spent,
          percent: amount > 0 ? Math.round(spent / amount * 100) : 0
        }
      })
    } else {
      budgets.value = []
    }

    if (!mRes?.success && !cRes?.success && !bRes?.success) {
      error.value = '报告数据加载失败，请稍后重试'
    }
  } catch (e) {
    error.value = '网络错误，请检查连接后重试'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.month-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  flex-wrap: wrap;
  gap: 10px;
}
.month-header h2 {
  font-size: 16px;
  font-weight: 600;
}
.month-input {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  outline: none;
  background: var(--bg-card);
  color: var(--text-title);
  font-family: inherit;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.month-input:focus {
  border-color: var(--primary);
  box-shadow: var(--ring);
}

/* 概览：一大两小错落排布 */
.overview-card .stat-row {
  grid-template-columns: 1fr 1fr 1.4fr;
}
.overview-card .stat-item {
  text-align: left;
  padding: 16px 18px;
}
.overview-card .stat-value {
  font-size: 26px;
  font-weight: 300;
  letter-spacing: -0.01em;
}
.overview-card .stat-item.balance .stat-value {
  font-size: 34px;
  letter-spacing: -0.02em;
}
.overview-card .stat-item.balance.negative .stat-value {
  color: var(--danger);
}

/* 概览标签徽章 */
.overview-card .stat-item .stat-label {
  display: inline-block;
  margin-top: 10px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  background: var(--bg-card);
  border: 1px solid var(--border);
}
.overview-card .stat-item.income .stat-label {
  background: var(--success-soft);
  border-color: transparent;
  color: var(--success);
}
.overview-card .stat-item.expense .stat-label {
  background: var(--danger-soft);
  border-color: transparent;
  color: var(--danger);
}
.overview-card .stat-item.balance .stat-label {
  background: var(--primary-soft);
  border-color: transparent;
  color: var(--primary);
}

@media (max-width: 640px) {
  .overview-card .stat-row {
    grid-template-columns: 1fr 1fr;
  }
  .overview-card .stat-item.balance {
    grid-column: 1 / -1;
  }
  .overview-card .stat-item.balance .stat-value {
    font-size: 24px;
  }
}

/* 分类支出排行 */
.cat-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
}
.cat-rank {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.cat-rank.top {
  background: var(--primary-soft);
  color: var(--primary);
  border-color: var(--primary-light);
  font-weight: 600;
}
.cat-name {
  width: 64px;
  font-size: 13px;
  color: var(--text-title);
  flex-shrink: 0;
}
.cat-bar {
  flex: 1;
  height: 6px;
  background: var(--bg-track);
  border-radius: 3px;
  overflow: hidden;
}
.cat-fill {
  height: 100%;
  background: var(--primary);
  border-radius: 3px;
  transition: width 0.5s ease;
}
.cat-percent {
  width: 52px;
  text-align: right;
  font-size: 12px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.cat-amount {
  width: 100px;
  text-align: right;
  font-size: 13px;
  color: var(--text-title);
  font-weight: 600;
  flex-shrink: 0;
}

/* 健康分 */
.health-wrap {
  text-align: center;
  padding: 16px 0;
}
.health-score {
  font-size: 44px;
  font-weight: 300;
  letter-spacing: -0.01em;
  color: var(--text-title);
}
.health-score.good { color: var(--success); }
.health-score.fine { color: var(--primary); }
.health-score.warn { color: var(--warning); }
.health-score.bad { color: var(--danger); }
.health-label {
  font-size: 13px;
  margin-top: 6px;
  color: var(--text-secondary);
}
</style>
