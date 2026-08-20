<template>
  <template v-if="isLoginPage">
    <router-view />
  </template>

  <template v-else>
    <aside class="sidebar" :class="{ open: store.sidebarOpen }">
      <div class="sidebar-header">
        <h1><svg class="logo-mark" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#533afd"/><polyline points="6 15 10 11 13 13.5 18 8" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="14.5 8 18 8 18 11.5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> 智能财务顾问</h1>
        <p class="subtitle">AI驱动的个人财务顾问</p>
      </div>

      <nav class="sidebar-nav">
        <router-link to="/" exact-active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span> 智能顾问
        </router-link>
        <router-link to="/reports" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg></span> 消费分析
        </router-link>
        <router-link to="/report" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span> 月度报告
        </router-link>
        <router-link to="/assets" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg></span> 资产台账
        </router-link>
        <router-link to="/goals" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg></span> 目标规划
        </router-link>
        <router-link to="/exchange" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span> 汇率看板
        </router-link>
        <router-link to="/import" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span> 账单导入
        </router-link>

        <div class="nav-group">财务健康</div>
        <router-link to="/health" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></span> 财务健康
        </router-link>
        <router-link to="/investments" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="6" x2="14" y2="14"/><line x1="22" y1="6" x2="16" y2="6"/><line x1="22" y1="6" x2="22" y2="2"/><polyline points="16 6 10 12 6 8 2 12"/></svg></span> 投资组合
        </router-link>
        <router-link to="/debts" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg></span> 债务管理
        </router-link>

        <div class="nav-group">生活规划</div>
        <router-link to="/subscriptions" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span> 订阅管家
        </router-link>
        <router-link to="/tax" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg></span> 个税测算
        </router-link>
        <router-link to="/insurance" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span> 保单管理
        </router-link>

        <div class="nav-group">家庭与设置</div>
        <router-link to="/family" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span> 家庭共享
        </router-link>
        <router-link to="/notifications" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></span> 通知中心
        </router-link>
        <router-link to="/privacy" active-class="active">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span> 隐私中心
        </router-link>

        <a class="feedback-nav" @click="showFeedback = true" href="javascript:void(0)">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span> 意见反馈
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          {{ store.user?.nickname || '用户' }}
          <button class="btn-logout" @click="handleLogout()" title="退出登录">⏻</button>
        </span>
        <button v-else class="btn btn-sm btn-outline" @click="$router.push('/login')">登录</button>

        <div class="reminder-bell" @click="store.toggleReminderPanel()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          <span v-if="store.reminderCount > 0" class="badge">{{ store.reminderCount > 99 ? '99+' : store.reminderCount }}</span>
        </div>

        <div class="reminder-panel" v-if="store.showReminderPanel" @click.stop>
          <div class="reminder-panel-header">
            <h4>消息提醒</h4>
            <button class="btn btn-outline btn-sm" @click="store.markAllRead()" v-if="store.reminders.length > 0">全部已读</button>
          </div>
          <div v-if="store.reminders.length === 0" style="padding:20px;text-align:center;color:var(--text-secondary);font-size:14px;">
            暂无新提醒
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
          <router-link class="view-all" to="/notifications">查看全部通知 →</router-link>
        </div>
      </div>
      <router-view v-slot="{ Component }">
        <transition name="page-fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </div>

    <!-- 侧边栏遮罩层（移动端） -->
    <div v-if="store.sidebarOpen" class="sidebar-mask" @click="store.toggleSidebar()"></div>
    
    <div v-if="store.showReminderPanel" class="panel-mask" @click="store.showReminderPanel = false"></div>

    <!-- 反馈弹窗 -->
    <FeedbackModal :show="showFeedback" @close="showFeedback = false" />
  </template>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
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
  const titles = {
    chat: '智能顾问', reports: '消费分析', report: '月度报告', assets: '资产台账',
    goals: '目标规划', exchange: '汇率看板', import: '账单导入',
    health: '财务健康', investments: '投资组合', debts: '债务管理',
    subscriptions: '订阅管家', tax: '个税测算', insurance: '保单管理',
    notifications: '通知中心', family: '家庭共享', privacy: '隐私中心',
    'not-found': '页面不存在'
  }
  return titles[route.name] || '智能顾问'
})

function handleLogout() {
  store.logout()
  router.push('/login')
}

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
/* 页面切换 fade 过渡 */
.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity 0.18s ease;
}
.page-fade-enter-from,
.page-fade-leave-to {
  opacity: 0;
}

.logo-mark {
  display: block;
  flex-shrink: 0;
}

.user-tag svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.reminder-bell svg {
  width: 20px;
  height: 20px;
  display: block;
}

.feedback-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  color: var(--text);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: background 0.18s ease, color 0.18s ease;
  cursor: pointer;
}
.feedback-nav:hover {
  background: var(--bg-subtle);
  color: var(--text-title);
}

.nav-group {
  margin: 14px 12px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
  text-transform: uppercase;
}

.reminder-panel .view-all {
  display: block;
  text-align: center;
  padding: 8px 0 4px;
  color: var(--primary);
  font-size: 13px;
  text-decoration: none;
  border-top: 1px solid var(--border);
  margin-top: 6px;
}
.reminder-panel .view-all:hover {
  text-decoration: underline;
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
  border-radius: 4px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
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
  border-radius: 4px;
  transition: background 0.18s ease;
}
.reminder-read-btn:hover {
  background: var(--primary-soft);
}

/* ========== 移动端顶部栏优化 ========== */
@media (max-width: 768px) {
  .topbar {
    padding: 10px 14px;
    height: 56px;
    gap: 8px;
    background: rgba(255, 255, 255, 0.9);
    backdrop-filter: saturate(180%) blur(12px);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    color: var(--text);
    border-bottom: 1px solid var(--border);
  }

  .menu-btn {
    background: var(--bg-subtle);
    color: var(--text);
    border: 1px solid var(--border);
    width: 36px;
    height: 36px;
    border-radius: var(--radius-sm);
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
  }
  .menu-btn:active {
    background: var(--primary-soft);
    transform: scale(0.96);
  }

  .page-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-title);
    letter-spacing: 0.01em;
  }

  .ledger-select {
    background: var(--bg-card);
    color: var(--text-title);
    border: 1px solid var(--border);
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ledger-select option {
    color: var(--text-title);
    background: #fff;
  }

  .user-tag {
    background: var(--bg-subtle);
    color: var(--text);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    gap: 4px;
  }
  .user-tag .btn-logout {
    color: var(--text-secondary);
    font-size: 14px;
  }

  .reminder-bell {
    position: relative;
    width: 36px;
    height: 36px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 0.2s;
    color: var(--text);
  }
  .reminder-bell:active {
    background: var(--primary-soft);
    transform: scale(0.96);
  }
  .reminder-bell .badge {
    position: absolute;
    top: -5px;
    right: -5px;
    background: var(--danger);
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
    font-size: 15px;
  }

  .ledger-select {
    display: none;
  }

  .user-tag span:not(.btn-logout) {
    display: none;
  }
}
</style>
