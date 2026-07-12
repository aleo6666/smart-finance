<template>
  <!-- 悬浮反馈按钮 -->
  <div class="fab-wrapper">
    <button class="fab" @click="showFeedback = true" title="意见反馈">
      💬
    </button>

    <!-- 反馈提交弹窗 -->
    <div class="modal-overlay" v-if="showFeedback" @click.self="showFeedback = false">
      <div class="modal" style="max-width: 460px;">
        <h2>💬 意见反馈</h2>
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">
          告诉我们你的想法，帮助我们做得更好！
        </p>

        <!-- 反馈类型选择 -->
        <div class="feedback-types">
          <label v-for="opt in types" :key="opt.value"
            class="fb-type-btn" :class="{ active: form.type === opt.value }">
            <input type="radio" v-model="form.type" :value="opt.value" style="display:none" />
            <span class="fb-icon">{{ opt.icon }}</span>
            {{ opt.label }}
          </label>
        </div>

        <div class="form-group">
          <label>详细描述</label>
          <textarea v-model="form.content" rows="4"
            placeholder="请描述你的问题或建议..."
            style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;resize:vertical;font-family:inherit;outline:none;"
          ></textarea>
        </div>

        <!-- 截图上传 -->
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

        <!-- 社群入口 -->
        <div class="community-links">
          <span style="font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:4px;">
            💡 加入用户社群：<a href="#" @click.prevent>微信群</a> | <a href="#" @click.prevent>QQ群</a>
          </span>
        </div>

        <div class="modal-actions">
          <button class="btn btn-outline" @click="showFeedback = false">取消</button>
          <button class="btn btn-primary" @click="submitFeedback" :disabled="!form.content.trim() || submitting">
            {{ submitting ? '提交中...' : '提交反馈' }}
          </button>
        </div>

        <!-- 提交成功 -->
        <div v-if="submitResult" class="submit-result" :class="submitResult.success ? 'success' : 'error'">
          {{ submitResult.message }}
        </div>
      </div>
    </div>

    <!-- 7日满意度调研弹窗 -->
    <div class="modal-overlay" v-if="showSurvey" @click.self="showSurvey = false">
      <div class="modal survey-modal">
        <h2>🌟 满意度调研</h2>
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">
          你已经使用智能记账助手一段时间了，请给我们打个分吧！
        </p>

        <div class="star-rating">
          <span v-for="i in 5" :key="i"
            class="star" :class="{ active: surveyRating >= i }"
            @click="surveyRating = i"
          >⭐</span>
        </div>
        <p style="text-align:center;font-size:13px;color:var(--text-secondary);margin:8px 0 14px;">
          {{ ratingLabels[surveyRating - 1] || '请打分' }}
        </p>

        <div class="form-group">
          <textarea v-model="surveyComment" rows="2"
            placeholder="有什么想说的？（选填）"
            style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:13px;resize:vertical;font-family:inherit;outline:none;"
          ></textarea>
        </div>

        <div class="modal-actions">
          <button class="btn btn-outline" @click="skipSurvey">稍后再说</button>
          <button class="btn btn-primary" @click="submitSurvey" :disabled="surveyRating === 0">
            提交评价
          </button>
        </div>
      </div>
    </div>

    <!-- 反馈追踪浮动入口 -->
    <button class="fab-track" v-if="feedbackList.length > 0" @click="showTrack = !showTrack" title="我的反馈">
      📋
    </button>

    <!-- 反馈追踪面板 -->
    <div class="track-panel" v-if="showTrack" @click.stop>
      <div class="reminder-panel-header">
        <h4>📋 我的反馈</h4>
        <button class="btn btn-outline btn-sm" @click="showTrack = false">关闭</button>
      </div>
      <div v-for="fb in feedbackList" :key="fb.id" class="track-item">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="fb-badge" :class="fb.type">{{ typeLabels[fb.type] || fb.type }}</span>
          <span class="fb-status" :class="fb.status">{{ statusLabels[fb.status] || fb.status }}</span>
        </div>
        <div class="track-content">{{ fb.content.slice(0, 80) }}{{ fb.content.length > 80 ? '...' : '' }}</div>
        <div v-if="fb.admin_reply" class="track-reply">💬 回复：{{ fb.admin_reply }}</div>
        <div class="track-time">{{ fb.created_at }}</div>
      </div>
      <div v-if="feedbackList.length === 0" style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px;">
        暂无反馈记录
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { api } from '../utils/api.js'

const showFeedback = ref(false)
const showSurvey = ref(false)
const showTrack = ref(false)
const submitting = ref(false)
const submitResult = ref(null)
const screenshotPreview = ref(null)
const screenshotFile = ref(null)
const screenshotInput = ref(null)
const feedbackList = ref([])

const form = ref({ type: 'suggestion', content: '' })
const surveyRating = ref(0)
const surveyComment = ref('')

const types = [
  { value: 'suggestion', label: '功能建议', icon: '💡' },
  { value: 'bug', label: 'Bug报告', icon: '🐛' },
  { value: 'ux', label: '体验问题', icon: '😕' },
  { value: 'other', label: '其他', icon: '💬' }
]

const typeLabels = { suggestion: '建议', bug: 'Bug', ux: '体验', survey: '调研', other: '其他' }
const statusLabels = { pending: '待处理', processing: '处理中', resolved: '已解决' }
const ratingLabels = ['很失望 😞', '有点不足 😕', '一般般 😐', '还不错 👍', '非常棒 🤩']

