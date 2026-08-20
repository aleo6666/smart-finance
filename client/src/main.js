import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import './style.css'

const routes = [
  { path: '/login', name: 'login', component: () => import('./components/LoginPage.vue'), meta: { public: true } },
  { path: '/', name: 'chat', component: () => import('./components/ChatWindow.vue'), meta: { requiresAuth: true } },
  { path: '/reports', name: 'reports', component: () => import('./components/ReportPanel.vue'), meta: { requiresAuth: true } },
  { path: '/report', name: 'report', component: () => import('./components/MonthlyReport.vue'), meta: { requiresAuth: true } },
  { path: '/assets', name: 'assets', component: () => import('./components/AssetsPanel.vue'), meta: { requiresAuth: true } },
  { path: '/goals', name: 'goals', component: () => import('./components/GoalTracker.vue'), meta: { requiresAuth: true } },
  { path: '/exchange', name: 'exchange', component: () => import('./components/ExchangePanel.vue'), meta: { requiresAuth: true } },
  { path: '/import', name: 'import', component: () => import('./components/ImportPage.vue'), meta: { requiresAuth: true } },
  { path: '/health', name: 'health', component: () => import('./components/HealthPanel.vue'), meta: { requiresAuth: true } },
  { path: '/investments', name: 'investments', component: () => import('./components/InvestmentsPanel.vue'), meta: { requiresAuth: true } },
  { path: '/debts', name: 'debts', component: () => import('./components/DebtsPanel.vue'), meta: { requiresAuth: true } },
  { path: '/subscriptions', name: 'subscriptions', component: () => import('./components/SubscriptionsPanel.vue'), meta: { requiresAuth: true } },
  { path: '/tax', name: 'tax', component: () => import('./components/TaxPanel.vue'), meta: { requiresAuth: true } },
  { path: '/insurance', name: 'insurance', component: () => import('./components/InsurancePanel.vue'), meta: { requiresAuth: true } },
  { path: '/notifications', name: 'notifications', component: () => import('./components/NotificationsPanel.vue'), meta: { requiresAuth: true } },
  { path: '/family', name: 'family', component: () => import('./components/FamilyPanel.vue'), meta: { requiresAuth: true } },
  { path: '/privacy', name: 'privacy', component: () => import('./components/PrivacyPanel.vue'), meta: { requiresAuth: true } },
  // 404 兜底
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./components/NotFoundPage.vue'), meta: { public: true } }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

// 全局路由守卫：登录态校验（替代 App.vue 内的组件级 watch）
router.beforeEach((to) => {
  const token = localStorage.getItem('auth_token')
  if (to.meta.requiresAuth && !token) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.name === 'login' && token) {
    return { name: 'chat' }
  }
  return true
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// PWA Service Worker 注册（load 后注册，不影响首屏性能）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service Worker 注册失败:', err)
    })
  })
}
