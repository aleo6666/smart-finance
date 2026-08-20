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

    <template v-if="!loading">
      <div class="report-card">
        <div class="list-header">
          <div>
            <h3>通知中心</h3>
            <p class="list-sub">{{ unreadCount }} 条未读 · 共 {{ items.length }} 条</p>
          </div>
          <button class="btn btn-outline" :disabled="unreadCount === 0" @click="markAllRead">全部已读</button>
        </div>

        <template v-if="items.length">
          <div v-for="n in items" :key="n.id" class="notif-row" :class="{ unread: !n.read }">
            <div class="notif-dot" :class="{ seen: n.read }"></div>
            <div class="notif-main">
              <div class="notif-title">
                {{ n.title || TYPE_MAP[n.type] || '通知' }}
                <span v-if="n.type" class="notif-type">{{ TYPE_MAP[n.type] || n.type }}</span>
                <span v-if="!n.read" class="notif-badge">新</span>
              </div>
              <p v-if="n.message" class="notif-msg">{{ n.message }}</p>
              <div class="notif-time">{{ fmtTime(n.created_at) }}</div>
            </div>
            <div class="notif-actions">
              <button v-if="!n.read" class="btn btn-sm btn-outline" @click="markRead(n)">标为已读</button>
              <button class="btn btn-sm btn-outline" style="color: var(--danger);" @click="removeItem(n)">删除</button>
            </div>
          </div>
        </template>
        <div v-else class="empty-state" style="padding: 60px 20px;">
          <p>暂无通知 🎉</p>
          <p style="font-size: 12px;">还款提醒、保单到期、订阅扣费等通知会出现在这里</p>
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

const TYPE_MAP = {
  reminder: '提醒',
  budget: '预算',
  goal: '目标',
  system: '系统',
  subscription: '订阅',
  insurance: '保单',
  debt: '债务'
}

const loading = ref(true)
const error = ref('')
const items = ref([])

const unreadCount = computed(() => items.value.filter(n => !n.read).length)

function fmtTime(t) {
  if (!t) return ''
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return String(t).slice(0, 16).replace('T', ' ')
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

onMounted(async () => {
  if (!store.token) { router.push('/login'); return }
  await loadData()
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const res = await api.getNotifications(100)
    if (res && res.success === false && res.error === '登录已过期') {
      store.logout(); router.push('/login'); return
    }
    if (res && res.success) {
      items.value = (res.data || []).map(n => ({ ...n, read: n.read === 1 || n.status === 'read' }))
    } else {
      error.value = (res && res.error) || '通知加载失败，请稍后重试'
    }
  } catch (e) {
    error.value = '网络错误，请检查连接后重试'
  } finally {
    loading.value = false
  }
}

async function markRead(n) {
  try {
    const res = await api.markNotificationRead(n.id)
    if (res && res.success === false) {
      error.value = res.error || '操作失败'
      return
    }
    n.read = true
    await store.refreshReminders()
  } catch (e) {
    error.value = '网络错误，操作失败'
  }
}

async function markAllRead() {
  try {
    const res = await api.markNotificationsAllRead()
    if (res && res.success === false) {
      error.value = res.error || '操作失败'
      return
    }
    items.value.forEach(n => { n.read = true })
    await store.refreshReminders()
  } catch (e) {
    error.value = '网络错误，操作失败'
  }
}

async function removeItem(n) {
  try {
    const res = await api.deleteNotification(n.id)
    if (res && res.success === false) {
      error.value = res.error || '删除失败'
      return
    }
    items.value = items.value.filter(x => x.id !== n.id)
    await store.refreshReminders()
  } catch (e) {
    error.value = '网络错误，删除失败'
  }
}
</script>

<style scoped>
.list-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}
.list-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 2px 0 0;
}
.notif-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--border);
}
.notif-row:last-child { border-bottom: none; }
.notif-row.unread { background: var(--primary-soft); margin: 0 -10px; padding: 14px 10px; border-radius: var(--radius-sm); }
.notif-dot {
  flex: 0 0 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary);
  margin-top: 6px;
}
.notif-dot.seen { background: var(--bg-track); }
.notif-main { flex: 1; min-width: 0; }
.notif-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-title);
}
.notif-type {
  display: inline-block;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  margin-left: 6px;
}
.notif-badge {
  display: inline-block;
  font-size: 11px;
  color: #fff;
  background: var(--danger);
  border-radius: 999px;
  padding: 1px 8px;
  margin-left: 6px;
}
.notif-msg {
  font-size: 13px;
  color: var(--text);
  line-height: 1.7;
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.notif-time {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 6px;
}
.notif-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
}
</style>