onMounted(async () => {
  // 加载历史反馈
  try {
    const res = await api.getFeedback()
    feedbackList.value = res.data || []
  } catch {}

  // 检查7日调研
  try {
    const survey = await api.checkSurvey()
    if (survey.data?.showSurvey) {
      setTimeout(() => { showSurvey.value = true }, 3000) // 3秒后弹出
    }
  } catch {}
})

function triggerScreenshot() {
  screenshotInput.value?.click()
}

function onScreenshotChange(e) {
  const file = e.target.files[0]
  if (!file) return
  screenshotFile.value = file
  const reader = new FileReader()
  reader.onload = (ev) => { screenshotPreview.value = ev.target.result }
  reader.readAsDataURL(file)
  e.target.value = ''
}

function removeScreenshot() {
  screenshotPreview.value = null
  screenshotFile.value = null
}

async function submitFeedback() {
  if (!form.value.content.trim()) return
  submitting.value = true
  submitResult.value = null

  try {
    const fd = new FormData()
    fd.append('type', form.value.type)
    fd.append('content', form.value.content)
    if (screenshotFile.value) {
      fd.append('screenshot', screenshotFile.value)
    }

    const res = await api.submitFeedback(fd)
    submitResult.value = { success: true, message: res.message || '反馈已提交！' }
    feedbackList.value.unshift(res.data)

    // 2秒后关闭
    setTimeout(() => {
      showFeedback.value = false
      submitResult.value = null
      form.value.content = ''
      removeScreenshot()
    }, 2000)
  } catch {
    submitResult.value = { success: false, message: '提交失败，请重试' }
  } finally {
    submitting.value = false
  }
}

async function submitSurvey() {
  if (surveyRating.value === 0) return
  await api.submitSurvey(surveyRating.value, surveyComment.value)
  showSurvey.value = false
}

function skipSurvey() {
  showSurvey.value = false
}
</script>

<style scoped>
.fab-wrapper {
  position: fixed;
  bottom: 100px;
  right: 20px;
  z-index: 180;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.fab {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: var(--primary);
  color: white;
  border: none;
  font-size: 22px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(79,70,229,0.35);
  transition: transform 0.2s;
}
.fab:hover { transform: scale(1.08); }

.fab-track {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: white;
  border: 1px solid var(--border);
  font-size: 18px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  transition: transform 0.2s;
}
.fab-track:hover { transform: scale(1.06); }

.feedback-types {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.fb-type-btn {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 20px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 4px;
}
.fb-type-btn.active {
  background: #eef2ff;
  border-color: var(--primary-light);
  color: var(--primary);
  font-weight: 600;
}
.fb-icon { font-size: 14px; }

.screenshot-area {
  border: 2px dashed var(--border);
  border-radius: 8px;
  padding: 20px;
  text-align: center;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  transition: border-color 0.2s;
}
.screenshot-area:hover { border-color: var(--primary-light); }

.screenshot-preview {
  position: relative;
  display: inline-block;
}
.screenshot-preview img {
  max-height: 120px;
  border-radius: 8px;
  border: 1px solid var(--border);
}
.btn-remove {
  position: absolute;
  top: -8px;
  right: -8px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--danger);
  color: white;
  border: none;
  font-size: 12px;
  cursor: pointer;
}

.community-links { margin-bottom: 8px; }
.community-links a { color: var(--primary); text-decoration: none; }

.submit-result {
  margin-top: 12px;
  padding: 10px;
  border-radius: 8px;
  font-size: 13px;
  text-align: center;
}
.submit-result.success { background: #ecfdf5; color: var(--success); }
.submit-result.error { background: #fef2f2; color: var(--danger); }

.star-rating {
  display: flex;
  justify-content: center;
  gap: 8px;
  font-size: 32px;
}
.star {
  cursor: pointer;
  filter: grayscale(1);
  opacity: 0.4;
  transition: all 0.2s;
}
.star.active, .star:hover {
  filter: none;
  opacity: 1;
  transform: scale(1.12);
}

.track-panel {
  position: fixed;
  bottom: 156px;
  right: 20px;
  width: 380px;
  max-height: 420px;
  overflow-y: auto;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 10px 40px rgba(0,0,0,0.15);
  z-index: 190;
}
.track-item {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.track-content { font-size: 13px; color: var(--text); margin: 6px 0; }
.track-reply {
  font-size: 12px;
  color: var(--success);
  background: #f0fdf4;
  padding: 6px 8px;
  border-radius: 6px;
  margin: 4px 0;
}
.track-time { font-size: 10px; color: #94a3b8; }

.fb-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 600;
}
.fb-badge.bug { background: #fef2f2; color: #dc2626; }
.fb-badge.suggestion { background: #eef2ff; color: #4f46e5; }
.fb-badge.ux { background: #fffbeb; color: #d97706; }
.fb-badge.other { background: #f1f5f9; color: #64748b; }

.fb-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
}
.fb-status.pending { background: #fff7ed; color: #ea580c; }
.fb-status.processing { background: #eff6ff; color: #2563eb; }
.fb-status.resolved { background: #f0fdf4; color: #16a34a; }

.survey-modal {
  text-align: center;
}
</style>
