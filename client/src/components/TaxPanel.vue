<template>
  <div class="report-panel">
    <!-- 错误提示 -->
    <div v-if="error" class="error-banner" style="margin-bottom: 16px;">
      {{ error }}
      <button class="btn btn-sm btn-outline" @click="loadRecords()" style="margin-left: 12px;">重试</button>
    </div>

    <div class="report-grid">
      <!-- 测算表单 -->
      <div class="report-card">
        <h3>月度个税测算</h3>
        <p class="form-tip">按年度综合所得税率月度换算估算（起征点 ¥5,000/月），年终奖单独计税。</p>
        <div class="form-row">
          <div class="form-group">
            <label>年份</label>
            <input v-model.number="form.year" type="number" min="2020" max="2100" />
          </div>
          <div class="form-group">
            <label>月份</label>
            <select v-model.number="form.month">
              <option v-for="m in 12" :key="m" :value="m">{{ m }} 月</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>税前月薪 (元)</label>
          <input v-model.number="form.income" type="number" step="0.01" placeholder="如 20000" />
        </div>
        <div class="form-group">
          <label>年终奖/一次性奖金 (元，可选)</label>
          <input v-model.number="form.bonus" type="number" step="0.01" placeholder="如 30000" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>五险一金个人部分 (元)</label>
            <input v-model.number="form.social_insurance" type="number" step="0.01" placeholder="0.00" />
          </div>
          <div class="form-group">
            <label>专项附加扣除 (元/月)</label>
            <input v-model.number="form.special_deduction" type="number" step="0.01" placeholder="0.00" />
          </div>
        </div>
        <div v-if="saveError" class="modal-error">{{ saveError }}</div>
        <button class="btn btn-primary btn-block" :disabled="calculating" @click="calculate">
          {{ calculating ? '测算中...' : '开始测算' }}
        </button>
      </div>

      <!-- 测算结果 -->
      <div class="report-card">
        <h3>测算结果</h3>
        <div v-if="result" class="result-box">
          <div class="result-main">
            <div class="result-label">实发到手</div>
            <div class="result-value num">{{ fmtMoney(result.net_income) }}</div>
          </div>
          <div class="result-rows">
            <div class="result-row">
              <span>应纳税所得额</span>
              <b class="num">{{ fmtMoney(result.taxable_income) }}</b>
            </div>
            <div class="result-row">
              <span>月度工资个税</span>
              <b class="num">{{ fmtMoney(result.monthly_tax) }}</b>
            </div>
            <div class="result-row">
              <span>年终奖个税</span>
              <b class="num">{{ fmtMoney(result.bonus_tax) }}</b>
            </div>
            <div class="result-row result-row-total">
              <span>当月合计个税</span>
              <b class="num" style="color: var(--danger);">{{ fmtMoney(result.tax_amount) }}</b>
            </div>
          </div>
        </div>
        <div v-else class="empty-state" style="padding: 60px 20px;">
          <p>填写左侧表单后开始测算</p>
        </div>
      </div>
    </div>

    <!-- 历史记录 -->
    <div class="report-card" style="margin-top: 20px;">
      <h3>历史测算记录</h3>
      <template v-if="records.length">
        <div class="rec-head">
          <span>年月</span><span>收入</span><span>奖金</span><span>个税</span><span>实发</span><span></span>
        </div>
        <div v-for="r in records" :key="r.id" class="rec-row">
          <span class="num rec-date">{{ r.year }}.{{ String(r.month).padStart(2, '0') }}</span>
          <span class="num">{{ fmtMoney(r.income) }}</span>
          <span class="num">{{ r.bonus ? fmtMoney(r.bonus) : '—' }}</span>
          <span class="num" style="color: var(--danger);">{{ fmtMoney(r.tax_amount) }}</span>
          <span class="num">{{ fmtMoney(r.net_income) }}</span>
          <button class="btn btn-sm btn-outline" style="color: var(--danger);" @click="removeRecord(r)">删除</button>
        </div>
      </template>
      <div v-else class="empty-state" style="padding: 40px 20px;">
        <p>暂无测算记录</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'
import { api } from '../utils/api.js'

const store = useAppStore()
const router = useRouter()

const error = ref('')
const records = ref([])
const result = ref(null)
const calculating = ref(false)
const saveError = ref('')
const now = new Date()
const form = ref({
  year: now.getFullYear(),
  month: now.getMonth() + 1,
  income: null,
  bonus: null,
  social_insurance: 0,
  special_deduction: 0
})

function fmtMoney(n) {
  const v = Number(n) || 0
  return '¥' + v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

onMounted(async () => {
  if (!store.token) { router.push('/login'); return }
  await loadRecords()
})

async function loadRecords() {
  error.value = ''
  try {
    const res = await api.getTaxRecords()
    if (res && res.success === false && res.error === '登录已过期') {
      store.logout(); router.push('/login'); return
    }
    if (res && res.success) {
      records.value = res.data || []
    } else {
      error.value = (res && res.error) || '记录加载失败'
    }
  } catch (e) {
    error.value = '网络错误，请检查连接后重试'
  }
}

async function calculate() {
  if (form.value.income === '' || form.value.income === null || !Number.isFinite(Number(form.value.income)) || Number(form.value.income) < 0) {
    saveError.value = '请输入有效的税前月薪'
    return
  }
  calculating.value = true
  saveError.value = ''
  try {
    const res = await api.calculateTax({
      year: form.value.year,
      month: form.value.month,
      income: Number(form.value.income),
      bonus: form.value.bonus === '' || form.value.bonus === null ? 0 : Number(form.value.bonus),
      social_insurance: form.value.social_insurance === '' || form.value.social_insurance === null ? 0 : Number(form.value.social_insurance),
      special_deduction: form.value.special_deduction === '' || form.value.special_deduction === null ? 0 : Number(form.value.special_deduction)
    })
    if (res && res.success === false) {
      saveError.value = res.error || '测算失败'
      return
    }
    if (res && res.success) {
      result.value = res.data
      await loadRecords()
    }
  } catch (e) {
    saveError.value = '网络错误，测算失败'
  } finally {
    calculating.value = false
  }
}

async function removeRecord(r) {
  if (!window.confirm(`确定删除 ${r.year} 年 ${r.month} 月的记录吗？`)) return
  try {
    const res = await api.deleteTaxRecord(r.id)
    if (res && res.success === false) {
      error.value = res.error || '删除失败'
      return
    }
    await loadRecords()
  } catch (e) {
    error.value = '网络错误，删除失败'
  }
}
</script>

<style scoped>
.form-tip {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 0 0 16px;
}
.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }
.btn-block { width: 100%; margin-top: 8px; }
.result-box { margin-top: 4px; }
.result-main {
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
  padding: 18px 20px;
  text-align: center;
}
.result-label { font-size: 13px; color: var(--text-secondary); }
.result-value {
  font-size: 34px;
  font-weight: 300;
  color: var(--text-title);
  margin-top: 6px;
  letter-spacing: -0.02em;
}
.result-rows { margin-top: 16px; }
.result-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--text-secondary);
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}
.result-row-total {
  border-bottom: none;
  padding-top: 10px;
  font-weight: 600;
}
.result-row-total span { color: var(--text-title); }
.rec-head,
.rec-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr 1fr 56px;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--border);
}
.rec-head {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  border-bottom-color: var(--border);
}
.rec-row:last-child { border-bottom: none; }
.rec-date { font-weight: 600; color: var(--text-title); }
.modal-error {
  color: var(--danger);
  font-size: 13px;
  margin-top: 8px;
}
</style>
