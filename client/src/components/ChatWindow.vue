<template>
  <div class="chat-container">
    <div class="chat-messages" ref="messagesEl">
      <div v-if="store.messages.length === 0 && !ocrPending" class="empty-state">
        <div class="empty-icon">💬</div>
        <p>开始记账吧！告诉我你今天花了多少钱~</p>
        <div class="quick-actions" style="justify-content: center; margin-top: 16px;">
          <span class="quick-action" @click="send('今天午餐花了25元')">🍜 午餐25元</span>
          <span class="quick-action" @click="send('打车上班花了30元')">🚕 打车30元</span>
          <span class="quick-action" @click="send('我这个月花了多少钱')">📊 本月汇总</span>
          <span class="quick-action" @click="send('帮我分析一下消费')">🔍 消费分析</span>
        </div>
      </div>

      <MessageBubble v-for="(msg, i) in store.messages" :key="i" :msg="msg" />

      <!-- OCR 确认表单 -->
      <div v-if="ocrPending" class="message assistant">
        <div class="avatar">🤖</div>
        <div class="ocr-confirm-card">
          <div class="ocr-header">📷 识别到 {{ ocrRecords.length }} 条消费记录，请确认并修改：</div>

          <div v-for="(rec, i) in ocrRecords" :key="i" class="ocr-item">
            <div class="ocr-row">
              <input v-model.number="rec.amount" type="number" step="0.01" class="ocr-amount" title="金额" />
              <select v-model="rec.category" class="ocr-cat">
                <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
              </select>
              <input v-model="rec.date" type="date" class="ocr-date" title="日期" />
            </div>
            <div class="ocr-row">
              <input v-model="rec.merchant" type="text" class="ocr-merchant" placeholder="商家（选填）" />
              <input v-model="rec.description" type="text" class="ocr-desc" placeholder="描述" />
            </div>
            <button class="btn btn-sm btn-outline ocr-del" @click="removeOcrRec(i)" title="移除">✕</button>
          </div>

          <div class="ocr-actions">
            <button class="btn btn-outline btn-sm" @click="cancelOcr()" :disabled="savingOcr">取消</button>
            <button class="btn btn-primary btn-sm" @click="confirmOcr()" :disabled="savingOcr || ocrRecords.length === 0">
              {{ savingOcr ? '保存中...' : '✓ 确认保存 (' + ocrRecords.length + '条)' }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="store.loading" class="message assistant">
        <div class="avatar">🤖</div>
        <div class="bubble" style="color: var(--text-secondary);">思考中...</div>
      </div>
    </div>

    <div class="chat-input-area">
      <div class="chat-input-wrapper">
        <textarea v-model="input" @keydown.enter.exact.prevent="send()"
          placeholder="输入消费记录或问题，如：今天午餐花了25元..."
          rows="1" ref="inputEl" :disabled="store.loading"></textarea>
        <button class="btn-upload" @click="triggerUpload()" :disabled="store.loading" title="拍照识别购物小票">📷</button>
        <input type="file" ref="fileInput" accept="image/*" capture="environment" style="display:none" @change="onFileChange" />
        <button @click="send()" :disabled="!input.trim() || store.loading">↑</button>
      </div>
      <div class="quick-actions">
        <span class="quick-action" @click="send('今天午餐花了25元')">🍜 记账</span>
        <span class="quick-action" @click="send('这个月花了多少钱')">📊 本月</span>
        <span class="quick-action" @click="send('有什么省钱建议吗')">💡 建议</span>
        <span class="quick-action" @click="send('我想存钱买一个新手机')">🎯 设目标</span>
        <span class="quick-action highlight" @click="triggerUpload()">📷 扫小票</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted } from 'vue'
import { useAppStore } from '../stores/app.js'
import MessageBubble from './MessageBubble.vue'
import { api } from '../utils/api.js'

const store = useAppStore()
const input = ref('')
const messagesEl = ref(null)
const inputEl = ref(null)
const fileInput = ref(null)

const categories = ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他']

// OCR 确认状态
const ocrPending = ref(false)
const ocrRecords = ref([])
const ocrSessionId = ref('')
const savingOcr = ref(false)

async function send(text) {
  const msg = text || input.value.trim()
  if (!msg) return
  input.value = ''
  await store.sendMessage(msg)
  scrollToBottom()
}

