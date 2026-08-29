<template>
  <div class="chat-container">
    <div class="chat-messages" ref="messagesEl">
      <div v-if="store.messages.length === 0 && !ocrPending" class="empty-state">
        <!-- 剪纸窗花点缀（纯装饰） -->
        <svg class="empty-ornament" viewBox="0 0 120 44" aria-hidden="true">
          <g fill="#C4402B" opacity="0.85">
            <path d="M60 6 C63 12 63 16 60 21 C57 16 57 12 60 6 Z"/>
            <path d="M60 6 C63 12 63 16 60 21 C57 16 57 12 60 6 Z" transform="rotate(60 60 22)"/>
            <path d="M60 6 C63 12 63 16 60 21 C57 16 57 12 60 6 Z" transform="rotate(120 60 22)"/>
            <path d="M60 6 C63 12 63 16 60 21 C57 16 57 12 60 6 Z" transform="rotate(180 60 22)"/>
            <path d="M60 6 C63 12 63 16 60 21 C57 16 57 12 60 6 Z" transform="rotate(240 60 22)"/>
            <path d="M60 6 C63 12 63 16 60 21 C57 16 57 12 60 6 Z" transform="rotate(300 60 22)"/>
          </g>
          <circle cx="60" cy="22" r="4" fill="#C9A227"/>
          <circle cx="22" cy="22" r="8" fill="none" stroke="#C9A227" stroke-width="2.5"/>
          <rect x="19" y="19" width="6" height="6" fill="none" stroke="#C9A227" stroke-width="2"/>
          <circle cx="98" cy="22" r="8" fill="none" stroke="#C9A227" stroke-width="2.5"/>
          <rect x="95" y="19" width="6" height="6" fill="none" stroke="#C9A227" stroke-width="2"/>
        </svg>
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

      <!-- 记账人工确认卡片：按钮触发（confirm_action 显式参数），不依赖文本识别 -->
      <div v-if="showConfirmCard" class="message assistant">
        <div class="avatar">🤖</div>
        <div class="confirm-card">
          <div class="confirm-title">✋ 请确认这笔记账</div>
          <div class="confirm-actions">
            <button class="btn btn-primary btn-sm" @click="confirmRecord(true)" :disabled="store.loading">
              ✓ 确认记账
            </button>
            <button class="btn btn-outline btn-sm" @click="confirmRecord(false)" :disabled="store.loading">
              取消
            </button>
          </div>
        </div>
      </div>

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
      <div v-if="recording || transcribing" class="voice-status" :class="{ transcribing }">
        <span v-if="recording" class="voice-dot"></span>
        {{ recording ? '录音中… 再次点击停止（最长 60 秒）' : '识别中…' }}
      </div>
      <div class="chat-input-wrapper">
        <button class="btn-mic" :class="{ recording }" @click="toggleRecording()"
          :disabled="store.loading || transcribing"
          :title="recording ? '停止录音' : '语音输入'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        </button>
        <textarea v-model="input" @keydown.enter.exact.prevent="send()"
          placeholder="输入消费记录或问题，如：今天午餐花了25元..."
          rows="1" ref="inputEl" :disabled="store.loading"></textarea>
        <button class="btn-upload" @click="triggerUpload()" :disabled="store.loading" title="拍照识别购物小票">📷</button>
        <input type="file" ref="fileInput" accept="image/*" capture="environment" style="display:none" @change="onFileChange" />
        <button @click="send()" :disabled="!input.trim() || store.loading">↑</button>
      </div>
    </div>

    <div v-if="toastMsg" class="chat-toast">{{ toastMsg }}</div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app.js'
import MessageBubble from './MessageBubble.vue'
import { api } from '../utils/api.js'

const store = useAppStore()
const input = ref('')
const messagesEl = ref(null)
const inputEl = ref(null)
const fileInput = ref(null)

const categories = ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他']

// 记账人工确认卡片：最后一条消息是 assistant 且带 pendingConfirm 时显示
const showConfirmCard = computed(() => {
  if (store.loading || ocrPending.value) return false
  const last = store.messages[store.messages.length - 1]
  return !!(last && last.role === 'assistant' && last.pendingConfirm)
})

async function confirmRecord(confirm) {
  const text = confirm ? '确认记账' : '取消'
  await store.sendMessage(text, { confirm_action: confirm ? 'confirm' : 'cancel' })
  scrollToBottom()
}

// OCR 确认状态
const ocrPending = ref(false)
const ocrRecords = ref([])
const ocrSessionId = ref('')
const savingOcr = ref(false)

// ====== 语音记账 ======
const recording = ref(false)
const transcribing = ref(false)
const toastMsg = ref('')
let mediaRecorder = null
let mediaStream = null
let audioChunks = []
let recordTimeout = null
let toastTimer = null

function showToast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 2600)
}

