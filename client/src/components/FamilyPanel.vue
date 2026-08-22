<template>
  <div class="report-panel">
    <!-- 错误提示 -->
    <div v-if="error" class="error-banner" style="margin-bottom: 16px;">
      {{ error }}
      <button class="btn btn-sm btn-outline" @click="loadAll()" style="margin-left: 12px;">重试</button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="empty-state">
      <p>加载中...</p>
    </div>

    <template v-if="!loading">
      <div class="report-grid">
        <!-- 我的家庭 -->
        <div class="report-card">
          <div class="card-head">
            <h3>我的家庭</h3>
            <button class="btn btn-sm btn-primary" @click="openCreateTeam">+ 创建家庭</button>
          </div>

          <!-- 加入家庭 -->
          <div class="join-box">
            <input v-model.trim="inviteCode" placeholder="输入邀请码加入家庭" style="flex: 1;" @keyup.enter="joinTeam" />
            <button class="btn btn-outline" :disabled="joining" @click="joinTeam">{{ joining ? '加入中...' : '加入' }}</button>
          </div>

          <template v-if="teams.length">
            <div v-for="t in teams" :key="t.id" class="team-row" :class="{ active: selectedTeamId === t.id }" @click="selectTeam(t)">
              <div class="team-info">
                <div class="team-name">
                  {{ t.name }}
                  <span v-if="t.role === 'owner'" class="team-role">创建者</span>
                  <span v-else class="team-role member">成员</span>
                </div>
                <div class="team-sub">{{ t.member_count }} 位成员</div>
                <div class="team-code">邀请码 {{ t.invite_code }}</div>
              </div>
            </div>
          </template>
          <div v-else class="empty-state" style="padding: 30px 20px;">
            <p>还没有家庭</p>
            <p style="font-size: 12px;">创建家庭后可与家人共享账本</p>
          </div>
        </div>

        <!-- 家庭详情 -->
        <div class="report-card">
          <div class="card-head">
            <h3>{{ detailTeam ? detailTeam.name : '家庭详情' }}</h3>
            <button v-if="detailTeam && detailTeam.role === 'owner'" class="btn btn-sm btn-outline" style="color: var(--danger);" @click="disband">解散家庭</button>
          </div>

          <template v-if="detailTeam">
            <div class="invite-line">
              <span>邀请码</span>
              <b class="num">{{ detailTeam.invite_code }}</b>
              <button class="btn btn-sm btn-outline" @click="copyInvite">复制</button>
            </div>

            <h4 class="section-title">成员（{{ members.length }}）</h4>
            <div v-for="m in members" :key="m.user_id" class="member-row">
              <div class="member-avatar">{{ (m.nickname || m.email || '?')[0].toUpperCase() }}</div>
              <div class="member-info">
                <div class="member-name">{{ m.nickname || '未设置昵称' }} <span class="member-role">{{ m.role === 'owner' ? '创建者' : '成员' }}</span></div>
                <div class="member-mail">{{ m.email }}</div>
              </div>
              <button v-if="detailTeam.role === 'owner' && m.role !== 'owner'" class="btn btn-sm btn-outline" style="color: var(--danger);" @click="removeMember(m)">移除</button>
            </div>

            <div v-if="detailTeam.role === 'owner'" class="add-member">
              <input v-model.trim="addEmail" placeholder="按邮箱添加成员" style="flex: 1;" @keyup.enter="addMember" />
              <button class="btn btn-primary" :disabled="addingMember" @click="addMember">{{ addingMember ? '添加中...' : '添加' }}</button>
            </div>
          </template>
          <div v-else class="empty-state" style="padding: 60px 20px;">
            <p>选择左侧家庭查看成员</p>
          </div>
        </div>
      </div>

      <!-- 共享账本 -->
      <div class="report-card" style="margin-top: 20px;">
        <div class="card-head">
          <h3>共享账本</h3>
          <button v-if="canShare" class="btn btn-sm btn-primary" @click="openShareLedger">+ 共享账本</button>
        </div>

        <template v-if="sharedLedgers.length">
          <div v-for="sl in sharedLedgers" :key="sl.member_id" class="share-row">
            <div class="share-info" @click="viewRecords(sl)">
              <div class="share-name">{{ sl.ledger_name }}</div>
              <div class="share-sub">共享至「{{ sl.team_name }}」</div>
            </div>
            <div class="share-actions">
              <button class="btn btn-sm btn-outline" @click="viewRecords(sl)">查看记录</button>
              <button class="btn btn-sm btn-outline" style="color: var(--danger);" @click="unshare(sl)">取消共享</button>
            </div>
          </div>
        </template>
        <div v-else class="empty-state" style="padding: 30px 20px;">
          <p>还没有共享账本</p>
          <p style="font-size: 12px;">把你的账本共享给家庭，成员即可查看</p>
        </div>

        <!-- 共享记录查看 -->
        <template v-if="activeLedger">
          <h4 class="section-title" style="margin-top: 20px;">
            「{{ activeLedger.ledger_name }}」最近流水
            <button class="btn btn-sm btn-outline" style="margin-left: 8px;" @click="activeLedger = null">收起</button>
          </h4>
          <div v-if="recordsLoading" class="empty-state" style="padding: 20px;">
            <p>加载中...</p>
          </div>
          <template v-else-if="records.length">
            <div class="rec-head">
              <span>类型</span><span>分类</span><span>金额</span><span>备注</span><span>时间</span>
            </div>
            <div v-for="r in records" :key="r.id" class="rec-row">
              <span>{{ r.type === 'expense' ? '支出' : '收入' }}</span>
              <span>{{ r.category }}</span>
              <span class="num" :class="r.type === 'expense' ? 'expense' : 'income'">{{ r.type === 'expense' ? '-' : '+' }}{{ fmtMoney(r.amount) }}</span>
              <span>{{ r.note || '—' }}</span>
              <span class="rec-time">{{ fmtTime(r.occurred_at) }}</span>
            </div>
          </template>
          <div v-else class="empty-state" style="padding: 20px;">
            <p>该账本暂无流水</p>
          </div>
        </template>
      </div>
    </template>

    <!-- 创建家庭弹层 -->
    <div class="modal-overlay" v-if="showCreate" @click.self="showCreate = false">
      <div class="modal">
        <h2>创建家庭</h2>
        <div class="form-group">
          <label>家庭名称</label>
          <input v-model.trim="newTeamName" placeholder="如：我的小家" />
        </div>
        <div v-if="saveError" class="modal-error">{{ saveError }}</div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showCreate = false">取消</button>
          <button class="btn btn-primary" :disabled="creating" @click="createTeam">{{ creating ? '创建中...' : '创建' }}</button>
        </div>
      </div>
    </div>

    <!-- 共享账本弹层 -->
    <div class="modal-overlay" v-if="showShare" @click.self="showShare = false">
      <div class="modal">
        <h2>共享账本到家庭</h2>
        <div class="form-group">
          <label>选择家庭</label>
          <select v-model="shareForm.teamId">
            <option v-for="t in teams" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>选择账本</label>
          <select v-model="shareForm.ledgerId">
            <option v-for="l in ledgers" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </div>
        <div v-if="saveError" class="modal-error">{{ saveError }}</div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showShare = false">取消</button>
          <button class="btn btn-primary" :disabled="sharing" @click="shareLedgerAction">{{ sharing ? '共享中...' : '确认共享' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app.js'
import { api } from '../utils/api.js'

const store = useAppStore()
const router = useRouter()

const loading = ref(true)
const error = ref('')
const teams = ref([])
const sharedLedgers = ref([])
const selectedTeamId = ref(null)
const detailTeam = ref(null)
const members = ref([])
const ledgers = ref([])
const activeLedger = ref(null)
const records = ref([])
const recordsLoading = ref(false)

const inviteCode = ref('')
const joining = ref(false)
const addEmail = ref('')
const addingMember = ref(false)
const newTeamName = ref('')
const creating = ref(false)
const sharing = ref(false)
const saveError = ref('')
const showCreate = ref(false)
const showShare = ref(false)
const shareForm = ref({ teamId: null, ledgerId: null })

const canShare = computed(() => teams.value.length > 0)

function fmtMoney(n) {
  const v = Number(n) || 0
  return '¥' + v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtTime(t) {
  if (!t) return ''
  return String(t).slice(0, 16).replace('T', ' ')
}

onMounted(async () => {
  if (!store.token) { router.push('/login'); return }
  await loadAll()
})

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const [resTeams, resLedgers, resShares] = await Promise.all([
      api.getFamilyTeams(),
      api.getLedgers(),
      api.getSharedLedgers()
    ])
    if (resTeams && resTeams.success === false && resTeams.error === '登录已过期') {
      store.logout(); router.push('/login'); return
    }
    if (resTeams && resTeams.success) teams.value = resTeams.data || []
    if (resLedgers && resLedgers.success) {
      const d = resLedgers.data || {}
      ledgers.value = d.ledgers || (Array.isArray(d) ? d : [])
    }
    if (resShares && resShares.success) sharedLedgers.value = resShares.data || []
    if (teams.value.length && !selectedTeamId.value) {
      await selectTeam(teams.value[0])
    } else if (selectedTeamId.value) {
      await refreshDetail()
    }
  } catch (e) {
    error.value = '网络错误，请检查连接后重试'
  } finally {
    loading.value = false
  }
}

async function selectTeam(t) {
  selectedTeamId.value = t.id
  await refreshDetail()
}

async function refreshDetail() {
  if (!selectedTeamId.value) return
  try {
    const res = await api.getFamilyTeamDetail(selectedTeamId.value)
    if (res && res.success) {
      detailTeam.value = res.data.team
      members.value = res.data.members || []
    }
  } catch (e) {
    error.value = '家庭详情加载失败'
  }
}

function openCreateTeam() {
  saveError.value = ''
  newTeamName.value = ''
  showCreate.value = true
}

async function createTeam() {
  if (!newTeamName.value.trim()) { saveError.value = '请输入家庭名称'; return }
  creating.value = true
  saveError.value = ''
  try {
    const res = await api.createFamilyTeam({ name: newTeamName.value.trim() })
    if (res && res.success === false) {
      saveError.value = res.error || '创建失败'
      return
    }
    showCreate.value = false
    newTeamName.value = ''
    await loadAll()
  } catch (e) {
    saveError.value = '网络错误，创建失败'
  } finally {
    creating.value = false
  }
}

async function joinTeam() {
  if (!inviteCode.value.trim()) return
  joining.value = true
  error.value = ''
  try {
    const res = await api.joinFamilyTeam(inviteCode.value.trim())
    if (res && res.success === false) {
      error.value = res.error || '加入失败'
      return
    }
    inviteCode.value = ''
    await loadAll()
  } catch (e) {
    error.value = '网络错误，加入失败'
  } finally {
    joining.value = false
  }
}

async function addMember() {
  if (!addEmail.value.trim()) return
  addingMember.value = true
  error.value = ''
  try {
    const res = await api.addFamilyMember(selectedTeamId.value, addEmail.value.trim())
    if (res && res.success === false) {
      error.value = res.error || '添加失败'
      return
    }
    addEmail.value = ''
    await refreshDetail()
  } catch (e) {
    error.value = '网络错误，添加失败'
  } finally {
    addingMember.value = false
  }
}

async function removeMember(m) {
  if (!window.confirm(`确定移除成员 ${m.nickname || m.email} 吗？`)) return
  try {
    const res = await api.removeFamilyMember(selectedTeamId.value, m.id)
    if (res && res.success === false) {
      error.value = res.error || '移除失败'
      return
    }
    await refreshDetail()
  } catch (e) {
    error.value = '网络错误，移除失败'
  }
}

async function disband() {
  if (!window.confirm('解散家庭后，所有成员关系和共享账本将被解除，确定吗？')) return
  try {
    const res = await api.disbandFamilyTeam(selectedTeamId.value)
    if (res && res.success === false) {
      error.value = res.error || '解散失败'
      return
    }
    selectedTeamId.value = null
    detailTeam.value = null
    members.value = []
    await loadAll()
  } catch (e) {
    error.value = '网络错误，解散失败'
  }
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(detailTeam.value.invite_code)
    error.value = ''
    window.alert('邀请码已复制')
  } catch (e) {
    error.value = '复制失败，请手动复制'
  }
}

