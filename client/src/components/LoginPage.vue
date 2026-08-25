<template>
  <div class="landing-page">
    <!-- 1. 顶部导航（sticky） -->
    <nav class="landing-nav">
      <div class="nav-brand">
        <svg viewBox="0 0 64 64" width="30" height="30" aria-hidden="true">
          <rect x="4" y="4" width="56" height="56" rx="9" fill="#C4402B"/>
          <rect x="10" y="10" width="44" height="44" rx="5" fill="none" stroke="#FBF7F0" stroke-width="2"/>
          <text x="32" y="43" text-anchor="middle" font-size="30" font-weight="700" fill="#FBF7F0" font-family="'Noto Serif SC','Source Han Serif SC','Songti SC',serif">财</text>
        </svg>
        <span class="nav-title">智能财务顾问</span>
      </div>
      <div class="nav-actions">
        <button type="button" class="nav-link" @click="scrollToLogin()">登录</button>
        <button type="button" class="btn btn-primary nav-cta" @click="scrollToLogin()">立即体验</button>
      </div>
    </nav>

    <!-- 2. Hero 区 -->
    <header class="hero">
      <div class="hero-inner">
        <div class="hero-copy">
          <span class="paper-badge hero-badge">不是记账工具，是 AI 财务顾问</span>
          <h1>你的专属 AI 财务顾问</h1>
          <p class="hero-sub">
            <strong>记账只是开始，规划才是核心</strong>
            —— 说句话就记账，问一声就懂你的财务
          </p>
          <div class="hero-cta">
            <button type="button" class="btn btn-primary btn-lg" @click="scrollToLogin()">立即开始体验 →</button>
            <button type="button" class="hero-demo" @click="scrollToLogin(true)">体验演示账号</button>
          </div>
        </div>

        <!-- 健康分预览：剪纸窗花圆环仪表盘 -->
        <div class="hero-visual" aria-hidden="true">
          <div class="gauge-wrap">
            <svg viewBox="0 0 240 240" class="gauge">
              <!-- 窗花外环：12 瓣剪花，朱砂/金相间 -->
              <g fill="#C4402B" opacity="0.85">
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z"/>
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z" transform="rotate(60 120 120)"/>
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z" transform="rotate(120 120 120)"/>
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z" transform="rotate(180 120 120)"/>
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z" transform="rotate(240 120 120)"/>
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z" transform="rotate(300 120 120)"/>
              </g>
              <g fill="#C9A227" opacity="0.85">
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z" transform="rotate(30 120 120)"/>
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z" transform="rotate(90 120 120)"/>
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z" transform="rotate(150 120 120)"/>
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z" transform="rotate(210 120 120)"/>
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z" transform="rotate(270 120 120)"/>
                <path d="M120 8 C126.5 21 126.5 32 120 42 C113.5 32 113.5 21 120 8 Z" transform="rotate(330 120 120)"/>
              </g>
              <circle cx="120" cy="120" r="102" fill="none" stroke="#C4402B" stroke-width="2" opacity="0.35"/>
              <circle cx="120" cy="120" r="94" fill="#FDFAF4"/>
              <circle cx="120" cy="120" r="94" fill="none" stroke="#C9A227" stroke-width="1.5" stroke-dasharray="3 6" opacity="0.8"/>
              <!-- 仪表盘：78.6 分 -->
              <circle cx="120" cy="120" r="78" fill="none" stroke="#EFE7D9" stroke-width="11"/>
              <circle
                cx="120" cy="120" r="78" fill="none"
                stroke="#533AFD" stroke-width="11" stroke-linecap="round"
                stroke-dasharray="385.2 490.1"
                transform="rotate(-90 120 120)"
              />
            </svg>
            <div class="gauge-center">
              <span class="gauge-score">78.6</span>
              <span class="gauge-label">财务健康分</span>
              <span class="gauge-grade">健康良好</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 4 个数据条 -->
      <div class="hero-stats">
        <div class="hero-stat"><span class="stat-num">3 秒</span><span class="stat-txt">智能记账</span></div>
        <div class="hero-stat"><span class="stat-num">7 维</span><span class="stat-txt">专业体检</span></div>
        <div class="hero-stat"><span class="stat-num">24h</span><span class="stat-txt">异常守护</span></div>
        <div class="hero-stat"><span class="stat-num">100%</span><span class="stat-txt">隐私安全</span></div>
      </div>
    </header>

    <!-- 3. 核心亮点区 -->
    <section class="highlights">
      <!-- 铜钱小装饰（窄屏隐藏） -->
      <svg class="hl-deco hl-deco-left" viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="20" fill="#C9A227" opacity="0.9"/>
        <rect x="17" y="17" width="14" height="14" fill="#FBF7F0"/>
      </svg>
      <svg class="hl-deco hl-deco-right" viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="20" fill="#C9A227" opacity="0.9"/>
        <rect x="17" y="17" width="14" height="14" fill="#FBF7F0"/>
      </svg>

      <h2 class="section-title">AI 财务顾问的核心能力</h2>
      <div class="hl-grid">
        <div class="hl-card">
          <span class="hl-icon">💬</span>
          <h3>AI 对话记账</h3>
          <p>像聊天一样记账——文字/语音/拍照全能记，规则引擎秒级落账，大额自动确认</p>
        </div>
        <div class="hl-card">
          <span class="hl-icon">🏥</span>
          <h3>七维财务体检</h3>
          <p>现金/负债/保险/投资/教育金/养老/财产，CFP 框架自动评分，附改善建议</p>
        </div>
        <div class="hl-card">
          <span class="hl-icon">🚨</span>
          <h3>异常消费守护</h3>
          <p>离群大额、重复扣费、单日激增，AI 主动提醒，不再乱花钱</p>
        </div>
      </div>
    </section>

    <!-- 4. 产品预览区 -->
    <section class="preview">
      <h2 class="section-title">产品预览</h2>
      <div class="preview-card">
        <div class="chat-demo">
          <p class="demo-title">对话记账</p>
          <div class="bubble user">今天午餐花了25元</div>
          <div class="bubble ai">已记好：餐饮 ¥25.00 ✅</div>
        </div>
        <div class="chart-demo">
          <p class="demo-title">月度支出趋势</p>
          <div class="bars">
            <div class="bar"><i style="--h:52%"></i><span>3月</span></div>
            <div class="bar"><i style="--h:68%"></i><span>4月</span></div>
            <div class="bar"><i style="--h:45%"></i><span>5月</span></div>
            <div class="bar"><i style="--h:80%"></i><span>6月</span></div>
            <div class="bar"><i style="--h:60%"></i><span>7月</span></div>
            <div class="bar current"><i style="--h:72%"></i><span>8月</span></div>
          </div>
        </div>
      </div>
    </section>

    <!-- 5. 差异化对比区 -->
    <section class="compare">
      <h2 class="section-title">记账 App 记录每一笔，我们规划每一块</h2>
      <div class="compare-grid">
        <div class="compare-col">
          <h3>记账 App</h3>
          <ul>
            <li>记录每一笔账单</li>
            <li>月底看个报表</li>
            <li>记完就完事</li>
          </ul>
        </div>
        <div class="compare-col primary">
          <h3>智能财务顾问</h3>
          <ul>
            <li>说句话自动记账</li>
            <li>七维健康评分</li>
            <li>异常消费主动提醒</li>
            <li>目标规划陪伴达成</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 6. 登录卡片区（保留全部登录功能） -->
    <section id="login" class="login-section">
      <div class="login-card">
      <!-- 剪纸印章 logo -->
      <div class="seal-logo" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="54" height="54">
          <rect x="4" y="4" width="56" height="56" rx="9" fill="#C4402B"/>
          <rect x="10" y="10" width="44" height="44" rx="5" fill="none" stroke="#FBF7F0" stroke-width="2"/>
          <text x="32" y="43" text-anchor="middle" font-size="30" font-weight="700" fill="#FBF7F0" font-family="'Noto Serif SC','Source Han Serif SC','Songti SC',serif">财</text>
        </svg>
      </div>
      <h1>智能财务顾问</h1>
      <p class="subtitle">邮箱登录，轻松管理财务</p>
      <div class="paper-divider"></div>

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
            ref="emailInput"
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
          <div class="password-wrap">
            <input
              id="auth-password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              :placeholder="mode === 'login' ? '请输入密码' : '请设置密码（至少6位）'"
              :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
              :disabled="loading"
              required
            />
            <button
              type="button"
              class="pwd-toggle"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              :disabled="loading"
              @click="showPassword = !showPassword"
            >
              <svg v-if="showPassword" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            </button>
          </div>
        </div>

        <label v-if="mode === 'login'" class="remember-row">
          <input v-model="remember" type="checkbox" :disabled="loading" />
          <span>记住我</span>
        </label>

        <div v-if="error" class="error-msg" role="alert">{{ error }}</div>
        <div v-if="success" class="success-msg" role="status">{{ success }}</div>

        <button type="submit" class="btn btn-primary btn-lg btn-full" :disabled="loading">
          {{ loading ? '处理中...' : mode === 'login' ? '登录' : '注册' }}
        </button>

        <button
          v-if="mode === 'login'"
          type="button"
          class="demo-fill"
          :disabled="loading"
          @click="fillDemo"
        >
          体验演示账号
          <span class="demo-hint">内置 3 个月样本数据</span>
        </button>
      </form>
      </div>

      <p class="login-copyright">© 2026 智能财务顾问 · 让每一块钱都有规划</p>
    </section>

    <!-- 7. Footer -->
    <footer class="landing-footer">
      © 2026 智能财务顾问 · lisheng666.xyz · 让每一块钱都有规划
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
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
const showPassword = ref(false)
const remember = ref(true)
const emailInput = ref(null)

