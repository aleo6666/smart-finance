<template>
  <div class="login-page">
    <div class="login-card">
      <h1>💰 智能财务记账</h1>
      <p class="subtitle">登录或注册，开始记账之旅</p>

      <!-- Tab 切换 -->
      <div class="tab-bar">
        <button :class="{ active: mode === 'login' }" @click="switchMode('login')">登录</button>
        <button :class="{ active: mode === 'register' }" @click="switchMode('register')">注册</button>
      </div>

      <form @submit.prevent="doSubmit" class="login-form">
        <div class="field">
          <label>用户名</label>
          <input v-model="username" type="text" placeholder="请输入用户名" autocomplete="username" required />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="password" type="password" placeholder="请输入密码（至少6位）" autocomplete="current-password" required />
        </div>
        <div class="field" v-if="mode === 'register'">
          <label>确认密码</label>
          <input v-model="confirmPassword" type="password" placeholder="再次输入密码" autocomplete="new-password" required />
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>

        <button type="submit" class="btn btn-primary btn-lg btn-full" :disabled="loading">
          {{ loading ? '处理中...' : (mode === 'login' ? '🔐 登录' : '📝 注册') }}
        </button>
      </form>

      <div class="divider"><span>或</span></div>

      <!-- 微信小程序登录（需在微信内使用） -->
      <button class="btn btn-outline btn-lg btn-full wechat-btn" @click="showWechatTip">
        💚 微信小程序登录
      </button>

      <!-- 开发环境快捷入口 -->
      <div v-if="isDev" class="dev-section">
        <button class="btn btn-sm btn-outline" @click="doMockLogin" :disabled="loading">🧪 快速体验（跳过注册）</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAppStore } from '../stores/app.js'
import { useRouter, useRoute } from 'vue-router'
import { api } from '../utils/api.js'

const store = useAppStore()
const router = useRouter()
const route = useRoute()

const mode = ref('login')
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')
const isDev = ref(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')

function switchMode(m) {
  mode.value = m
  error.value = ''
}

async function doSubmit() {
  error.value = ''
  if (!username.value.trim() || !password.value) {
    error.value = '请填写用户名和密码'
    return
  }
  if (password.value.length < 6) {
    error.value = '密码至少6位'
    return
  }
  if (mode.value === 'register' && password.value !== confirmPassword.value) {
    error.value = '两次密码不一致'
    return
  }

  loading.value = true
  try {
    const res = mode.value === 'login'
      ? await api.login(username.value.trim(), password.value)
      : await api.register(username.value.trim(), password.value)

    if (res.success) {
      store.setToken(res.data.token)
      await store.loadUser()
      router.push('/')
    } else {
      error.value = res.error || '操作失败'
    }
  } catch (e) {
    error.value = e.message || '网络错误'
  } finally {
    loading.value = false
  }
}

async function doMockLogin() {
  loading.value = true
  error.value = ''
  try {
    const res = await api.mockLogin()
    if (res.success) {
      store.setToken(res.data.token)
      await store.loadUser()
      router.push('/')
    } else {
      error.value = res.error || '登录失败'
    }
  } catch (e) {
    error.value = e.message || '网络错误'
  } finally {
    loading.value = false
  }
}

function showWechatTip() {
  error.value = '微信小程序登录需在微信内打开小程序使用。Web 端请使用用户名密码登录。'
}

onMounted(async () => {
  // 公众号 OAuth 回调处理
  const token = route.query.token
  if (token) {
    loading.value = true
    store.setToken(token)
    try {
      await store.loadUser()
      router.replace({ path: '/', query: {} })
    } catch (e) {
      error.value = '加载用户信息失败'
      store.logout()
    } finally {
      loading.value = false
    }
  }
})
</script>

<style scoped>
.login-page {
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}
.login-card {
  background: #fff; border-radius: 16px; padding: 40px 36px;
  text-align: center; max-width: 400px; width: 90%;
  box-shadow: 0 20px 60px rgba(0,0,0,0.15);
}
.login-card h1 { font-size: 26px; margin-bottom: 6px; color: #333; }
.subtitle { color: #888; margin-bottom: 24px; font-size: 14px; }

/* Tab */
.tab-bar { display: flex; margin-bottom: 24px; border-radius: 10px; overflow: hidden; border: 1px solid var(--border, #e2e8f0); }
.tab-bar button {
  flex: 1; padding: 10px; border: none; background: #f8fafc;
  cursor: pointer; font-size: 15px; color: #64748b; font-weight: 500;
}
.tab-bar button.active { background: #fff; color: #4f46e5; }

/* Form */
.login-form { text-align: left; }
.field { margin-bottom: 16px; }
.field label { display: block; font-size: 13px; color: #64748b; margin-bottom: 4px; }
.field input {
  width: 100%; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 8px;
  font-size: 15px; outline: none; box-sizing: border-box;
}
.field input:focus { border-color: #4f46e5; }

.error-msg { color: #ef4444; font-size: 13px; margin-bottom: 12px; text-align: center; }

.btn-full { width: 100%; }
.btn-lg { padding: 12px 24px; font-size: 16px; border-radius: 8px; }
.btn-primary { background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; border: none; cursor: pointer; }
.btn-primary:hover { opacity: 0.9; }
.btn-outline { background: transparent; border: 1px solid #ddd; color: #666; cursor: pointer; }
.btn-sm { padding: 8px 16px; font-size: 13px; border-radius: 6px; }

.divider { display: flex; align-items: center; margin: 20px 0; color: #aaa; font-size: 13px; }
.divider::before, .divider::after { content: ''; flex: 1; border-top: 1px solid #eee; }
.divider span { padding: 0 12px; }

.wechat-btn { color: #07c160; border-color: #07c160; margin-bottom: 12px; }

.dev-section { margin-top: 16px; padding-top: 16px; border-top: 1px dashed #eee; }
</style>
