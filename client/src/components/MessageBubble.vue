<template>
  <div class="message" :class="msg.role">
    <div class="avatar">{{ msg.role === 'user' ? '😊' : '🤖' }}</div>
    <div class="message-body">
      <div class="bubble" v-html="renderedContent"></div>

      <!-- 证据链（分析类回复携带 evidence 时渲染；解析失败自动降级为纯文本气泡） -->
      <div v-if="evidencePoints.length" class="evidence-chain">
        <div v-for="(p, i) in evidencePoints" :key="i" class="evidence-card">
          <div class="evidence-head">
            <div class="evidence-text">{{ p.text }}</div>
            <button v-if="p.records.length" class="evidence-toggle" @click="togglePoint(i)">
              {{ expanded[i] ? '收起明细' : `查看明细 (${p.records.length})` }}
            </button>
          </div>
          <div v-if="expanded[i] && p.records.length" class="evidence-records">
            <div v-for="(r, j) in p.records" :key="r.id ?? j" class="evidence-record" @click="activeRecord = r">
              <span class="er-main">
                <span class="er-cat">{{ r.category || '未分类' }}</span>
                <span v-if="r.note" class="er-note">{{ r.note }}</span>
              </span>
              <span class="er-meta">
                <span class="er-date">{{ r.date }}</span>
                <span class="er-amount">¥{{ fmtAmount(r.amount) }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="time">{{ formatTime(msg.time) }}</div>
    </div>

    <!-- 账单明细弹层 -->
    <div v-if="activeRecord" class="modal-overlay" @click.self="activeRecord = null">
      <div class="modal evidence-modal">
        <h2>🧾 账单明细</h2>
        <div class="detail-row"><span class="dk">日期</span><span class="dv">{{ activeRecord.date || '-' }}</span></div>
        <div class="detail-row"><span class="dk">分类</span><span class="dv">{{ activeRecord.category || '未分类' }}</span></div>
        <div class="detail-row"><span class="dk">金额</span><span class="dv er-amount">¥{{ fmtAmount(activeRecord.amount) }}</span></div>
        <div class="detail-row" v-if="activeRecord.note"><span class="dk">备注</span><span class="dv">{{ activeRecord.note }}</span></div>
        <div class="modal-actions">
          <button class="btn btn-primary" @click="activeRecord = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  msg: { type: Object, required: true }
})

const expanded = ref({})
const activeRecord = ref(null)

const renderedContent = computed(() => {
  return props.msg.content.replace(/\n/g, '<br>')
})

// 解析证据链：兼容对象 / JSON 字符串两种形态；任何解析失败都返回空数组（降级为纯文本）
const evidencePoints = computed(() => {
  let ev = props.msg.evidence
  if (!ev) return []
  if (typeof ev === 'string') {
    try { ev = JSON.parse(ev) } catch { return [] }
  }
  if (!ev || !Array.isArray(ev.points)) return []
  return ev.points
    .filter(p => p && typeof p.text === 'string' && p.text.trim())
    .map(p => ({
      text: p.text,
      records: Array.isArray(p.records) ? p.records.filter(r => r && typeof r === 'object') : []
    }))
})

function togglePoint(i) {
  expanded.value[i] = !expanded.value[i]
}

function fmtAmount(n) {
  const v = Number(n)
  return Number.isFinite(v) ? v.toFixed(2) : '0.00'
}

function formatTime(date) {
  if (!date) return ''
  const d = new Date(date)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>

<style scoped>
.message-body {
  min-width: 0;
}

/* 证据链卡片：白底 + 浅边框 + 紫色链接，与气泡风格一致 */
.evidence-chain {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  max-width: 520px;
}
.evidence-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  box-shadow: var(--shadow-sm);
}
.evidence-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.evidence-text {
  flex: 1;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-title);
}
.evidence-toggle {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 2px 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--primary);
  cursor: pointer;
  transition: color 0.15s ease;
}
.evidence-toggle:hover {
  color: var(--primary-hover);
  text-decoration: underline;
}
.evidence-records {
  margin-top: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}
.evidence-record {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s ease;
}
.evidence-record:hover {
  background: var(--bg-subtle);
}
.er-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.er-cat {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-title);
  flex-shrink: 0;
}
.er-note {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.er-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.er-date {
  font-size: 12px;
  color: var(--text-secondary);
}
.er-amount {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-title);
  font-variant-numeric: tabular-nums;
}

/* 明细弹层 */
.evidence-modal {
  max-width: 380px;
}
.evidence-modal .detail-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 0;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
}
.evidence-modal .detail-row:last-of-type {
  border-bottom: none;
}
.evidence-modal .dk {
  color: var(--text-secondary);
  flex-shrink: 0;
}
.evidence-modal .dv {
  color: var(--text-title);
  text-align: right;
  word-break: break-word;
}
</style>