let disposed = false

const identityValid = computed(() => isValidAuthIdentity(channel.value, identity.value))

function fillDemo() {
  identity.value = 'demo@lisheng666.xyz'
  password.value = 'demo123456'
  error.value = ''
  success.value = ''
}

// 落地页 CTA：平滑滚动到登录区；演示入口同时填充 demo 账号
function scrollToLogin(withDemo = false) {
  if (withDemo) fillDemo()
  document.getElementById('login')?.scrollIntoView({ behavior: 'smooth' })
}

onMounted(() => {
  // 落地页首屏在 Hero，聚焦但不抢占滚动位置
  nextTick(() => emailInput.value?.focus({ preventScroll: true }))
})

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
      store.setToken(res.data.token, mode.value === 'login' ? remember.value : true)
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
/* ========== 落地页骨架（内部滚动容器） ========== */
.landing-page {
  height: 100vh;
  width: 100%;
  overflow-y: auto;
  background-color: var(--paper-bg);
  background-image:
    radial-gradient(rgba(61, 47, 20, 0.03) 1px, transparent 1.4px),
    radial-gradient(rgba(61, 47, 20, 0.02) 1px, transparent 1.4px);
  background-size: 26px 26px, 44px 44px;
  background-position: 0 0, 13px 17px;
}
#login { scroll-margin-top: 72px; }

