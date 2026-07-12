<template>
  <div class="exchange-panel">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 style="font-size:15px;">🌍 汇率看板</h3>
      <span style="font-size:11px;color:var(--text-secondary);">
        数据源: ExchangeRate-API | 每小时更新
      </span>
    </div>

    <!-- 汇率卡片 -->
    <div class="rate-cards">
      <div v-for="c in currencies" :key="c.code" class="rate-card"
        :class="{ 'has-alert': c.alert }" @click="selectedCur = c.code">
        <div class="rate-header">
          <span class="rate-flag">{{ c.flag }}</span>
          <span class="rate-name">{{ c.name }}</span>
          <span class="rate-code">{{ c.code }}</span>
        </div>
        <div class="rate-value">{{ c.rate?.toFixed(4) || '—' }}</div>
        <div class="rate-change" :class="c.changeDirection"
          v-if="c.rate">
          <span class="change-arrow">{{ c.changeDirection === 'up' ? '↑' : c.changeDirection === 'down' ? '↓' : '→' }}</span>
          {{ c.change24h !== null ? (c.change24h > 0 ? '+' : '') + c.change24h + '%' : '—' }}
        </div>
        <div class="rate-alert-msg" v-if="c.alert">
          {{ c.alert }}
        </div>
      </div>
    </div>

    <!-- 异常告警列表 -->
    <div v-if="alerts.length > 0" class="alerts-section">
      <h4>🚨 汇率异常提醒</h4>
      <div v-for="(a, i) in alerts" :key="i" class="alert-item" :class="a.level">
        <strong>{{ a.title }}</strong>
        <p>{{ a.message }}</p>
      </div>
    </div>

    <!-- 货币详情弹窗 -->
    <div class="modal-overlay" v-if="selectedCur && detail" @click.self="selectedCur = null">
      <div class="modal" style="max-width:500px;">
        <h2>{{ detail.currency }} 详情</h2>

        <div style="margin:12px 0;font-size:24px;font-weight:700;">
          {{ detail.current?.toFixed(4) || '—' }}
          <span style="font-size:14px;color:var(--text-secondary);">CNY</span>
        </div>

        <div v-if="detail.change24h" style="margin-bottom:16px;">
          24h变化：
          <span :style="{color: detail.change24h.change > 0 ? 'var(--danger)' : 'var(--success)'}">
            {{ detail.change24h.change > 0 ? '+' : '' }}{{ detail.change24h.change }}%
          </span>
        </div>

        <div v-if="detail.trend" class="trend-info">
          <strong>{{ detail.trend.direction }}趋势</strong>
          连续{{ detail.trend.days }}天{{ detail.trend.direction }}，累计{{ detail.trend.totalChange > 0 ? '+' : '' }}{{ detail.trend.totalChange }}%
        </div>

        <!-- 趋势迷你图 -->
        <div v-if="detail.history && detail.history.length > 0" ref="miniChart" style="height:160px;margin:14px 0;"></div>

        <div v-if="detail.advice" class="rate-advice">
          💡 {{ detail.advice.advice }}
        </div>

        <div v-if="detail.weeklyReport" class="weekly-summary">
          <strong>📊 本周摘要:</strong>
          {{ detail.weeklyReport.start }} → {{ detail.weeklyReport.end }}
          ({{ detail.weeklyReport.trend }}{{ detail.weeklyReport.weekChange }}%)
          | 高 {{ detail.weeklyReport.high }} 低 {{ detail.weeklyReport.low }}
        </div>

        <div class="modal-actions">
          <button class="btn btn-outline" @click="selectedCur = null">关闭</button>
        </div>
      </div>
    </div>

    <div style="text-align:center;margin-top:12px;">
      <button class="btn btn-outline btn-sm" @click="refresh" :disabled="loading">
        {{ loading ? '更新中...' : '🔄 手动刷新' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch, nextTick } from 'vue'
import { api } from '../utils/api.js'
import * as echarts from 'echarts'

const loading = ref(false)
const selectedCur = ref(null)
const detail = ref(null)
const alerts = ref([])
const miniChart = ref(null)

const currencies = ref([
  { code: 'USD', name: '美元', flag: '🇺🇸', rate: null, change24h: null, changeDirection: '', alert: null },
  { code: 'EUR', name: '欧元', flag: '🇪🇺', rate: null, change24h: null, changeDirection: '', alert: null },
  { code: 'JPY', name: '日元', flag: '🇯🇵', rate: null, change24h: null, changeDirection: '', alert: null },
  { code: 'GBP', name: '英镑', flag: '🇬🇧', rate: null, change24h: null, changeDirection: '', alert: null },
  { code: 'HKD', name: '港币', flag: '🇭🇰', rate: null, change24h: null, changeDirection: '', alert: null },
  { code: 'KRW', name: '韩元', flag: '🇰🇷', rate: null, change24h: null, changeDirection: '', alert: null },
])

async function refresh() {
  loading.value = true
  try {
    const [rateRes, alertRes] = await Promise.all([
      api.getExchangeRates(),
      api.getExchangeAlerts()
    ])

    if (rateRes.data) {
      for (const c of currencies.value) {
        const d = rateRes.data[c.code]
        if (d) {
          c.rate = d.rate
          c.change24h = d.change24h
          c.changeDirection = d.change24h === null ? '' : d.change24h > 0 ? 'up' : d.change24h < 0 ? 'down' : 'flat'
          c.alert = detectAlert(c.code, d)
        }
      }
    }

    alerts.value = alertRes.data || []
  } catch {} finally {
    loading.value = false
  }
}

function detectAlert(code, data) {
  if (!data || data.change24h === null) return null
  if (Math.abs(data.change24h) >= 2) return '24h波动≥2%'
  const t = { USD: [6.8, 7.5], EUR: [7.0, 8.5], JPY: [0.044, 0.050] }
  const range = t[code]
  if (range && (data.rate >= range[1])) return `突破${range[1]}`
  if (range && (data.rate <= range[0])) return `跌破${range[0]}`
  return null
}

watch(selectedCur, async (cur) => {
  if (!cur) { detail.value = null; return }
  try {
    const res = await api.getExchangeDetail(cur)
    detail.value = res.data
    await nextTick()
    // 渲染迷你趋势图
    if (detail.value?.history?.length > 0 && miniChart.value) {
      const c = echarts.init(miniChart.value)
      c.setOption({
        tooltip: { trigger: 'axis' },
        grid: { left: 20, right: 10, top: 10, bottom: 20 },
        xAxis: { type: 'category', data: detail.value.history.map(h => h.fetched_at.slice(5, 16)), show: false },
        yAxis: { type: 'value', min: val => val.min - (val.max - val.min) * 0.3 },
        series: [{
          type: 'line',
          data: detail.value.history.map(h => h.rate),
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#4f46e5', width: 2 },
          areaStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1,[
            {offset:0, color:'rgba(79,70,229,0.15)'},
            {offset:1, color:'rgba(79,70,229,0)'}
          ])}
        }]
      })
    }
  } catch {}
})

