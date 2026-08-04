<template>
  <template v-if="isLoginPage">
    <router-view />
  </template>

  <template v-else>
    <aside class="sidebar" :class="{ open: store.sidebarOpen }">
      <div class="sidebar-header">
        <h1>💰 智能财务顾问</h1>
        <p class="subtitle">AI驱动的个人财务顾问</p>
      </div>

      <nav class="sidebar-nav">
        <router-link to="/" exact-active-class="active">
          <span class="icon">💬</span> 智能顾问
        </router-link>
        <router-link to="/reports" active-class="active">
          <span class="icon">📊</span> 消费分析
        </router-link>
        <router-link to="/goals" active-class="active">
          <span class="icon">🎯</span> 目标规划
        </router-link>
        <router-link to="/exchange" active-class="active">
          <span class="icon">🌍</span> 汇率看板
        </router-link>
        <router-link to="/import" active-class="active">
          <span class="icon">📥</span> 账单导入
        </router-link>
        <a class="feedback-nav" @click="showFeedback = true" href="javascript:void(0)">
          <span class="icon">💡</span> 意见反馈
        </a>
      </nav>

      <div class="today-card">
        <div class="label">今日支出</div>
        <div class="amount">¥ {{ store.todayExpense.toFixed(2) }}</div>
        <div class="detail" v-if="store.monthlyStats">
          本月支出 ¥{{ store.monthlyStats.expense.toFixed(2) }}
        </div>
      </div>
    </aside>

    <div v-if="store.sidebarOpen" class="sidebar-mask" @click="store.toggleSidebar()"></div>

    <div class="main-content">
      <div class="topbar">
        <button class="menu-btn" @click="store.toggleSidebar()">☰</button>
        <span class="page-title">{{ pageTitle }}</span>
        
        <div style="flex:1"></div>

        <select v-if="store.isLoggedIn && store.ledgers.length > 0" class="ledger-select"
          :value="store.selectedLedgerId" @change="store.selectLedger(+$event.target.value)">
          <option v-for="l in store.ledgers" :key="l.id" :value="l.id">{{ l.icon || '📒' }} {{ l.name }}</option>
        </select>

        <LedgerManager v-if="store.isLoggedIn" />

        <span v-if="store.isLoggedIn" class="user-tag" :title="store.user?.nickname || ''">
          👤 {{ store.user?.nickname || '用户' }}
          <button class="btn-logout" @click="handleLogout()" title="退出登录">⏻</button>
        </span>
        <button v-else class="btn btn-sm btn-outline" @click="$router.push('/login')">🔐 登录</button>

        <div class="reminder-bell" @click="store.toggleReminderPanel()">
          <span style="font-size:20px">🔔</span>
          <span v-if="store.reminderCount > 0" class="badge">{{ store.reminderCount > 99 ? '99+' : store.reminderCount }}</span>
        </div>

        <div class="reminder-panel" v-if="store.showReminderPanel" @click.stop>
          <div class="reminder-panel-header">
            <h4>📬 消息提醒</h4>
            <button class="btn btn-outline btn-sm" @click="store.markAllRead()" v-if="store.reminders.length > 0">全部已读</button>
          </div>
          <div v-if="store.reminders.length === 0" style="padding:20px;text-align:center;color:var(--text-secondary);font-size:14px;">
            暂无新提醒 ✨
          </div>
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
      <router-view />
    </div>

    <!-- 侧边栏遮罩层（移动端） -->
    <div v-if="store.sidebarOpen" class="sidebar-mask" @click="store.toggleSidebar()"></div>
    
    <div v-if="store.showReminderPanel" class="panel-mask" @click="store.showReminderPanel = false"></div>

    <!-- 反馈弹窗 -->
    <FeedbackModal :show="showFeedback" @close="showFeedback = false" />
  </template>
</template>

<script setup>
import { computed, onMounted, watch, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from './stores/app.js'
import FeedbackModal from './components/FeedbackModal.vue'
import LedgerManager from './components/LedgerManager.vue'

const store = useAppStore()
const route = useRoute()
const router = useRouter()

const isLoginPage = computed(() => route.name === 'login')
const showFeedback = ref(false)

const pageTitle = computed(() => {
  const titles = { chat: '智能顾问', reports: '消费分析', goals: '目标规划', exchange: '汇率看板', import: '账单导入' }
  return titles[route.name] || '智能顾问'
})

function handleLogout() {
  store.logout()
  router.push('/login')
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

  // 移动端默认关闭侧边栏
  if (window.innerWidth <= 768) {
    store.sidebarOpen = false
  }
})
</script>

<style scoped>
.feedback-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 10px;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 14px;
  transition: all 0.2s;
  cursor: pointer;
}
.feedback-nav:hover {
  background: rgba(79,70,229,0.06);
  color: var(--primary);
}

.reminder-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  border-left: 3px solid var(--primary);
}
.reminder-item.warning { border-left-color: var(--warning); }
.reminder-item.danger { border-left-color: var(--danger); }
.reminder-item-main { flex: 1; min-width: 0; }
.reminder-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.reminder-level {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 10px;
}
.reminder-read-btn {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
}
.reminder-read-btn:hover { text-decoration: underline; }

/* ========== 移动端顶部栏优化 ========== */
@media (max-width: 768px) {
  .topbar {
    padding: 10px 14px;
    height: 56px;
    gap: 8px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    box-shadow: 0 2px 12px rgba(102, 126, 234, 0.3);
  }

  .menu-btn {
    background: rgba(255, 255, 255, 0.2);
    color: white;
    border: none;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
  }
  .menu-btn:active {
    background: rgba(255, 255, 255, 0.3);
    transform: scale(0.95);
  }

  .page-title {
    font-size: 17px;
    font-weight: 600;
    color: white;
    letter-spacing: 0.5px;
  }

  .ledger-select {
    background: rgba(255, 255, 255, 0.2);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.3);
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 12px;
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ledger-select option {
    color: #333;
    background: white;
  }

  .user-tag {
    background: rgba(255, 255, 255, 0.2);
    color: white;
    padding: 4px 8px;
    border-radius: 20px;
    font-size: 12px;
    gap: 4px;
  }
  .user-tag .btn-logout {
    color: rgba(255, 255, 255, 0.8);
    font-size: 14px;
  }

  .reminder-bell {
    position: relative;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .reminder-bell:active {
    background: rgba(255, 255, 255, 0.3);
    transform: scale(0.95);
  }
  .reminder-bell .badge {
    position: absolute;
    top: 2px;
    right: 2px;
    background: #ff4757;
    color: white;
    font-size: 10px;
    min-width: 16px;
    height: 16px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    font-weight: 600;
  }
}

/* 小屏幕进一步优化 */
@media (max-width: 480px) {
  .topbar {
    padding: 8px 12px;
    height: 52px;
  }

  .page-title {
    font-size: 16px;
  }

  .ledger-select {
    display: none;
  }

  .user-tag span:not(.btn-logout) {
    display: none;
  }
}
</style>