/* ========== 1. 顶部导航 ========== */
.landing-nav {
  position: sticky; top: 0; z-index: 50;
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 28px;
  background: rgba(251, 247, 240, 0.88);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--paper-edge);
}
.nav-brand { display: flex; align-items: center; gap: 10px; }
.nav-title {
  font-family: var(--font-serif);
  font-size: 18px; font-weight: 700;
  color: var(--ink-dark); letter-spacing: 0.06em;
}
.nav-actions { display: flex; align-items: center; gap: 12px; }
.nav-link {
  border: none; background: transparent; cursor: pointer;
  font-size: 14px; color: var(--text-main); padding: 8px 10px;
  transition: color .15s ease;
}
.nav-link:hover { color: var(--brand-purple); }
.nav-cta { padding: 8px 18px; font-size: 14px; border-radius: 6px; }

/* ========== 2. Hero ========== */
.hero {
  padding: 72px 28px 56px;
  background:
    radial-gradient(600px 320px at 88% 8%, rgba(201, 162, 39, 0.08), transparent 60%),
    radial-gradient(520px 300px at 8% 92%, rgba(196, 64, 43, 0.05), transparent 60%);
}
.hero-inner {
  max-width: 1080px; margin: 0 auto;
  display: flex; align-items: center; justify-content: center;
  gap: 72px;
}
.hero-copy { max-width: 560px; }
.hero-badge { margin-bottom: 18px; font-size: 13px; }
.hero h1 {
  font-size: clamp(34px, 4.6vw, 52px);
  line-height: 1.2; margin-bottom: 18px;
  color: var(--ink-dark); font-weight: 700;
}
.hero-sub { font-size: 17px; line-height: 1.8; color: var(--text-main); margin-bottom: 28px; }
.hero-sub strong { color: var(--ink-dark); }
.hero-cta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.hero-demo {
  padding: 11px 20px; font-size: 15px; cursor: pointer;
  background: transparent; border: 1.5px dashed var(--paper-edge); border-radius: 6px;
  color: var(--text-sub);
  transition: color .15s ease, border-color .15s ease;
}
.hero-demo:hover { color: var(--brand-purple); border-color: var(--brand-purple); }