function triggerUpload() {
  fileInput.value?.click()
}

async function onFileChange(e) {
  const file = e.target.files[0]
  if (!file) return
  e.target.value = ''

  store.loading = true
  try {
    const res = await api.ocrImage(file)
    if (res.success && res.data.records && res.data.records.length > 0) {
      // 显示确认表单
      ocrSessionId.value = res.data.ocrSessionId || ''
      ocrRecords.value = res.data.records.map(r => ({
        ...r,
        date: r.date || new Date().toISOString().slice(0, 10)
      }))
      ocrPending.value = true
    } else {
      store.messages.push({
        role: 'assistant',
        content: res.data?.summary || '未能识别图片中的消费信息，请确认图片清晰可见或手动输入。',
        intent: 'chat',
        time: new Date()
      })
      scrollToBottom()
    }
  } catch (e) {
    store.messages.push({
      role: 'assistant',
      content: '图片上传失败，请检查网络后重试 😅',
      intent: 'chat',
      time: new Date()
    })
    scrollToBottom()
  } finally {
    store.loading = false
  }
}

function removeOcrRec(i) {
  ocrRecords.value.splice(i, 1)
  if (ocrRecords.value.length === 0) cancelOcr()
}

async function cancelOcr() {
  const sessionId = ocrSessionId.value
  ocrPending.value = false
  ocrRecords.value = []
  ocrSessionId.value = ''
  if (sessionId) {
    await api.cancelOcr(sessionId).catch(() => {})
  }
}

async function confirmOcr() {
  if (!ocrSessionId.value) {
    store.messages.push({
      role: 'assistant',
      content: '识别结果已过期，请重新上传图片。',
      intent: 'chat',
      time: new Date()
    })
    ocrPending.value = false
    ocrRecords.value = []
    scrollToBottom()
    return
  }

  savingOcr.value = true
  try {
    const records = ocrRecords.value
      .filter(rec => rec.amount && rec.category && rec.date)
      .map(rec => ({
        type: rec.type || 'expense',
        amount: rec.amount,
        category: rec.category,
        description: rec.description || rec.category,
        date: rec.date,
        merchant: rec.merchant || null
      }))

    const res = await api.confirmOcr(ocrSessionId.value, records)
    if (!res.success) throw new Error(res.error || '保存失败')

    const saved = res.data.records || []
    const total = saved.reduce((s, r) => s + Number(r.amount_cny || r.amount || 0), 0)
    store.messages.push({
      role: 'assistant',
      content: `📷 已保存 ${saved.length} 条消费记录，合计 ¥${total.toFixed(2)}`,
      intent: 'record',
      time: new Date()
    })

    store.refreshToday()
    store.refreshMonthly()
  } catch (e) {
    store.messages.push({
      role: 'assistant',
      content: e.message?.includes('过期') ? '识别结果已过期，请重新上传图片。' : '保存失败，请重试 😅',
      intent: 'chat',
      time: new Date()
    })
  } finally {
    savingOcr.value = false
    ocrPending.value = false
    ocrRecords.value = []
    ocrSessionId.value = ''
  }
  scrollToBottom()
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight
    }
  })
}

onMounted(() => {
  inputEl.value?.focus()
})
</script>

<style scoped>
/* OCR 确认卡片 */
.ocr-confirm-card {
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  margin-top: 4px;
  max-width: 520px;
}
.ocr-header {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text);
}
.ocr-item {
  position: relative;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 36px 10px 10px;
  margin-bottom: 8px;
}
.ocr-row {
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
}
.ocr-row:last-child { margin-bottom: 0; }
.ocr-row input, .ocr-row select {
  padding: 5px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 5px;
  font-size: 13px;
  outline: none;
  background: #fff;
}
.ocr-row input:focus, .ocr-row select:focus { border-color: var(--primary); }
.ocr-amount { width: 90px; }
.ocr-cat { width: 80px; }
.ocr-date { width: 130px; }
.ocr-merchant { flex: 1; min-width: 100px; }
.ocr-desc { flex: 1; min-width: 100px; }
.ocr-del {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 2px 6px !important;
  font-size: 11px !important;
  color: var(--danger);
  border-color: transparent !important;
}
.ocr-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}
</style>
