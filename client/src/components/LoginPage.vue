<template>
  <div class="login-page">
    <div class="login-card">
      <h1>💰 智能财务顾问</h1>
      <p class="subtitle">{{ channel === 'email' ? '邮箱登录，轻松管理财务' : '手机号登录，轻松管理财务' }}</p>

      <div class="channel-bar" aria-label="登录方式">
        <button
          type="button"
          :class="{ active: channel === 'email' }"
          :aria-pressed="channel === 'email'"
          :disabled="loading || sendingCode"
          @click="switchChannel('email')"
        >邮箱</button>
        <button
          type="button"
          :class="{ active: channel === 'phone' }"
          :aria-pressed="channel === 'phone'"
          :disabled="loading || sendingCode"
          @click="switchChannel('phone')"
        >手机号</button>
      </div>

      <!-- Tab -->
      <div class="tab-bar">
        <button type="button" :class="{ active: mode === 'login' }" :disabled="loading || sendingCode" @click="switchMode('login')">登录</button>
        <button type="button" :class="{ active: mode === 'register' }" :disabled="loading || sendingCode" @click="switchMode('register')">注册</button>
        <button type="button" :class="{ active: mode === 'reset' }" :disabled="loading || sendingCode" @click="switchMode('reset')">忘记密码</button>
      </div>

      <form @submit.prevent="doSubmit" class="login-form">
        <div class="field">
          <label>{{ channel === 'email' ? '邮箱' : '手机号' }}</label>
          <input
            v-model="identity"
            :type="channel === 'email' ? 'email' : 'tel'"
            :placeholder="channel === 'email' ? '请输入邮箱' : '请输入手机号'"
            :maxlength="channel === 'email' ? 254 : 11"
            :autocomplete="channel === 'email' ? 'email' : 'tel'"
            :disabled="loading || sendingCode"
            required
          />
        </div>

        <!-- 注册 / 忘记密码验证码 -->
        <div class="field" v-if="mode !== 'login'">
          <label>验证码</label>
          <div class="code-row">
            <input
              v-model="code"
              type="text"
              inputmode="numeric"
              placeholder="6位验证码"
              maxlength="6"
              autocomplete="one-time-code"
              :disabled="loading || sendingCode"
              required
            />
            <button
              type="button"
              class="btn btn-code"
              :disabled="verificationCountdown > 0 || sendingCode || loading || !identityValid"
              @click="sendCode"
            >
              {{ sendingCode ? '发送中...' : verificationCountdown > 0 ? `${verificationCountdown}s` : '发送验证码' }}
            </button>
          </div>
        </div>

        <!-- 密码 — 登录 / 注册都有 -->
        <div class="field">
          <label>密码</label>
          <input
            v-model="password"
            type="password"
            :placeholder="mode === 'login' ? '请输入密码' : '请输入新密码（至少6位）'"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            :disabled="loading || sendingCode"
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
            :disabled="loading || sendingCode"
            required
          />
        </div>

        <!-- 错误 / 成功提示 -->
        <div v-if="error" class="error-msg" role="alert">{{ error }}</div>
        <div v-if="success" class="success-msg" role="status">{{ success }}</div>

        <button type="submit" class="btn btn-primary btn-lg btn-full" :disabled="loading || sendingCode">
          {{ loading ? '处理中...' : submitLabel }}
        </button>
      </form>

      <div class="divider"><span>或</span></div>

      <button type="button" class="btn btn-outline btn-lg btn-full wechat-btn" :disabled="loading || sendingCode" @click="showWechatTip">
        💚 微信小程序登录
      </button>

      <div v-if="isDev" class="dev-section">
        <button type="button" class="btn btn-sm btn-outline" @click="doMockLogin" :disabled="loading || sendingCode">🧪 快速体验（跳过注册）</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app.js'
import { useRouter, useRoute } from 'vue-router'
import { api } from '../utils/api.js'
import {
  isValidAuthIdentity,
  isValidAuthPassword,
  normalizeEmail,
  purposeForMode,
  requestForAuthMode
} from '../utils/authForm.js'

const store = useAppStore()
const router = useRouter()
const route = useRoute()

