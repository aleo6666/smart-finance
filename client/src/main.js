import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import './style.css'

const routes = [
  { path: '/login', name: 'login', component: () => import('./components/LoginPage.vue') },
  { path: '/', name: 'chat', component: () => import('./components/ChatWindow.vue') },
  { path: '/reports', name: 'reports', component: () => import('./components/ReportPanel.vue') },
  { path: '/report', name: 'report', component: () => import('./components/MonthlyReport.vue') },
  { path: '/assets', name: 'assets', component: () => import('./components/AssetsPanel.vue') },
  { path: '/goals', name: 'goals', component: () => import('./components/GoalTracker.vue') },
  { path: '/exchange', name: 'exchange', component: () => import('./components/ExchangePanel.vue') },
  { path: '/import', name: 'import', component: () => import('./components/ImportPage.vue') }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
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