async function toggleRecording() {
  if (transcribing.value) return
  if (recording.value) {
    stopRecording()
    return
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast('当前浏览器不支持录音功能')
    return
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      showToast('麦克风权限被拒绝，请在浏览器站点设置中允许麦克风后重试')
    } else {
      showToast('无法访问麦克风，请检查设备后重试')
    }
    return
  }

  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
    .find(t => MediaRecorder.isTypeSupported(t)) || ''
  audioChunks = []
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined)
  mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data)
  }
  mediaRecorder.onstop = onRecordingStop
  mediaRecorder.start()
  recording.value = true
  // 最长 60 秒自动停止
  recordTimeout = setTimeout(() => {
    if (recording.value) stopRecording()
  }, 60000)
}

function stopRecording() {
  clearTimeout(recordTimeout)
  recordTimeout = null
  recording.value = false
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  } else {
    releaseMic()
  }
}

function releaseMic() {
  mediaStream?.getTracks().forEach(t => t.stop())
  mediaStream = null
}

async function onRecordingStop() {
  const type = mediaRecorder?.mimeType || 'audio/webm'
  const blob = new Blob(audioChunks, { type })
  audioChunks = []
  mediaRecorder = null
  releaseMic()

  if (blob.size === 0) {
    showToast('录音为空，请重试')
    return
  }

  transcribing.value = true
  try {
    const ext = type.includes('ogg') ? 'ogg' : 'webm'
    const formData = new FormData()
    formData.append('audio', blob, `voice.${ext}`)
    const res = await api.transcribeAudio(formData)
    if (res && res.success && res.data && res.data.text) {
      const text = String(res.data.text).trim()
      input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text
      inputEl.value?.focus()
    } else {
      showToast('语音识别失败，请重试')
    }
  } catch (e) {
    showToast('语音识别失败，请重试')
  } finally {
    transcribing.value = false
  }
}

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

onUnmounted(() => {
  clearTimeout(recordTimeout)
  clearTimeout(toastTimer)
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = null
    mediaRecorder.stop()
  }
  releaseMic()
})
</script>

<style scoped>
/* 空状态剪纸点缀 */
.empty-ornament {
  width: 120px;
  height: 44px;
  margin: 0 auto 4px;
  display: block;
}

/* 语音输入按钮（纸片质感） */
.btn-mic {
  width: 40px;
  height: 40px;
  border-radius: var(--radius);
  border: 1px solid var(--paper-edge);
  background: var(--paper-card);
  box-shadow: var(--paper-shadow);
  color: var(--text);
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.18s ease;
}
.btn-mic svg {
  width: 18px;
  height: 18px;
  display: block;
}
.btn-mic:hover:not(:disabled):not(.recording) {
  background: var(--primary-soft);
  border-color: var(--primary-light);
  color: var(--primary);
  transform: translateY(-1px);
  box-shadow: var(--paper-shadow-lg);
}
.btn-mic:active:not(:disabled):not(.recording) {
  transform: translateY(0);
  box-shadow: var(--paper-shadow);
}
.btn-mic:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-mic.recording {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
  animation: mic-breathe 1.4s ease-in-out infinite;
}
@keyframes mic-breathe {
  0%, 100% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.45); }
  50% { box-shadow: 0 0 0 9px rgba(229, 72, 77, 0); }
}

/* 录音 / 识别状态条 */
.voice-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--danger);
  margin-bottom: 8px;
  animation: fadeIn 0.2s ease;
}
.voice-status.transcribing {
  color: var(--text-secondary);
}
.voice-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
  animation: dot-pulse 1s ease-in-out infinite;
}
@keyframes dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* 轻提示 toast */
.chat-toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  background: var(--text-title);
  color: #fff;
  font-size: 13px;
  padding: 9px 18px;
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  z-index: 300;
  animation: fadeIn 0.2s ease;
  max-width: 86vw;
  text-align: center;
}

/* 记账人工确认卡片：白纸片 + 叠层投影（与 OCR 确认卡同风格） */
.confirm-card {
  background: var(--paper-card);
  border: 1px solid var(--paper-edge);
  border-radius: 12px;
  padding: 12px 16px;
  margin-top: 4px;
  max-width: 520px;
  box-shadow: var(--paper-shadow);
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.confirm-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.confirm-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
.confirm-actions .btn {
  min-width: 88px;
}

/* OCR 确认卡片：白纸片 + 叠层投影 */
.ocr-confirm-card {
  background: var(--paper-card);
  border: 1px solid var(--paper-edge);
  border-radius: 12px;
  padding: 16px;
  margin-top: 4px;
  max-width: 520px;
  box-shadow: var(--paper-shadow);
}
.ocr-header {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text);
}
.ocr-item {
  position: relative;
  background: #fdfaf6;
  border: 1px solid var(--paper-edge);
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
  border: 1px solid var(--paper-edge);
  border-radius: 5px;
  font-size: 13px;
  outline: none;
  background: var(--paper-card);
  box-shadow: inset 0 1px 2px rgba(61, 47, 20, 0.06);
}
.ocr-row input:focus, .ocr-row select:focus {
  border-color: var(--brand-purple);
  box-shadow: inset 0 1px 2px rgba(61, 47, 20, 0.06), var(--ring);
}
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
