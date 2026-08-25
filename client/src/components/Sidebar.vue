<template>
  <aside class="sidebar" :class="{ open: store.sidebarOpen }">
    <div class="sidebar-header">
      <h1>💰 智能财务顾问</h1>
      <p class="subtitle">AI驱动的个人财务顾问</p>
      <!-- 剪纸小纹样点缀（纯装饰） -->
      <svg class="header-ornament" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="#C9A227" stroke-width="2"/>
        <rect x="9" y="9" width="6" height="6" fill="none" stroke="#C9A227" stroke-width="2"/>
      </svg>
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
    </nav>

    <div class="paper-divider" aria-hidden="true"></div>

    <div class="today-card">
      <div class="label">今日支出</div>
      <div class="amount">¥ {{ store.todayExpense.toFixed(2) }}</div>
      <div class="detail" v-if="store.monthlyStats">
        本月支出 ¥{{ store.monthlyStats.expense.toFixed(2) }}
      </div>
    </div>
  </aside>
</template>

<script setup>
import { useAppStore } from '../stores/app.js'
import { onMounted } from 'vue'

const store = useAppStore()

onMounted(() => {
  store.refreshToday()
  store.refreshMonthly()
})
</script>

<style scoped>
/* 现代剪纸风：侧边栏整体是一张贴在纸底上的纸（主体皮肤在全局 style.css） */
.sidebar-header h1 {
  font-family: var(--font-serif);
  letter-spacing: 0.04em;
}

.header-ornament {
  position: absolute;
  top: 18px;
  right: 16px;
  width: 20px;
  height: 20px;
  opacity: 0.55;
}

/* 选中项：紫色剪纸片（与全局导航皮肤一致） */
.sidebar-nav a.active {
  background: var(--brand-purple);
  color: #fff;
  font-weight: 600;
  box-shadow: var(--paper-shadow), inset 0 0 0 1px rgba(255, 255, 255, 0.25);
}

.today-card .amount {
  font-family: var(--font-serif);
  font-weight: 700;
}
</style>
