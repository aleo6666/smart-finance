<template>
  <div class="ledger-mgr">
    <button class="ledger-mgr-trigger" @click="open = !open" title="管理账本">
      📋
    </button>

    <div v-if="open" class="ledger-mgr-mask" @click="open = false" />

    <div v-if="open" class="ledger-mgr-panel" @click.stop>
      <div class="panel-hd">
        <span>📋 管理账本</span>
        <button class="panel-close" @click="open = false">✕</button>
      </div>

      <!-- 添加 -->
      <div class="add-bar">
        <select v-model="newIcon" class="icon-pick">
          <option v-for="e in icons" :key="e" :value="e">{{ e }}</option>
        </select>
        <input
          v-model.trim="newName"
          placeholder="新账本名称"
          maxlength="20"
          @keyup.enter="handleAdd"
        />
        <button class="btn-add" :disabled="!newName" @click="handleAdd">＋</button>
      </div>

      <!-- 列表 -->
      <div class="ledger-list">
        <div
          v-for="l in store.ledgers"
          :key="l.id"
          class="ledger-row"
          :class="{ current: l.id === store.selectedLedgerId }"
          @click="switchTo(l.id)"
        >
          <!-- 查看态 -->
          <template v-if="editingId !== l.id">
            <span class="l-icon">{{ l.icon || '📒' }}</span>
            <span class="l-name">{{ l.name }}</span>
            <span class="l-badge" v-if="l.id === store.selectedLedgerId">当前</span>
            <button class="l-act" title="编辑" @click.stop="startEdit(l)">✏️</button>
            <button class="l-act" title="删除" @click.stop="handleDelete(l)">🗑️</button>
          </template>
          <!-- 编辑态 -->
          <template v-else>
            <select v-model="editIcon" class="icon-pick sm">
              <option v-for="e in icons" :key="e" :value="e">{{ e }}</option>
            </select>
            <input
              v-model.trim="editName"
              class="edit-input"
              maxlength="20"
              @keyup.enter="handleSave(l)"
            />
            <button class="l-act" title="保存" @click.stop="handleSave(l)">✅</button>
            <button class="l-act" title="取消" @click.stop="editingId = null">↩️</button>
          </template>
        </div>
        <div v-if="store.ledgers.length === 0" class="empty-hint">暂无账本，创建一个吧</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useAppStore } from '../stores/app.js'
import { api } from '../utils/api.js'

const store = useAppStore()

const icons = ['📒','📕','📗','📘','📙','📓','💰','💵','💴','💶','💷','🏦','💳','🪙','📊','💼','🏠','🚗','✈️','🎓','💊','🍔','🎮','🐶']

const open = ref(false)
const newName = ref('')
const newIcon = ref('📒')

const editingId = ref(null)
const editName = ref('')
const editIcon = ref('📒')

function switchTo(id) {
  store.selectedLedgerId = id
}

async function refresh() {
  await store.loadUser()
}

async function handleAdd() {
  if (!newName.value) return
  try {
    await api.createLedger({ name: newName.value, icon: newIcon.value })
    newName.value = ''
    newIcon.value = '📒'
    await refresh()
  } catch { /* ignore */ }
}

function startEdit(l) {
  editingId.value = l.id
  editName.value = l.name
  editIcon.value = l.icon || '📒'
}

async function handleSave(l) {
  if (!editName.value) return
  try {
    await api.updateLedger(l.id, { name: editName.value, icon: editIcon.value })
    editingId.value = null
    await refresh()
  } catch { /* ignore */ }
}

async function handleDelete(l) {
  if (store.ledgers.length <= 1) return
  if (!confirm(`删除账本「${l.name}」？相关账单不会被删除。`)) return
  try {
    await api.deleteLedger(l.id)
    if (l.id === store.selectedLedgerId) {
      const rest = store.ledgers.filter(x => x.id !== l.id)
      if (rest.length > 0) store.selectedLedgerId = rest[0].id
    }
    await refresh()
  } catch { /* ignore */ }
}
</script>

<style scoped>
.ledger-mgr { position: relative; }
.ledger-mgr-trigger {
  border: none; background: transparent; font-size: 14px; cursor: pointer;
  padding: 2px 6px; border-radius: 6px; line-height: 1; opacity: 0.7;
}
.ledger-mgr-trigger:hover { opacity: 1; background: rgba(79,70,229,0.08); }
.ledger-mgr-mask { position: fixed; inset: 0; z-index: 99; }
.ledger-mgr-panel {
  position: absolute; top: calc(100% + 6px); right: 0; width: 320px; max-width: 90vw;
  background: #fff; border: 1px solid #e5e7eb; border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12); z-index: 100; overflow: hidden;
}
.panel-hd {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 16px; font-weight: 600; font-size: 14px;
  border-bottom: 1px solid #e5e7eb;
}
.panel-close { border: none; background: transparent; font-size: 16px; cursor: pointer; color: #999; padding: 2px 6px; }
.panel-close:hover { background: #f3f4f6; }
.add-bar { display: flex; gap: 6px; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
.add-bar input {
  flex: 1; min-width: 0; border: 1px solid #e5e7eb; border-radius: 6px;
  padding: 5px 8px; font-size: 13px; outline: none;
}
.add-bar input:focus { border-color: #4f46e5; }
.icon-pick { border: 1px solid #e5e7eb; border-radius: 6px; padding: 4px 2px; font-size: 16px; background: #fff; cursor: pointer; }
.icon-pick.sm { font-size: 14px; padding: 2px 2px; }
.btn-add {
  border: none; background: #4f46e5; color: #fff; font-size: 16px; font-weight: 700;
  width: 30px; height: 30px; border-radius: 6px; cursor: pointer;
}
.btn-add:disabled { opacity: 0.4; cursor: not-allowed; }
.ledger-list { max-height: 260px; overflow-y: auto; padding: 6px 0; }
.ledger-row {
  display: flex; align-items: center; gap: 6px; padding: 7px 12px;
  cursor: pointer; font-size: 13px;
}
.ledger-row:hover { background: #f9fafb; }
.ledger-row.current { background: rgba(79,70,229,0.06); }
.l-icon { font-size: 18px; flex-shrink: 0; }
.l-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.l-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #4f46e5; color: #fff; opacity: 0.7; }
.l-act { border: none; background: transparent; font-size: 13px; cursor: pointer; padding: 2px 4px; opacity: 0.5; }
.l-act:hover { opacity: 1; background: #f3f4f6; }
.edit-input { flex: 1; min-width: 0; border: 1px solid #4f46e5; border-radius: 4px; padding: 3px 6px; font-size: 13px; outline: none; }
.empty-hint { text-align: center; color: #999; font-size: 13px; padding: 24px 0; }
</style>
