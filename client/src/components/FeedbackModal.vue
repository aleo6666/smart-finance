<template>
  <div v-if="show" class="modal-overlay" @click.self="$emit('close')">
    <div class="modal" style="max-width: 460px;">
      <h2>💬 意见反馈</h2>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">
        告诉我们你的想法，帮助我们做得更好！
      </p>

      <div class="feedback-types">
        <label v-for="opt in types" :key="opt.value" class="fb-type-btn" :class="{ active: form.type === opt.value }">
          <input type="radio" v-model="form.type" :value="opt.value" style="display:none" />
          <span class="fb-icon">{{ opt.icon }}</span> {{ opt.label }}
        </label>
      </div>

      <div class="form-group">
        <label>详细描述</label>
        <textarea v-model="form.content" rows="4" placeholder="请描述你的问题或建议..."
          style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;resize:vertical;font-family:inherit;outline:none;"></textarea>
      </div>

      <div class="form-group">
        <label>截图（选填）</label>
        <div class="screenshot-area" @click="triggerScreenshot" v-if="!screenshotPreview">
          <span style="font-size:28px">📸</span>
          <span style="font-size:12px;color:var(--text-secondary);margin-top:4px;">点击上传截图</span>
        </div>
        <div class="screenshot-preview" v-else>
          <img :src="screenshotPreview" />
          <button class="btn-remove" @click="removeScreenshot">✕</button>
        </div>
        <input type="file" ref="screenshotInput" accept="image/*" style="display:none" @change="onScreenshotChange" />
      </div>

      <div class="modal-actions">
        <button class="btn btn-outline" @click="$emit('close')">取消</button>
        <button class="btn btn-primary" @click="submitFeedback" :disabled="!form.content.trim() || submitting">
          {{ submitting ? '提交中...' : '提交反馈' }}
        </button>
      </div>

      <div v-if="submitResult" class="submit-result" :class="submitResult.success ? 'success' : 'error'">
        {{ submitResult.message }}
      </div>
    </div>
  </div>

  <!-- 7日调研 -->
  <div class="modal-overlay" v-if="showSurvey" @click.self="showSurvey = false">
    <div class="modal survey-modal">
      <h2>🌟 满意度调研</h2>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">你已经使用一段时间了，请给我们打个分吧！</p>
      <div class="star-rating">
        <span v-for="i in 5" :key="i" class="star" :class="{ active: surveyRating >= i }" @click="surveyRating = i">⭐</span>
      </div>
      <p style="text-align:center;font-size:13px;color:var(--text-secondary);margin:8px 0 14px;">{{ ratingLabels[surveyRating - 1] || '请打分' }}</p>
      <div class="form-group">
        <textarea v-model="surveyComment" rows="2" placeholder="有什么想说的？（选填）"
          style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:13px;resize:vertical;font-family:inherit;outline:none;"></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" @click="skipSurvey">稍后再说</button>
        <button class="btn btn-primary" @click="submitSurvey" :disabled="surveyRating === 0">提交评价</button>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({ show: { type: Boolean, default: false } })
defineEmits(['close'])

import { ref, onMounted } from 'vue'
import { api } from '../utils/api.js'

const showSurvey = ref(false)
const submitting = ref(false)
const submitResult = ref(null)
const screenshotPreview = ref(null)
const screenshotFile = ref(null)
const screenshotInput = ref(null)

const form = ref({ type: 'suggestion', content: '' })
const surveyRating = ref(0)
const surveyComment = ref('')

const types = [
  { value: 'suggestion', label: '功能建议', icon: '💡' },
  { value: 'bug', label: 'Bug报告', icon: '🐛' },
  { value: 'ux', label: '体验问题', icon: '😕' },
  { value: 'other', label: '其他', icon: '💬' }
]
const ratingLabels = ['很失望 😞', '有点不足 😕', '一般般 😐', '还不错 👍', '非常棒 🤩']

onMounted(async () => {
  try {
    const survey = await api.checkSurvey()
    if (survey.data?.showSurvey) setTimeout(() => { showSurvey.value = true }, 3000)
  } catch {}
})

function triggerScreenshot() { screenshotInput.value?.click() }
function onScreenshotChange(e) {
  const file = e.target.files[0]
  if (!file) return
  screenshotFile.value = file
  const reader = new FileReader()
  reader.onload = (ev) => { screenshotPreview.value = ev.target.result }
  reader.readAsDataURL(file)
  e.target.value = ''
}
function removeScreenshot() { screenshotPreview.value = null; screenshotFile.value = null }

async function submitFeedback() {
  if (!form.value.content.trim()) return
  submitting.value = true; submitResult.value = null
  try {
    const fd = new FormData()
    fd.append('type', form.value.type)
    fd.append('content', form.value.content)
    if (screenshotFile.value) fd.append('screenshot', screenshotFile.value)
    await api.submitFeedback(fd)
    submitResult.value = { success: true, message: '反馈已提交！感谢你的宝贵意见 🙏' }
    setTimeout(() => {
      submitResult.value = null; form.value.content = ''; removeScreenshot()
      document.querySelector('.modal-overlay')?.click() // close via overlay
    }, 1500)
  } catch {
    submitResult.value = { success: false, message: '提交失败，请重试' }
  } finally { submitting.value = false }
}

async function submitSurvey() {
  if (surveyRating.value === 0) return
  await api.submitSurvey(surveyRating.value, surveyComment.value)
  showSurvey.value = false
}
function skipSurvey() { showSurvey.value = false }
</script>

<style scoped>
.feedback-types { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
.fb-type-btn { padding:6px 12px; border:1px solid var(--border); border-radius:20px; font-size:12px; cursor:pointer; display:flex; align-items:center; gap:4px; }
.fb-type-btn.active { background:#eef2ff; border-color:var(--primary-light); color:var(--primary); font-weight:600; }
.fb-icon { font-size:14px; }
.screenshot-area { border:2px dashed var(--border); border-radius:8px; padding:20px; text-align:center; cursor:pointer; display:flex; flex-direction:column; align-items:center; }
.screenshot-area:hover { border-color:var(--primary-light); }
.screenshot-preview { position:relative; display:inline-block; }
.screenshot-preview img { max-height:120px; border-radius:8px; border:1px solid var(--border); }
.btn-remove { position:absolute; top:-8px; right:-8px; width:22px; height:22px; border-radius:50%; background:var(--danger); color:white; border:none; font-size:12px; cursor:pointer; }
.submit-result { margin-top:12px; padding:10px; border-radius:8px; font-size:13px; text-align:center; }
.submit-result.success { background:#ecfdf5; color:var(--success); }
.submit-result.error { background:#fef2f2; color:var(--danger); }
.star-rating { display:flex; justify-content:center; gap:8px; font-size:32px; }
.star { cursor:pointer; filter:grayscale(1); opacity:0.4; transition:all .2s; }
.star.active, .star:hover { filter:none; opacity:1; transform:scale(1.12); }
.survey-modal { text-align:center; }
</style>