onMounted(refresh)
</script>

<style scoped>
.exchange-panel {
  padding: 20px;
}

.rate-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(155px, 1fr));
  gap: 12px;
}

.rate-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  cursor: pointer;
  transition: all 0.2s;
  position: relative;
}
.rate-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  transform: translateY(-1px);
}
.rate-card.has-alert {
  border-left: 3px solid var(--warning);
}

.rate-header {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
}
.rate-flag { font-size: 16px; }
.rate-name { font-size: 12px; color: var(--text-secondary); }
.rate-code { font-size: 11px; color: #94a3b8; margin-left: auto; }

.rate-value {
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.rate-change {
  font-size: 12px;
  margin-top: 2px;
}
.rate-change.up { color: var(--danger); }
.rate-change.down { color: var(--success); }
.rate-change.flat { color: var(--text-secondary); }

.rate-alert-msg {
  font-size: 10px;
  color: #92400e;
  background: #fef3c7;
  padding: 2px 6px;
  border-radius: 4px;
  margin-top: 6px;
}

.alerts-section {
  margin-top: 20px;
}
.alerts-section h4 {
  font-size: 14px;
  margin-bottom: 10px;
}

.alert-item {
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 8px;
  font-size: 13px;
}
.alert-item.warning { background: #fffbeb; border-left: 3px solid var(--warning); }
.alert-item.critical { background: #fef2f2; border-left: 3px solid var(--danger); }
.alert-item.info { background: #eff6ff; border-left: 3px solid var(--primary); }
.alert-item p { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }

.trend-info {
  background: #f1f5f9;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12px;
  margin-bottom: 8px;
}

.rate-advice {
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  margin: 10px 0;
}

.weekly-summary {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 8px;
  background: #f8fafc;
  border-radius: 6px;
}
</style>
