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

    <template v-if="!loading && analysis">
      <!-- 总分卡片 -->
      <div class="report-card score-card">
        <!-- 剪纸窗花圆环（纯装饰） -->
        <svg class="score-deco" viewBox="0 0 200 200" aria-hidden="true">
          <circle cx="100" cy="100" r="96" fill="none" stroke="#C4402B" stroke-width="2" opacity="0.5"/>
          <circle cx="100" cy="100" r="80" fill="none" stroke="#C9A227" stroke-width="1.5" stroke-dasharray="4 5" opacity="0.8"/>
          <g fill="#C4402B" opacity="0.55">
            <path d="M100 20 C106 32 106 42 100 52 C94 42 94 32 100 20 Z"/>
            <path d="M100 20 C106 32 106 42 100 52 C94 42 94 32 100 20 Z" transform="rotate(45 100 100)"/>
            <path d="M100 20 C106 32 106 42 100 52 C94 42 94 32 100 20 Z" transform="rotate(90 100 100)"/>
            <path d="M100 20 C106 32 106 42 100 52 C94 42 94 32 100 20 Z" transform="rotate(135 100 100)"/>
            <path d="M100 20 C106 32 106 42 100 52 C94 42 94 32 100 20 Z" transform="rotate(180 100 100)"/>
            <path d="M100 20 C106 32 106 42 100 52 C94 42 94 32 100 20 Z" transform="rotate(225 100 100)"/>
            <path d="M100 20 C106 32 106 42 100 52 C94 42 94 32 100 20 Z" transform="rotate(270 100 100)"/>
            <path d="M100 20 C106 32 106 42 100 52 C94 42 94 32 100 20 Z" transform="rotate(315 100 100)"/>
          </g>
          <circle cx="100" cy="100" r="34" fill="none" stroke="#C4402B" stroke-width="2" opacity="0.7"/>
          <rect x="92" y="92" width="16" height="16" fill="none" stroke="#C9A227" stroke-width="2.5" transform="rotate(45 100 100)"/>
        </svg>
        <div class="score-header">
          <div>
            <div class="score-label">财务健康总分</div>
            <div class="score-value">
              <span class="num">{{ totalScore.toFixed(1) }}</span>
              <span class="score-max">/ 100</span>
            </div>
            <div class="score-grade" :class="gradeClass">{{ gradeText }}</div>
          </div>
          <div class="score-side">
            <div class="score-side-row">
              <span>评估维度</span>
              <b class="num">{{ analysis.dimensions.length }} 项</b>
            </div>
            <p class="score-tip">基于你当前的资产、负债、收入与画像数据，按 CFP 七维框架自动评分。补充数据后评分会更准确。</p>
          </div>
        </div>
      </div>

      <div class="report-grid" style="margin-top: 20px;">
        <!-- 雷达图 -->
        <div class="report-card">
          <h3>七维健康雷达</h3>
          <div v-if="analysis && analysis.dimensions && analysis.dimensions.length" ref="radarRef" class="radar-chart"></div>
          <div v-else class="empty-state" style="padding: 40px 20px;">
            <p>暂无维度数据</p>
          </div>
        </div>

        <!-- 优先建议 -->
        <div class="report-card">
          <h3>当前优先事项</h3>
          <ul class="advice-list">
            <li v-for="(a, i) in analysis.overall_advice" :key="i">
              <span class="advice-dot"></span>{{ a }}
            </li>
          </ul>
          <h3 style="margin-top: 24px;">评测假设</h3>
          <ul v-if="assumptions.length" class="assumption-list">
            <li v-for="(a, i) in assumptions" :key="i">{{ a }}</li>
          </ul>
          <p v-else class="muted">基于完整数据评测，无额外假设。</p>
          <h3 v-if="guidingQuestions.length" style="margin-top: 24px;">待补充信息</h3>
          <ul v-if="guidingQuestions.length" class="assumption-list">
            <li v-for="(q, i) in guidingQuestions" :key="i">❓ {{ q }}</li>
          </ul>
        </div>
      </div>

      <!-- 各维度明细 -->
      <div class="report-card" style="margin-top: 20px;">
        <h3>维度明细</h3>
        <div v-if="analysis.dimensions.length" class="dims">
          <div v-for="d in analysis.dimensions" :key="d.name" class="dim-card" :style="{ borderColor: dimColor(d.score) }">
            <div class="dim-head">
              <span class="dim-name">{{ d.name }}</span>
              <span class="dim-score num" :style="{ color: dimColor(d.score) }">{{ Number(d.score).toFixed(0) }}</span>
            </div>
            <div class="dim-bar">
              <div class="dim-bar-fill" :style="{ width: d.score + '%', background: dimColor(d.score) }"></div>
            </div>
            <p v-if="d.issues.length" class="dim-issues">{{ d.issues.join('；') }}</p>
            <ul v-if="d.advice.length" class="dim-advice">
              <li v-for="(a, i) in d.advice" :key="i">· {{ a }}</li>
            </ul>
          </div>
        </div>
        <div v-else class="empty-state" style="padding: 40px 20px;">
          <p>暂无维度数据</p>
        </div>
      </div>
    </template>
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

const loading = ref(true)
const error = ref('')
const data = ref(null)
const radarRef = ref(null)
let radarInst = null

