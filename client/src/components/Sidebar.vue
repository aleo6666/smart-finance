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
    </nav>

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
