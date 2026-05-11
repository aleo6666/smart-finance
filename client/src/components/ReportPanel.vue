<template>
  <div class="report-panel">
    <!-- 月度概览 -->
    <div class="report-grid">
      <div class="report-card">
        <h3>📋 月度概览</h3>
        <div v-if="monthly">
          <div class="stat-row">
            <div class="stat-item income">
              <div class="stat-value">¥{{ monthly.income.toFixed(0) }}</div>
              <div class="stat-label">收入</div>
            </div>
            <div class="stat-item expense">
              <div class="stat-value">¥{{ monthly.expense.toFixed(0) }}</div>
              <div class="stat-label">支出</div>
            </div>
            <div class="stat-item balance">
              <div class="stat-value">{{ monthly.savingsRate }}%</div>
              <div class="stat-label">储蓄率</div>
            </div>
          </div>
          <div style="margin-top: 14px; font-size: 13px; color: var(--text-secondary);">
            结余: ¥{{ monthly.balance.toFixed(0) }}
            <span v-if="monthly.change != 0" :style="{ color: monthly.change > 0 ? 'var(--danger)' : 'var(--success)' }">
              | 环比 {{ monthly.change > 0 ? '↑' : '↓' }}{{ Math.abs(monthly.change) }}%
            </span>
          </div>
        </div>
        <div v-else class="empty-state" style="padding: 30px;">
          <p>暂无数据，开始记账吧~</p>
        </div>
      </div>

      <!-- 分类饼图 -->
      <div class="report-card">
        <h3>🍩 消费分类</h3>
        <div v-if="categoryData.length > 0" ref="pieChart" style="height: 300px;"></div>
        <div v-else class="empty-state" style="padding: 30px;">
          <p>暂无消费记录</p>
        </div>
      </div>
    </div>

    <!-- 趋势图 -->
    <div class="report-card" style="margin-bottom: 20px;">
      <h3>📈 消费趋势（近6个月）</h3>
      <div v-if="trendData.length > 0" ref="trendChart" style="height: 320px;"></div>
      <div v-else class="empty-state" style="padding: 30px;">
        <p>数据不足，再多记录一段时间吧~</p>
      </div>
    </div>

    <!-- 最近记录 -->
    <div class="report-card">
      <h3>📝 最近记录</h3>
      <div v-if="recentRecords.length > 0">
        <div class="record-item" v-for="r in recentRecords" :key="r.id">
          <div>
            <div class="record-desc">{{ r.description || r.category }}</div>
            <div class="record-cat">{{ r.date }} · {{ r.category }}</div>
          </div>
          <div class="record-amount" :class="r.type">
            {{ r.type === 'income' ? '+' : '-' }}{{ r.amount.toFixed(2) }}
          </div>
        </div>
      </div>
      <div v-else class="empty-state" style="padding: 20px;">
        <p>暂无记录</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick, watch } from 'vue'
import { useAppStore } from '../stores/app.js'
import { api } from '../utils/api.js'
import * as echarts from 'echarts'

const store = useAppStore()
const monthly = ref(null)
const categoryData = ref([])
const trendData = ref([])
const recentRecords = ref([])
const pieChart = ref(null)
const trendChart = ref(null)

async function loadData() {
  const [m, c, t, records] = await Promise.all([
    api.getMonthlyReport(),
    api.getCategoryReport(),
    api.getTrend(6),
    api.getRecords({ limit: 10 })
  ])

  monthly.value = m.data
  categoryData.value = c.data || []
  trendData.value = t.data || []
  recentRecords.value = records.data || []

  await nextTick()
  renderCharts()
}

function renderCharts() {
  // 饼图
  if (pieChart.value && categoryData.value.length > 0) {
    const pie = echarts.init(pieChart.value)
    pie.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)' },
      series: [{
        type: 'pie',
        radius: ['45%', '75%'],
        center: ['50%', '50%'],
        itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 3 },
        label: { fontSize: 12 },
        data: categoryData.value.map(c => ({ name: c.category, value: c.total }))
      }]
    })
  }

  // 趋势图
  if (trendChart.value && trendData.value.length > 0) {
    const trend = echarts.init(trendChart.value)
    const months = trendData.value.map(d => d.month)
    trend.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['收入', '支出'], bottom: 0 },
      grid: { left: 50, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: months },
      yAxis: { type: 'value' },
      series: [
        {
          name: '收入', type: 'bar',
          data: trendData.value.map(d => d.income),
          itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] }
        },
        {
          name: '支出', type: 'line',
          data: trendData.value.map(d => d.expense),
          smooth: true,
          lineStyle: { color: '#ef4444', width: 2 },
          itemStyle: { color: '#ef4444' }
        }
      ]
    })
  }
}

onMounted(loadData)
</script>
