import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import './style.css'

const routes = [
  { path: '/', name: 'chat', component: () => import('./components/ChatWindow.vue') },
  { path: '/reports', name: 'reports', component: () => import('./components/ReportPanel.vue') },
  { path: '/goals', name: 'goals', component: () => import('./components/GoalTracker.vue') }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
