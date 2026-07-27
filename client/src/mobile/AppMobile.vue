<template>
  <!-- 登录页：独立全屏，不带移动端外壳 -->
  <router-view v-if="isLoginPage" />

  <div v-else class="m-app">
    <!-- 顶部栏 -->
    <header class="m-topbar">
      <span class="m-title">{{ pageTitle }}</span>
      <div class="m-actions">
        <select
          v-if="store.isLoggedIn && store.ledgers.length"
          class="m-ledger"
          :value="store.selectedLedgerId"
          @change="store.selectLedger(+$event.target.value)"
        >
          <option v-for="l in store.ledgers" :key="l.id" :value="l.id">
            {{ l.icon || '📒' }} {{ l.name }}
          </option>
        </select>
        <button class="m-bell" @click="store.toggleReminderPanel()" aria-label="消息提醒">
          <span style="font-size:20px">🔔</span>
          <span v-if="store.reminderCount > 0" class="m-badge">
            {{ store.reminderCount > 99 ? '99+' : store.reminderCount }}
          </span>
        </button>
        <button class="m-more" @click="showMore = !showMore" aria-label="更多">⋯</button>
      </div>
    </header>

    <!-- 内容区 -->
    <main class="m-content">
      <router-view />
    </main>

    <!-- 底部 Tab 栏 -->
    <nav class="m-tabbar">
      <router-link to="/" class="m-tab">
        <span class="m-tab-icon">💬</span><span class="m-tab-label">记账</span>
      </router-link>
      <router-link to="/reports" class="m-tab">
        <span class="m-tab-icon">📊</span><span class="m-tab-label">分析</span>
      </router-link>
      <router-link to="/goals" class="m-tab">
        <span class="m-tab-icon">🎯</span><span class="m-tab-label">目标</span>
      </router-link>
      <router-link to="/exchange" class="m-tab">
        <span class="m-tab-icon">🌍</span><span class="m-tab-label">汇率</span>
      </router-link>
      <router-link to="/import" class="m-tab">
        <span class="m-tab-icon">📥</span><span class="m-tab-label">导入</span>
      </router-link>
    </nav>

    <!-- 更多：意见反馈 / 退出登录 -->
    <transition name="sheet">
      <div v-if="showMore" class="m-mask" @click="showMore = false">
        <div class="m-sheet" @click.stop>
          <button class="m-sheet-item" @click="openFeedback">💡 意见反馈</button>
          <button v-if="store.isLoggedIn" class="m-sheet-item danger" @click="handleLogout">⏻ 退出登录</button>
          <button class="m-sheet-item" @click="showMore = false">取消</button>
        </div>
      </div>
    </transition>

    <!-- 消息提醒面板 -->
    <transition name="sheet">
      <div v-if="store.showReminderPanel" class="m-mask" @click="store.showReminderPanel = false">
        <div class="m-sheet m-reminder-sheet" @click.stop>
          <div class="m-reminder-header">
            <h4>📬 消息提醒</h4>
            <button class="btn btn-outline btn-sm" @click="store.markAllRead()" v-if="store.reminders.length">全部已读</button>
          </div>
          <div v-if="!store.reminders.length" class="m-reminder-empty">暂无新提醒 ✨</div>
          <div v-for="r in store.reminders" :key="r.id" class="reminder-item" :class="[r.type, r.display?.accent]">
            <div class="reminder-item-main">
              <div class="reminder-title-row">
                <span class="reminder-title">{{ r.display?.summary || r.title }}</span>
                <span class="reminder-level">{{ r.display?.levelText || '提醒' }}</span>
              </div>
              <div class="reminder-msg">{{ r.display?.detail || r.message }}</div>
              <div class="reminder-time">{{ r.created_at }}</div>
            </div>
            <button class="reminder-read-btn" @click.stop="store.markReminderRead(r.id)">已读</button>
          </div>
        </div>
      </div>
    </transition>

    <FeedbackModal :show="showFeedback" @close="showFeedback = false" />
  </div>
</template>

<script setup>
import { computed, onMounted, watch, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'
import FeedbackModal from '../components/FeedbackModal.vue'

const store = useAppStore()
const route = useRoute()
const router = useRouter()

const isLoginPage = computed(() => route.name === 'login')
const showFeedback = ref(false)
const showMore = ref(false)

const pageTitle = computed(() => {
  const titles = { chat: '智能记账', reports: '消费分析', goals: '目标规划', exchange: '汇率看板', import: '账单导入' }
  return titles[route.name] || '智能记账'
})

function handleLogout() {
  store.logout()
  showMore.value = false
  router.push('/login')
}

function openFeedback() {
  showMore.value = false
  showFeedback.value = true
}

watch(() => route.name, (name) => {
  if (name !== 'login' && !store.token) {
    router.push('/login')
  }
}, { immediate: true })

onMounted(async () => {
  if (store.token) {
    await store.loadUser()
    store.refreshToday()
    store.refreshMonthly()
    store.refreshReminders()
  }
})
</script>