/* 健康分圆环仪表盘 */
.hero-visual { flex-shrink: 0; }
.gauge-wrap { position: relative; width: min(320px, 34vw); }
.gauge { width: 100%; height: auto; display: block; filter: drop-shadow(0 10px 24px rgba(61, 47, 20, 0.12)); }
.gauge-center {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.gauge-score {
  font-family: var(--font-serif);
  font-size: 46px; font-weight: 700; color: var(--ink-dark);
  line-height: 1; font-variant-numeric: tabular-nums;
}
.gauge-label { font-size: 13px; color: var(--text-sub); margin-top: 6px; }
.gauge-grade {
  margin-top: 8px; font-size: 12px; color: var(--brand-purple);
  background: var(--primary-soft); border-radius: 10px; padding: 2px 10px;
}

/* 4 个数据条 */
.hero-stats {
  max-width: 1080px; margin: 48px auto 0;
  display: flex; flex-wrap: wrap; justify-content: center; gap: 16px;
}
.hero-stat {
  display: flex; align-items: baseline; gap: 8px;
  background: var(--paper-card); border: 1px solid var(--paper-edge); border-radius: 8px;
  padding: 12px 22px; box-shadow: var(--paper-shadow);
}
.stat-num { font-family: var(--font-serif); font-size: 22px; font-weight: 700; color: var(--brand-purple); }
.stat-txt { font-size: 13px; color: var(--text-sub); }

/* ========== 通用区块标题 ========== */
.section-title {
  font-size: clamp(22px, 2.6vw, 28px);
  text-align: center; color: var(--ink-dark); font-weight: 700;
  margin-bottom: 40px;
}

/* ========== 3. 核心亮点区 ========== */
.highlights { position: relative; padding: 72px 28px 96px; }
.hl-deco { position: absolute; width: 44px; opacity: 0.35; }
.hl-deco-left { left: 6%; top: 88px; transform: rotate(-12deg); }
.hl-deco-right { right: 6%; bottom: 72px; transform: rotate(14deg); }
.hl-grid {
  max-width: 1080px; margin: 0 auto;
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px;
}
.hl-card {
  background: var(--paper-card); border: 1px solid var(--paper-edge); border-radius: 10px;
  box-shadow: var(--paper-shadow-lg); padding: 30px 26px;
  position: relative; z-index: 0;
  transition: box-shadow .2s ease;
}
.hl-card::before {
  content: '';
  position: absolute; inset: 0; z-index: -1;
  background: var(--paper-layer); border: 1px solid var(--paper-edge); border-radius: inherit;
  transform: rotate(0.8deg) translate(-3px, 5px);
}
.hl-card:hover { box-shadow: 0 2px 4px rgba(61,47,20,.08), 0 16px 36px rgba(61,47,20,.14); }
.hl-icon { font-size: 30px; display: block; margin-bottom: 14px; }
.hl-card h3 { font-size: 19px; margin-bottom: 10px; color: var(--ink-dark); }
.hl-card p { font-size: 14px; line-height: 1.75; color: var(--text-main); }
/* 错落排布（宽屏） */
@media (min-width: 961px) {
  .hl-card:nth-child(2) { transform: translateY(24px); }
  .hl-card:nth-child(3) { transform: translateY(48px); }
}

/* ========== 4. 产品预览区 ========== */
.preview { padding: 0 28px 96px; }
.preview-card {
  max-width: 960px; margin: 0 auto;
  background: var(--paper-card); border: 1px solid var(--paper-edge); border-radius: 12px;
  box-shadow: var(--paper-shadow-lg);
  padding: 36px;
  display: grid; grid-template-columns: 1fr 1fr; gap: 40px;
  position: relative; z-index: 0;
}
.preview-card::before {
  content: '';
  position: absolute; inset: 0; z-index: -1;
  background: var(--paper-layer); border: 1px solid var(--paper-edge); border-radius: inherit;
  transform: rotate(-0.6deg) translate(4px, 6px);
}
.demo-title {
  font-family: var(--font-serif); font-size: 15px; font-weight: 700;
  color: var(--ink-dark); margin-bottom: 18px; letter-spacing: 0.05em;
}
.chat-demo { display: flex; flex-direction: column; gap: 12px; }
.bubble {
  max-width: 85%; padding: 10px 14px; font-size: 14px; line-height: 1.6;
}
.bubble.user {
  align-self: flex-end;
  background: var(--brand-purple); color: #fff;
  border-radius: 12px 12px 4px 12px;
  box-shadow: 0 4px 10px -2px rgba(83,58,253,.35);
}
.bubble.ai {
  align-self: flex-start;
  background: #FDFAF4; color: var(--text-main);
  border: 1px solid var(--paper-edge);
  border-radius: 12px 12px 12px 4px;
  box-shadow: var(--paper-shadow);
}
/* 迷你柱状图 */
.bars {
  display: flex; align-items: flex-end; gap: 14px;
  height: 160px; padding-top: 8px;
}
.bar {
  flex: 1; height: 100%;
  display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
  gap: 8px;
}
.bar i {
  display: block; width: 100%; max-width: 34px; height: var(--h);
  background: var(--gold); border-radius: 4px 4px 0 0;
  box-shadow: inset 0 -3px 0 rgba(61,47,20,.12);
}
.bar.current i {
  background: var(--brand-purple);
  box-shadow: inset 0 -3px 0 rgba(40,26,140,.25);
}
.bar span { font-size: 12px; color: var(--text-sub); }

/* ========== 5. 差异化对比区 ========== */
.compare { padding: 0 28px 96px; }
.compare .section-title { max-width: 720px; margin-left: auto; margin-right: auto; }
.compare-grid {
  max-width: 860px; margin: 0 auto;
  display: grid; grid-template-columns: 1fr 1fr; gap: 28px;
  align-items: stretch;
}
.compare-col {
  border-radius: 10px; padding: 30px 28px;
  background: var(--paper-layer); border: 1px solid var(--paper-edge);
}
.compare-col h3 { font-size: 18px; margin-bottom: 16px; color: var(--ink-dark); }
.compare-col ul { list-style: none; }
.compare-col li { font-size: 14px; line-height: 1.7; color: var(--text-main); padding: 6px 0 6px 22px; position: relative; }
.compare-col li::before {
  content: ''; position: absolute; left: 2px; top: 14px;
  width: 7px; height: 7px; border-radius: 50%; background: var(--text-sub); opacity: 0.6;
}
.compare-col.primary {
  background: var(--paper-card);
  border: 1.5px solid var(--brand-purple);
  box-shadow: 0 2px 4px rgba(61,47,20,.06), 0 12px 28px rgba(83,58,253,.14);
}
.compare-col.primary h3 { color: var(--brand-purple); }
.compare-col.primary li { font-weight: 500; }
.compare-col.primary li::before {
  content: '✓'; background: none; opacity: 1;
  left: 0; top: 6px; width: auto; height: auto;
  color: var(--brand-purple); font-weight: 700; font-size: 14px;
}

/* ========== 6. 登录卡片区 ========== */
.login-section {
  padding: 24px 28px 72px;
  display: flex; flex-direction: column; align-items: center;
}

/* 登录卡片：白纸片 + 底部错位纸层 */
.login-card {
  background: var(--paper-card); border-radius: 10px; padding: 44px 40px;
  text-align: center; max-width: 420px; width: 90%;
  border: 1px solid var(--paper-edge);
  box-shadow: var(--paper-shadow-lg);
  position: relative;
  z-index: 1;
}
.login-card::before {
  content: '';
  position: absolute; inset: 0; z-index: -1;
  background: var(--paper-layer);
  border: 1px solid var(--paper-edge);
  border-radius: inherit;
  transform: rotate(0.9deg) translate(-4px, 6px);
}
.seal-logo {
  display: flex; justify-content: center;
  margin-bottom: 14px;
  filter: drop-shadow(0 3px 6px rgba(196, 64, 43, 0.3));
}
.login-card h1 { font-size: 27px; margin-bottom: 6px; color: var(--ink-dark); font-weight: 700; letter-spacing: 0.04em; }
.subtitle { color: var(--text-sub); margin-bottom: 16px; font-size: 14px; }
.login-card .paper-divider { margin-bottom: 24px; }

.tab-bar { display: flex; border-radius: 6px; border: 1px solid var(--paper-edge); margin-bottom: 24px; background: var(--paper-layer); padding: 3px; gap: 3px; }
.tab-bar button {
  flex: 1; padding: 9px; border: none; background: transparent; border-radius: 4px;
  cursor: pointer; font-size: 14px; color: var(--text-sub); font-weight: 500;
  transition: color .15s ease, background .15s ease, box-shadow .15s ease;
}
.tab-bar button.active { background: #fff; color: var(--brand-purple); box-shadow: var(--paper-shadow); font-weight: 600; }
.tab-bar button:disabled { opacity: 0.5; cursor: not-allowed; }

.login-form { text-align: left; }
.field { margin-bottom: 16px; }
.field label { display: block; font-size: 13px; color: var(--text-main); margin-bottom: 4px; font-weight: 500; }
.field input {
  width: 100%; padding: 10px 12px; border: 1px solid var(--paper-edge); border-radius: 6px;
  font-size: 15px; outline: none; box-sizing: border-box; color: var(--ink-dark);
  background: #fdfaf6;
  box-shadow: inset 0 1px 3px rgba(61, 47, 20, 0.08);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.field input:focus { border-color: var(--brand-purple); box-shadow: inset 0 1px 3px rgba(61, 47, 20, 0.08), 0 0 0 3px rgba(83,58,253,0.16); }
.field input::placeholder { color: var(--text-sub); }

.error-msg { color: #e53e3e; font-size: 13px; margin-bottom: 12px; text-align: center; }
.success-msg { color: #108c3d; font-size: 13px; margin-bottom: 12px; text-align: center; }

.btn-full { width: 100%; }
.btn-lg { padding: 12px 24px; font-size: 16px; border-radius: 6px; }
.btn-primary { background: var(--brand-purple); color: #fff; border: none; cursor: pointer; box-shadow: 0 1px 2px rgba(40,26,140,.2), 0 4px 10px -2px rgba(83,58,253,.35); transition: background .15s ease, box-shadow .15s ease, transform .15s ease; }
.btn-primary:hover { background: var(--primary-hover); transform: translateY(-1px); box-shadow: 0 6px 16px -2px rgba(83,58,253,.45); }
.btn-primary:active { transform: translateY(0); box-shadow: 0 1px 2px rgba(40,26,140,.2); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

/* 卡片下方版权行 */
.login-copyright { margin-top: 20px; font-size: 12px; color: var(--text-sub); text-align: center; }

/* 密码可见性切换 */
.password-wrap { position: relative; }
.password-wrap input { padding-right: 40px; }
.pwd-toggle {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  display: flex; align-items: center; padding: 4px;
  border: none; background: transparent; border-radius: 4px;
  color: var(--text-sub); cursor: pointer;
  transition: color .15s ease;
}
.pwd-toggle:hover { color: var(--brand-purple); }
.pwd-toggle:disabled { opacity: 0.5; cursor: not-allowed; }

/* 记住我 */
.remember-row {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 16px; font-size: 13px; color: var(--text-main);
  cursor: pointer; user-select: none;
}
.remember-row input { accent-color: var(--brand-purple); cursor: pointer; }

/* 演示账号一键填充（虚线纸边小按钮） */
.demo-fill {
  width: 100%; margin-top: 12px; padding: 8px;
  background: transparent; border: 1px dashed var(--paper-edge); border-radius: 6px;
  color: var(--text-sub); font-size: 13px; cursor: pointer;
  transition: color .15s ease, border-color .15s ease;
}
.demo-fill:hover { color: var(--brand-purple); border-color: var(--brand-purple); }
.demo-fill:disabled { opacity: 0.5; cursor: not-allowed; }
.demo-hint { display: block; font-size: 11px; margin-top: 2px; opacity: 0.8; }

/* ========== 7. Footer ========== */
.landing-footer {
  border-top: 1px solid var(--paper-edge);
  padding: 22px 28px;
  text-align: center;
  font-size: 12px; color: var(--text-sub);
}

/* ========== 响应式 ========== */
/* <1200px：Hero 简化——隐藏圆环预览，数据条换行 */
@media (max-width: 1200px) {
  .hero-visual { display: none; }
  .hero-inner { gap: 0; }
  .hero-copy { text-align: center; }
  .hero-cta { justify-content: center; }
}

/* <960px：单列布局，隐藏装饰，登录功能保持可用 */
@media (max-width: 960px) {
  .hl-deco { display: none; }
  .hl-grid { grid-template-columns: 1fr; gap: 20px; }
  .preview-card { grid-template-columns: 1fr; gap: 32px; padding: 28px 22px; }
  .compare-grid { grid-template-columns: 1fr; gap: 20px; }
  .hero { padding: 48px 20px 40px; }
  .highlights { padding: 48px 20px 64px; }
  .preview, .compare { padding-left: 20px; padding-right: 20px; padding-bottom: 64px; }
  .login-section { padding: 8px 16px 56px; }
  .login-card { padding: 36px 24px; width: 100%; }
  .nav-cta { display: none; }
}
</style>