function openShareLedger() {
  saveError.value = ''
  shareForm.value = { teamId: teams.value[0] ? teams.value[0].id : null, ledgerId: ledgers.value[0] ? ledgers.value[0].id : null }
  showShare.value = true
}

async function shareLedgerAction() {
  if (!shareForm.value.teamId || !shareForm.value.ledgerId) {
    saveError.value = '请选择家庭和账本'
    return
  }
  sharing.value = true
  saveError.value = ''
  try {
    const res = await api.shareLedger(shareForm.value.teamId, shareForm.value.ledgerId)
    if (res && res.success === false) {
      saveError.value = res.error || '共享失败'
      return
    }
    showShare.value = false
    await loadAll()
  } catch (e) {
    saveError.value = '网络错误，共享失败'
  } finally {
    sharing.value = false
  }
}

async function unshare(sl) {
  if (!window.confirm(`确定取消共享「${sl.ledger_name}」吗？`)) return
  try {
    const res = await api.unshareLedger(sl.member_id)
    if (res && res.success === false) {
      error.value = res.error || '取消失败'
      return
    }
    if (activeLedger.value && activeLedger.value.member_id === sl.member_id) {
      activeLedger.value = null
      records.value = []
    }
    await loadAll()
  } catch (e) {
    error.value = '网络错误，取消失败'
  }
}