const channel = ref('email')
const mode = ref('login')
const identity = ref('')
const code = ref('')
const password = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const sendingCode = ref(false)
const error = ref('')
const success = ref('')
const verificationCountdown = ref(0)
const isDev = ref(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')

let countdownTimer = null

const identityValid = computed(() => isValidAuthIdentity(channel.value, identity.value))

const submitLabel = computed(() => {
  if (mode.value === 'login') return '🔐 登录'
  if (mode.value === 'register') return '📝 注册'
  return '🔑 重置密码'
})

function clearSensitiveFields() {
  code.value = ''
  password.value = ''
  confirmPassword.value = ''
}

function stopCountdown() {
  if (countdownTimer !== null) clearInterval(countdownTimer)
  countdownTimer = null
  verificationCountdown.value = 0
}

function switchMode(nextMode) {
  if (loading.value || sendingCode.value || mode.value === nextMode) return
  mode.value = nextMode
  clearSensitiveFields()
  error.value = ''
  success.value = ''
  stopCountdown()
}

function switchChannel(nextChannel) {
  if (loading.value || sendingCode.value || channel.value === nextChannel) return
  channel.value = nextChannel
  identity.value = ''
  clearSensitiveFields()
  error.value = ''
  success.value = ''
  stopCountdown()
}

async function sendCode() {
  if (loading.value || sendingCode.value) return
  if (!identityValid.value) {
    error.value = channel.value === 'email' ? '请输入正确的邮箱' : '请输入正确的手机号'
    return
  }
  error.value = ''
  success.value = ''
  sendingCode.value = true
  try {
    const res = channel.value === 'email'
      ? await api.emailSendCode(normalizeEmail(identity.value), purposeForMode(mode.value))
      : await api.sendCode(identity.value)
    if (res.success) {
      success.value = res.message || '验证码已发送'
      stopCountdown()
      verificationCountdown.value = 60
      countdownTimer = setInterval(() => {
        verificationCountdown.value--
        if (verificationCountdown.value <= 0) stopCountdown()
      }, 1000)
    } else {
      error.value = res.error || res.message || '发送失败'
    }
  } catch (e) {
    error.value = e.message || '发送失败'
  } finally {
    sendingCode.value = false
  }
}

async function doSubmit() {
  if (loading.value || sendingCode.value) return
  error.value = ''
  success.value = ''

  if (!identityValid.value) {
    error.value = channel.value === 'email' ? '请输入正确的邮箱' : '请输入正确的手机号'
    return
  }
  if (!isValidAuthPassword(mode.value, password.value)) {
    if (new TextEncoder().encode(password.value).length > 72) {
      error.value = '密码不能超过72字节'
    } else {
      error.value = mode.value === 'login' ? '请输入密码' : '密码至少6位'
    }
    return
  }

  // 注册 / 重置需要验证码
  if (mode.value !== 'login') {
    if (!/^[0-9]{6}$/.test(code.value)) {
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
    const res = await requestForAuthMode(api, {
      channel: channel.value,
      mode: mode.value,
      identity: identity.value,
      code: code.value,
      password: password.value
    })

    if (res.success) {
      if (mode.value === 'reset') {
        loading.value = false
        switchMode('login')
        success.value = '密码重置成功，请使用新密码登录'
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
  if (loading.value || sendingCode.value) return
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
  error.value = '微信小程序登录需在微信内打开小程序使用。Web 端请使用邮箱或手机号登录。'
}

onUnmounted(stopCountdown)

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

.channel-bar, .tab-bar { display: flex; border-radius: 10px; overflow: hidden; border: 1px solid #e2e8f0; }
.channel-bar { margin-bottom: 12px; }
.tab-bar { margin-bottom: 24px; }
.channel-bar button,
.tab-bar button {
  flex: 1; padding: 10px; border: none; background: #f8fafc;
  cursor: pointer; font-size: 14px; color: #64748b; font-weight: 500;
}
.channel-bar button.active,
.tab-bar button.active { background: #fff; color: #4f46e5; }
.channel-bar button:disabled,
.tab-bar button:disabled { opacity: 0.5; cursor: not-allowed; }

.login-form { text-align: left; }
.field { margin-bottom: 16px; }
.field label { display: block; font-size: 13px; color: #64748b; margin-bottom: 4px; }
.field input {
  width: 100%; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 8px;
  font-size: 15px; outline: none; box-sizing: border-box;
}
.field input:focus { border-color: #4f46e5; }

.code-row { display: flex; gap: 8px; }
.code-row input { flex: 1; }
.btn-code {
  padding: 10px 14px; background: #eef2ff; color: #4f46e5; border: 1px solid #c7d2fe;
  border-radius: 8px; font-size: 13px; cursor: pointer; white-space: nowrap;
}
.btn-code:disabled { opacity: 0.5; cursor: not-allowed; }

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