const analysis = computed(() => (data.value && data.value.analysis) || null)
const assumptions = computed(() => (data.value && data.value.assumptions) || [])
const guidingQuestions = computed(() => (data.value && data.value.guiding_questions) || [])
const totalScore = computed(() => {
  const raw = analysis.value && analysis.value.total_score
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
})
const gradeText = computed(() => {
  const s = totalScore.value
  if (s >= 85) return '优秀'
  if (s >= 70) return '良好'
  if (s >= 60) return '及格'
  return '待改善'
})
const gradeClass = computed(() => {
  const s = totalScore.value
  if (s >= 85) return 'grade-good'
  if (s >= 60) return 'grade-mid'
  return 'grade-bad'
})

// 评分映射颜色：高分绿、中分橙、低分红
function dimColor(score) {
  const s = Number(score)
  if (s >= 80) return '#15be53'
  if (s >= 60) return '#9b6829'
  return '#e5484d'
}

onMounted(async () => {
  if (!store.token) { router.push('/login'); return }
  await loadData()
  window.addEventListener('resize', onResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  radarInst?.dispose()
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const res = await api.getHealthScore()
    if (res && res.success === false && res.error === '登录已过期') {
      store.logout(); router.push('/login'); return
    }
    if (res && res.success) {
      data.value = res.data || {}
    } else {
      error.value = (res && res.error) || '健康评分加载失败，请稍后重试'
    }
  } catch (e) {
    error.value = '网络错误，请检查连接后重试'
  } finally {
    loading.value = false
    await nextTick()
    renderRadar()
  }
}

function renderRadar() {
  if (!analysis.value || !analysis.value.dimensions || !analysis.value.dimensions.length) return
  if (!radarRef.value) return
  if (radarInst) radarInst.dispose()
  radarInst = echarts.init(radarRef.value)
  const dims = analysis.value.dimensions
  radarInst.setOption({
    tooltip: {},
    radar: {
      indicator: dims.map(d => ({ name: d.name, max: 100 })),
      radius: '68%',
      splitNumber: 4,
      axisName: { color: '#8A8578', fontSize: 12 },
      splitLine: { lineStyle: { color: '#E8DFD0' } },
      splitArea: { areaStyle: { color: ['#FFFFFF', '#F3EDE3'] } },
      axisLine: { lineStyle: { color: '#E8DFD0' } }
    },
    series: [{
      type: 'radar',
      data: [{
        value: dims.map(d => Number(d.score)),
        name: '财务健康',
        lineStyle: { color: '#533afd', width: 2 },
        itemStyle: { color: '#533afd' },
        areaStyle: { color: 'rgba(83, 58, 253, 0.10)' }
      }]
    }]
  })
}

function onResize() { radarInst?.resize() }
</script>

<style scoped>
.score-card {
  position: relative;
  overflow: hidden;
}
.score-deco {
  position: absolute;
  top: -46px;
  right: -42px;
  width: 210px;
  height: 210px;
  pointer-events: none;
  opacity: 0.6;
}
.score-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  flex-wrap: wrap;
  position: relative;
  z-index: 1;
}
.score-label {
  font-size: 13px;
  color: var(--text-secondary);
}
.score-value {
  font-size: 48px;
  font-weight: 700;
  font-family: var(--font-serif);
  color: var(--text-title);
  letter-spacing: -0.02em;
  margin-top: 6px;
  line-height: 1;
}
.score-max {
  font-size: 16px;
  font-family: var(--font-serif);
  color: var(--text-secondary);
  margin-left: 4px;
}
.score-grade {
  display: inline-block;
  margin-top: 10px;
  font-size: 13px;
  font-weight: 600;
  padding: 3px 12px;
  border-radius: 999px;
}
.grade-good { color: #15be53; background: rgba(21, 190, 83, 0.1); }
.grade-mid { color: #9b6829; background: rgba(155, 104, 41, 0.12); }
.grade-bad { color: #e5484d; background: rgba(229, 72, 77, 0.08); }
.score-side {
  max-width: 340px;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
}
.score-side-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--text-secondary);
}
.score-tip {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 8px 0 0;
}
.radar-chart { height: 300px; }
.advice-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.advice-list li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 14px;
  color: var(--text-title);
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}
.advice-list li:last-child { border-bottom: none; }
.advice-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary);
  margin-top: 6px;
}
.assumption-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.assumption-list li {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.7;
  padding: 4px 0;
}
.muted {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 8px 0 0;
}
.dims {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  margin-top: 12px;
}
.dim-card {
  border: 1px solid var(--paper-edge);
  border-left-width: 3px;
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  background: var(--paper-card);
  box-shadow: var(--paper-shadow);
  transition: box-shadow 0.25s ease, transform 0.25s ease;
}
.dim-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--paper-shadow-lg);
}
.dim-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.dim-name {
  font-size: 14px;
  font-weight: 600;
  font-family: var(--font-serif);
  color: var(--text-title);
}
.dim-score {
  font-size: 22px;
  font-weight: 700;
  font-family: var(--font-serif);
}
.dim-bar {
  height: 6px;
  border-radius: 999px;
  background: var(--bg-track);
  margin: 10px 0;
  overflow: hidden;
}
.dim-bar-fill { height: 100%; border-radius: 999px; transition: width 0.5s ease; }
.dim-issues {
  font-size: 12px;
  color: var(--warning);
  margin: 6px 0 4px;
  line-height: 1.6;
}
.dim-advice {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
}
.dim-advice li {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
}
</style>