async function viewRecords(sl) {
  activeLedger.value = sl
  recordsLoading.value = true
  records.value = []
  try {
    const res = await api.getSharedLedgerRecords(sl.ledger_id, 50)
    if (res && res.success === false) {
      error.value = res.error || '流水加载失败'
      return
    }
    records.value = (res && res.data) || []
  } catch (e) {
    error.value = '网络错误，流水加载失败'
  } finally {
    recordsLoading.value = false
  }
}
</script>

<style scoped>
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.join-box {
  display: flex;
  gap: 8px;
  margin: 14px 0;
}
.join-box input,
.add-member input {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-size: 13px;
  background: var(--bg-card);
  color: var(--text-title);
  min-width: 0;
}
.team-row {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  margin-bottom: 10px;
  cursor: pointer;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.team-row:hover { box-shadow: var(--shadow-sm); }
.team-row.active {
  border-color: var(--primary);
  background: var(--primary-soft);
}
.team-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-title);
}
.team-role {
  display: inline-block;
  font-size: 11px;
  color: var(--primary);
  background: var(--primary-soft);
  border-radius: 999px;
  padding: 1px 8px;
  margin-left: 6px;
}
.team-role.member { color: var(--text-secondary); background: var(--bg-track); }
.team-sub { font-size: 12px; color: var(--text-secondary); margin-top: 3px; }
.team-code { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.invite-line {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  font-size: 13px;
  color: var(--text-secondary);
}
.invite-line b { color: var(--text-title); letter-spacing: 1px; }
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 18px 0 6px;
}
.member-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.member-row:last-child { border-bottom: none; }
.member-avatar {
  flex: 0 0 34px;
  width: 34px;
  height: 34px;
  line-height: 34px;
  text-align: center;
  border-radius: 50%;
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 600;
  font-size: 14px;
}
.member-info { flex: 1; min-width: 0; }
.member-name { font-size: 14px; font-weight: 600; color: var(--text-title); }
.member-role {
  display: inline-block;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-track);
  border-radius: 999px;
  padding: 1px 8px;
  margin-left: 6px;
}
.member-mail { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.add-member {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.share-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 4px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.share-row:last-child { border-bottom: none; }
.share-info { flex: 1; min-width: 0; cursor: pointer; }
.share-name { font-size: 14px; font-weight: 600; color: var(--text-title); }
.share-sub { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.share-actions { display: flex; gap: 8px; }
.rec-head,
.rec-row {
  display: grid;
  grid-template-columns: 64px 1fr 1fr 1.4fr 1fr;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--border);
}
.rec-head { color: var(--text-secondary); font-size: 12px; font-weight: 600; }
.rec-row:last-child { border-bottom: none; }
.expense { color: var(--success); }
.income { color: var(--danger); }
.rec-time { font-size: 12px; color: var(--text-secondary); }
.modal-error { color: var(--danger); font-size: 13px; margin-top: 8px; }
</style>
