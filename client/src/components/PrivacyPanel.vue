<template>
  <div class="report-panel">
    <!-- 错误提示 -->
    <div v-if="error" class="error-banner" style="margin-bottom: 16px;">
      {{ error }}
      <button class="btn btn-sm btn-outline" @click="loadAll()" style="margin-left: 12px;">重试</button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="empty-state">
      <p>加载中...</p>
    </div>

    <template v-if="!loading">
      <div class="report-grid">
        <!-- 同意授权 -->
        <div class="report-card">
          <h3>授权管理</h3>
          <div v-for="c in consentDefs" :key="c.type" class="consent-row">
            <div class="consent-info">
              <div class="consent-title">{{ c.title }}</div>
              <p class="consent-desc">{{ c.desc }}</p>
            </div>
            <label class="switch">
              <input type="checkbox" :checked="consentMap[c.type]" @change="toggleConsent(c.type, $event)" />
              <span class="slider"></span>
            </label>
          </div>
          <p class="consent-note">授权记录均保存在你的账号下，可随时撤销。</p>
        </div>

        <!-- 数据概览 -->
        <div class="report-card">
          <h3>我的数据</h3>
          <div class="data-box">
            <div class="data-row">
              <span>账号</span>
              <b>{{ dataSummary.user ? (dataSummary.user.email || '—') : '—' }}</b>
            </div>
            <div class="data-row">
              <span>昵称</span>
              <b>{{ dataSummary.user ? (dataSummary.user.nickname || '未设置') : '—' }}</b>
            </div>
            <div class="data-row">
              <span>注册时间</span>
              <b>{{ dataSummary.user ? fmtDate(dataSummary.user.created_at) : '—' }}</b>
            </div>
            <div class="data-row">
              <span>记账笔数</span>
              <b class="num">{{ dataSummary.statistics ? dataSummary.statistics.transaction_count : 0 }}</b>
            </div>
            <div class="data-row">
              <span>授权记录</span>
              <b class="num">{{ dataSummary.statistics ? dataSummary.statistics.consent_count : 0 }}</b>
            </div>
          </div>
          <p class="consent-note">{{ dataSummary.note || '' }}</p>
        </div>
      </div>

      <!-- 危险操作 -->
      <div class="report-card" style="margin-top: 20px; border-color: rgba(229, 72, 77, 0.35);">
        <h3 style="color: var(--danger);">危险操作</h3>
        <div class="danger-row">
          <div class="danger-info">
            <div class="danger-title">注销账号</div>
            <p class="danger-desc">永久删除你的账号、记账记录、报表、目标、投资、订阅、保单等全部数据，且不可恢复。</p>
          </div>
          <button class="btn btn-outline" style="color: var(--danger); border-color: rgba(229, 72, 77, 0.4);" :disabled="deleting" @click="deleteAccount">
            {{ deleting ? '注销中...' : '注销账号' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'
import { api } from '../utils/api.js'

const store = useAppStore()
const router = useRouter()

const consentDefs = [
  {
    type: 'privacy_policy',
    title: '隐私政策同意',
    desc: '同意《用户隐私政策》，用于账号正常运营所必需的数据处理。'
  },
  {
    type: 'data_analysis',
    title: '数据分析授权',
    desc: '允许我们对脱敏后的数据进行分析，用于生成更准确的财务建议。'
  }
]

const loading = ref(true)
const error = ref('')
const consents = ref([])
const dataSummary = ref({ user: null, statistics: null, note: '' })
const deleting = ref(false)

const consentMap = ref({})

function fmtDate(d) {
  if (!d) return '—'
  return String(d).slice(0, 10)
}

onMounted(async () => {
  if (!store.token) { router.push('/login'); return }
  await loadAll()
})

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const [resConsents, resData] = await Promise.all([api.getConsents(), api.getPrivacyData()])
    if (resConsents && resConsents.success === false && resConsents.error === '登录已过期') {
      store.logout(); router.push('/login'); return
    }
    if (resConsents && resConsents.success) {
      consents.value = resConsents.data || []
      const map = {}
      for (const c of consents.value) map[c.consent_type] = !!c.granted
      consentMap.value = map
    }
    if (resData && resData.success) {
      dataSummary.value = resData.data || {}
    } else {
      error.value = (resData && resData.error) || '数据概览加载失败'
    }
  } catch (e) {
    error.value = '网络错误，请检查连接后重试'
  } finally {
    loading.value = false
  }
}

async function toggleConsent(type, event) {
  const granted = event.target.checked
  const current = consents.value.find(c => c.consent_type === type)
  try {
    const res = await api.upsertConsent({
      consent_type: type,
      version: (current && current.version) || 'v1',
      granted
    })
    if (res && res.success === false) {
      consentMap.value[type] = !granted
      error.value = res.error || '保存失败'
      return
    }
    consentMap.value[type] = granted
    await loadAll()
  } catch (e) {
    consentMap.value[type] = !granted
    error.value = '网络错误，保存失败'
  }
}

async function deleteAccount() {
  if (!window.confirm('此操作不可恢复！确定要注销账号并删除全部数据吗？')) return
  if (!window.confirm('再次确认：删除后将无法找回任何数据，确定继续？')) return
  deleting.value = true
  error.value = ''
  try {
    const res = await api.deleteAccount()
    if (res && res.success === false) {
      error.value = res.error || '注销失败'
      return
    }
    store.logout()
    router.push('/login')
  } catch (e) {
    error.value = '网络错误，注销失败'
  } finally {
    deleting.value = false
  }
}
</script>

<style scoped>
.consent-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.consent-row:last-child { border-bottom: none; }
.consent-title { font-size: 14px; font-weight: 600; color: var(--text-title); }
.consent-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 4px 0 0;
}
.consent-note {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 14px;
}
.switch {
  position: relative;
  flex: 0 0 auto;
  width: 42px;
  height: 24px;
  margin-top: 2px;
}
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute;
  inset: 0;
  background: var(--bg-track);
  border-radius: 999px;
  transition: background 0.25s ease;
  cursor: pointer;
}
.slider::before {
  content: '';
  position: absolute;
  width: 18px;
  height: 18px;
  left: 3px;
  top: 3px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(6, 27, 49, 0.25);
  transition: transform 0.25s ease;
}
.switch input:checked + .slider { background: var(--primary); }
.switch input:checked + .slider::before { transform: translateX(18px); }
.data-box { margin-top: 4px; }
.data-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: var(--text-secondary);
  padding: 9px 0;
  border-bottom: 1px dashed var(--border);
}
.data-row:last-child { border-bottom: none; }
.data-row b { color: var(--text-title); font-weight: 600; }
.danger-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.danger-info { flex: 1; min-width: 240px; }
.danger-title { font-size: 14px; font-weight: 600; color: var(--text-title); }
.danger-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 4px 0 0;
}
</style>
