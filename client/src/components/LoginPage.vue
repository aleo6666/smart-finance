<template>
  <div class="login-page">
    <div class="login-card">
      <h1>💰 智能财务顾问</h1>
      <p class="subtitle">手机号登录，轻松管理财务</p>

      <!-- Tab -->
      <div class="tab-bar">
        <button :class="{ active: mode === 'login' }" @click="switchMode('login')">登录</button>
        <button :class="{ active: mode === 'register' }" @click="switchMode('register')">注册</button>
        <button :class="{ active: mode === 'reset' }" @click="switchMode('reset')">忘记密码</button>
      </div>

      <form @submit.prevent="doSubmit" class="login-form">
        <!-- 手机号 — 所有模式都有 -->
        <div class="field">
          <label>手机号</label>
          <input
            v-model="phone"
            type="tel"
            placeholder="请输入手机号"
            maxlength="11"
            autocomplete="tel"
            required
          />
        </div>

        <!-- SMS 验证码 — 注册 / 忘记密码 -->
        <div class="field" v-if="mode !== 'login'">
          <label>验证码</label>
          <div class="sms-row">
            <input
              v-model="code"
              type="text"
              placeholder="6位验证码"
              maxlength="6"
              autocomplete="one-time-code"
              required
            />
            <button
              type="button"
              class="btn btn-sms"
              :disabled="smsCountdown > 0 || !phoneValid"
              @click="sendCode"
            >
              {{ smsCountdown > 0 ? `${smsCountdown}s` : '发送验证码' }}
            </button>
          </div>
        </div>

        <!-- 密码 — 登录 / 注册都有 -->
        <div class="field">
          <label>密码</label>
          <input
            v-model="password"
            type="password"
            :placeholder="mode === 'reset' ? '请输入新密码（至少6位）' : '请输入密码（至少6位）'"
            autocomplete="current-password"
            required
          />
        </div>

        <!-- 确认密码 — 注册 / 重置 -->
        <div class="field" v-if="mode !== 'login'">
          <label>确认密码</label>
          <input
            v-model="confirmPassword"
            type="password"
            placeholder="再次输入密码"
            autocomplete="new-password"
            required
          />
        </div>

        <!-- 错误 / 成功提示 -->
        <div v-if="error" class="error-msg">{{ error }}</div>
        <div v-if="success" class="success-msg">{{ success }}</div>

        <button type="submit" class="btn btn-primary btn-lg btn-full" :disabled="loading">
          {{ loading ? '处理中...' : submitLabel }}
        </button>
      </form>

      <div class="divider"><span>或</span></div>

      <button class="btn btn-outline btn-lg btn-full wechat-btn" @click="showWechatTip">
        💚 微信小程序登录
      </button>

      <div v-if="isDev" class="dev-section">
        <button class="btn btn-sm btn-outline" @click="doMockLogin" :disabled="loading">🧪 快速体验（跳过注册）</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAppStore } from '../stores/app.js'
import { useRouter, useRoute } from 'vue-router'
import { api } from '../utils/api.js'

const store = useAppStore()
const router = useRouter()
const route = useRoute()

