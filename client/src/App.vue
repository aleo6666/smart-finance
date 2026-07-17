<template>
  <aside class="sidebar" :class="{ open: store.sidebarOpen }">
    <div class="sidebar-header">
      <h1>💰 财务记账助手</h1>
      <p class="subtitle">智能记账，轻松理财</p>
    </div>

    <nav class="sidebar-nav">
      <router-link to="/" exact-active-class="active">
        <span class="icon">💬</span> 智能记账
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
    </nav>

    <div class="today-card">
      <div class="label">今日支出</div>
      <div class="amount">¥ {{ store.todayExpense.toFixed(2) }}</div>
      <div class="detail" v-if="store.monthlyStats">
        本月支出 ¥{{ store.monthlyStats.expense.toFixed(2) }}
      </div>
    </div>
  </aside>

  <div class="main-content">
    <div class="topbar">
      <button class="menu-btn" @click="store.toggleSidebar()">☰</button>
      <span class="page-title">{{ pageTitle }}</span>
      <div style="flex:1"></div>
      <div class="reminder-bell" @click="store.toggleReminderPanel()">
        <span style="font-size:20px">🔔</span>
        <span v-if="store.reminderCount > 0" class="badge">{{ store.reminderCount > 99 ? '99+' : store.reminderCount }}</span>
      </div>

      <!-- 提醒下拉面板 -->
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

  <!-- 点击遮罩关闭面板 -->
  <div v-if="store.showReminderPanel" class="panel-mask" @click="store.showReminderPanel = false"></div>

  <!-- 用户反馈闭环 -->
  <FeedbackModal />
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from './stores/app.js'
import FeedbackModal from './components/FeedbackModal.vue'

const store = useAppStore()
const route = useRoute()

const pageTitle = computed(() => {
  const titles = { chat: '智能记账', reports: '消费分析', goals: '目标规划', exchange: '汇率看板' }
  return titles[route.name] || '智能记账'
})

onMounted(() => {
  store.refreshToday()
  store.refreshMonthly()
  store.refreshReminders()
})
</script>

<style scoped>
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
</style>
