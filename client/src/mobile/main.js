import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import AppMobile from './AppMobile.vue'
import '../style.css'
import './mobile.css'

// 移动端独立路由：复用与 PC 端完全相同的页面组件，保证功能一致、不增不减
const routes = [
  { path: '/login', name: 'login', component: () => import('../components/LoginPage.vue') },
  { path: '/', name: 'chat', component: () => import('../components/ChatWindow.vue') },
  { path: '/reports', name: 'reports', component: () => import('../components/ReportPanel.vue') },
  { path: '/goals', name: 'goals', component: () => import('../components/GoalTracker.vue') },
  { path: '/exchange', name: 'exchange', component: () => import('../components/ExchangePanel.vue') },
  { path: '/import', name: 'import', component: () => import('../components/ImportPage.vue') }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

const app = createApp(AppMobile)
app.use(createPinia())
app.use(router)
app.mount('#mobile-app')