const mode = ref('login')
const phone = ref('')
const code = ref('')
const password = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')
const success = ref('')
const smsCountdown = ref(0)
const isDev = ref(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')

let countdownTimer = null

const phoneValid = computed(() => /^1[3-9]\d{9}$/.test(phone.value))

const submitLabel = computed(() => {
  if (mode.value === 'login') return '🔐 登录'
  if (mode.value === 'register') return '📝 注册'
  return '🔑 重置密码'
})

function switchMode(m) {
  mode.value = m
  error.value = ''
  success.value = ''
}

async function sendCode() {
  if (!phoneValid.value) {
    error.value = '请输入正确的手机号'
    return
  }
  error.value = ''
  try {
    const res = await api.sendCode(phone.value)
    if (res.success) {
      smsCountdown.value = 60
      countdownTimer = setInterval(() => {
        smsCountdown.value--
        if (smsCountdown.value <= 0) clearInterval(countdownTimer)
      }, 1000)
    } else {
      error.value = res.error || '发送失败'
    }
  } catch (e) {
    error.value = e.message || '发送失败'
  }
}

async function doSubmit() {
  error.value = ''
  success.value = ''

  if (!phoneValid.value) {
    error.value = '请输入正确的手机号'
    return
  }
  if (!password.value || password.value.length < 6) {
    error.value = '密码至少6位'
    return
  }

  // 注册 / 重置需要验证码
  if (mode.value !== 'login') {
    if (!code.value || code.value.length !== 6) {
      error.value = '请输入6位验证码'
      return
    }
    if (password.value !== confirmPassword.value) {
      error.value = '两次密码不一致'
      return
    }
  }

  loading.value = true
  try {
    let res
    if (mode.value === 'login') {
      res = await api.login(phone.value, password.value)
    } else if (mode.value === 'register') {
      res = await api.register(phone.value, code.value, password.value)
    } else {
      res = await api.resetPassword(phone.value, code.value, password.value)
    }

    if (res.success) {
      if (mode.value === 'reset') {
        success.value = '密码重置成功，请使用新密码登录'
        switchMode('login')
        password.value = ''
        confirmPassword.value = ''
        code.value = ''
      } else {
        store.setToken(res.data.token)
        await store.loadUser()
        router.push('/')
      }
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
  error.value = '微信小程序登录需在微信内打开小程序使用。Web 端请使用手机号登录。'
}

onMounted(async () => {
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
  text-align: center; max-width: 420px; width: 90%;
  box-shadow: 0 20px 60px rgba(0,0,0,0.15);
}
.login-card h1 { font-size: 26px; margin-bottom: 6px; color: #333; }
.subtitle { color: #888; margin-bottom: 24px; font-size: 14px; }

.tab-bar { display: flex; margin-bottom: 24px; border-radius: 10px; overflow: hidden; border: 1px solid #e2e8f0; }
.tab-bar button {
  flex: 1; padding: 10px; border: none; background: #f8fafc;
  cursor: pointer; font-size: 14px; color: #64748b; font-weight: 500;
}
.tab-bar button.active { background: #fff; color: #4f46e5; }

.login-form { text-align: left; }
.field { margin-bottom: 16px; }
.field label { display: block; font-size: 13px; color: #64748b; margin-bottom: 4px; }
.field input {
  width: 100%; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 8px;
  font-size: 15px; outline: none; box-sizing: border-box;
}
.field input:focus { border-color: #4f46e5; }

.sms-row { display: flex; gap: 8px; }
.sms-row input { flex: 1; }
.btn-sms {
  padding: 10px 14px; background: #eef2ff; color: #4f46e5; border: 1px solid #c7d2fe;
  border-radius: 8px; font-size: 13px; cursor: pointer; white-space: nowrap;
}
.btn-sms:disabled { opacity: 0.5; cursor: not-allowed; }

.error-msg { color: #ef4444; font-size: 13px; margin-bottom: 12px; text-align: center; }
.success-msg { color: #10b981; font-size: 13px; margin-bottom: 12px; text-align: center; }

.btn-full { width: 100%; }
.btn-lg { padding: 12px 24px; font-size: 16px; border-radius: 8px; }
.btn-primary { background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; border: none; cursor: pointer; }
.btn-primary:hover { opacity: 0.9; }
.btn-outline { background: transparent; border: 1px solid #ddd; color: #666; cursor: pointer; }
.btn-sm { padding: 8px 16px; font-size: 13px; border-radius: 6px; }
.btn-primary:disabled, .btn-outline:disabled { opacity: 0.5; cursor: not-allowed; }

.divider { display: flex; align-items: center; margin: 20px 0; color: #aaa; font-size: 13px; }
.divider::before, .divider::after { content: ''; flex: 1; border-top: 1px solid #eee; }
.divider span { padding: 0 12px; }

.wechat-btn { color: #07c160; border-color: #07c160; margin-bottom: 12px; }

.dev-section { margin-top: 16px; padding-top: 16px; border-top: 1px dashed #eee; }
</style>
