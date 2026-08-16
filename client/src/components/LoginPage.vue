<template>
  <div class="login-page">
    <div class="login-card">
      <h1>智能财务顾问</h1>
      <p class="subtitle">邮箱登录，轻松管理财务</p>

      <!-- Tab -->
      <div class="tab-bar">
        <button type="button" :class="{ active: mode === 'login' }" :disabled="loading" @click="switchMode('login')">登录</button>
        <button type="button" :class="{ active: mode === 'register' }" :disabled="loading" @click="switchMode('register')">注册</button>
      </div>

      <form @submit.prevent="doSubmit" class="login-form">
        <div class="field">
          <label for="auth-email">邮箱</label>
          <input
            id="auth-email"
            v-model="identity"
            type="email"
            placeholder="请输入邮箱"
            maxlength="254"
            autocomplete="email"
            :disabled="loading"
            required
          />
        </div>

        <div class="field">
          <label for="auth-password">密码</label>
          <input
            id="auth-password"
            v-model="password"
            type="password"
            :placeholder="mode === 'login' ? '请输入密码' : '请设置密码（至少6位）'"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            :disabled="loading"
            required
          />
        </div>

        <div v-if="error" class="error-msg" role="alert">{{ error }}</div>
        <div v-if="success" class="success-msg" role="status">{{ success }}</div>

        <button type="submit" class="btn btn-primary btn-lg btn-full" :disabled="loading">
          {{ loading ? '处理中...' : mode === 'login' ? '登录' : '注册' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app.js'
import { useRouter } from 'vue-router'
import { api } from '../utils/api.js'
import { isValidAuthIdentity, isValidAuthPassword, normalizeEmail } from '../utils/authForm.js'

const store = useAppStore()
const router = useRouter()

// Only email channel, no code
const channel = ref('email-quick')
const mode = ref('login')
const identity = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')
const success = ref('')

let disposed = false

const identityValid = computed(() => isValidAuthIdentity(channel.value, identity.value))

function switchMode(nextMode) {
  if (loading.value || mode.value === nextMode) return
  mode.value = nextMode
  password.value = ''
  error.value = ''
  success.value = ''
}

async function doSubmit() {
  if (loading.value) return
  error.value = ''
  success.value = ''

  if (!identityValid.value) {
    error.value = '请输入正确的邮箱'
    return
  }
  if (!isValidAuthPassword(mode.value, password.value)) {
    error.value = mode.value === 'login' ? '请输入密码' : '密码至少6位'
    return
  }

  loading.value = true
  try {
    const email = normalizeEmail(identity.value)
    const res = mode.value === 'login'
      ? await api.emailLogin(email, password.value)
      : await api.emailQuickRegister(email, password.value)

    if (disposed) return

    if (res.success) {
      store.setToken(res.data.token)
      await store.loadUser()
      if (disposed) return
      router.push('/')
    } else {
      error.value = res.error || '操作失败'
    }
  } catch (e) {
    if (!disposed) error.value = e.message || '网络错误'
  } finally {
    if (!disposed) loading.value = false
  }
}

onUnmounted(() => {
  disposed = true
})
</script>

<style scoped>
.login-page {
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh;
  background: #f6f9fc;
  position: relative;
}
.login-page::before {
  content: '';
  position: absolute; inset: 0;
  background:
    radial-gradient(600px 300px at 85% 10%, rgba(83,58,253,0.06), transparent 60%),
    radial-gradient(500px 280px at 10% 90%, rgba(83,58,253,0.05), transparent 60%);
  pointer-events: none;
}
.login-card {
  background: #fff; border-radius: 8px; padding: 44px 40px;
  text-align: center; max-width: 420px; width: 90%;
  border: 1px solid #e5edf5;
  box-shadow: rgba(50,50,93,0.25) 0px 30px 45px -30px, rgba(0,0,0,0.1) 0px 18px 36px -18px;
  position: relative;
}
.login-card h1 { font-size: 26px; margin-bottom: 6px; color: #061b31; font-weight: 600; letter-spacing: -0.3px; }
.subtitle { color: #64748d; margin-bottom: 28px; font-size: 14px; }

.tab-bar { display: flex; border-radius: 6px; overflow: hidden; border: 1px solid #e5edf5; margin-bottom: 24px; background: #f6f9fc; }
.tab-bar button {
  flex: 1; padding: 10px; border: none; background: transparent;
  cursor: pointer; font-size: 14px; color: #64748d; font-weight: 500;
  transition: color .15s ease, background .15s ease;
}
.tab-bar button.active { background: #fff; color: #533afd; box-shadow: inset 0 -2px 0 #533afd; }
.tab-bar button:disabled { opacity: 0.5; cursor: not-allowed; }

.login-form { text-align: left; }
.field { margin-bottom: 16px; }
.field label { display: block; font-size: 13px; color: #273951; margin-bottom: 4px; font-weight: 500; }
.field input {
  width: 100%; padding: 10px 12px; border: 1px solid #e5edf5; border-radius: 4px;
  font-size: 15px; outline: none; box-sizing: border-box; color: #061b31;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.field input:focus { border-color: #533afd; box-shadow: 0 0 0 3px rgba(83,58,253,0.22); }
.field input::placeholder { color: #94a3b8; }

.error-msg { color: #e53e3e; font-size: 13px; margin-bottom: 12px; text-align: center; }
.success-msg { color: #108c3d; font-size: 13px; margin-bottom: 12px; text-align: center; }

.btn-full { width: 100%; }
.btn-lg { padding: 12px 24px; font-size: 16px; border-radius: 4px; }
.btn-primary { background: #533afd; color: #fff; border: none; cursor: pointer; transition: background .15s ease; }
.btn-primary:hover { background: #4434d4; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
