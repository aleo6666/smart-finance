<template>
  <div class="import-page">
    <div class="page-header">
      <h2>📥 账单导入</h2>
      <p class="desc">支持微信、支付宝、随手记等平台账单导入，人工确认后入库</p>
    </div>

    <!-- 上传区域 -->
    <div class="upload-section" v-if="!currentBatch">
      <div class="upload-card">
        <div
          class="drop-zone"
          :class="{ dragging: isDragging }"
          @dragover.prevent="isDragging = true"
          @dragleave="isDragging = false"
          @drop.prevent="handleDrop"
          @click="$refs.fileInput.click()"
        >
          <input ref="fileInput" type="file" accept=".csv,.txt,.xlsx" hidden @change="handleFileSelect" />
          <div class="upload-icon">📁</div>
          <div class="upload-title">点击或拖拽文件到此处</div>
          <div class="upload-hint">支持微信/支付宝账单、通用 CSV、Excel/WPS (.xlsx)</div>
        </div>

        <div class="divider"><span>或</span></div>

        <div class="paste-section">
          <textarea
            v-model="pasteContent"
            class="paste-input"
            placeholder="粘贴账单文本内容..."
            rows="5"
          ></textarea>
          <button class="btn btn-primary" @click="handlePasteImport" :disabled="!pasteContent.trim()">
            解析粘贴内容
          </button>
        </div>
      </div>

      <!-- 导入历史 -->
      <div class="history-card" v-if="batchHistory.length > 0">
        <h3>📋 导入历史</h3>
        <div class="history-list">
          <div
            v-for="batch in batchHistory"
            :key="batch.id"
            class="history-item"
            @click="loadBatch(batch.id)"
          >
            <div class="history-info">
              <span class="history-name">{{ batch.fileName }}</span>
              <span class="history-source">{{ sourceLabel(batch.sourceType) }}</span>
            </div>
            <div class="history-meta">
              <span class="history-count">{{ batch.importedCount || batch.validCount }} 条</span>
              <span class="status-tag" :class="batch.status">{{ statusLabel(batch.status) }}</span>
            </div>
            <div class="history-time">{{ formatTime(batch.createdAt) }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 预览确认区域 -->
    <div class="preview-section" v-if="currentBatch">
      <div class="preview-header">
        <button class="btn btn-outline btn-sm" @click="backToList">← 返回</button>
        <h3>{{ currentBatch.fileName }}</h3>
        <span class="source-badge">{{ sourceLabel(currentBatch.sourceType) }}</span>
      </div>

      <!-- 统计概览 -->
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-num">{{ currentBatch.totalCount }}</div>
          <div class="stat-label">总记录</div>
        </div>
        <div class="stat-card success">
          <div class="stat-num">{{ currentBatch.validCount }}</div>
          <div class="stat-label">有效记录</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-num">{{ currentBatch.duplicateCount }}</div>
          <div class="stat-label">疑似重复</div>
        </div>
        <div class="stat-card primary">
          <div class="stat-num">{{ selectedCount }}</div>
          <div class="stat-label">将导入</div>
        </div>
      </div>

      <!-- 操作栏 -->
      <div class="action-bar" v-if="currentBatch.status === 'preview'">
        <div class="action-left">
          <button class="btn btn-sm" @click="selectAllMatching">全选所有匹配</button>
          <button class="btn btn-sm" @click="deselectAll">全不选</button>
          <button class="btn btn-sm" @click="selectNonDuplicate">仅选非重复</button>
        </div>
        <div class="action-right">
          <span class="selected-count">已选 {{ selectedCount }} 条</span>
          <button class="btn btn-primary" @click="confirmImport" :disabled="selectedCount === 0 || importing">
            {{ importing ? '导入中...' : '✓ 确认导入' }}
          </button>
        </div>
      </div>

      <!-- 筛选 Tab -->
      <div class="filter-tabs" v-if="currentBatch.status === 'preview' && allRecords.length > 0">
        <button v-for="tab in filterTabs" :key="tab.key" class="filter-tab" :class="{ active: filterTab === tab.key }" @click="switchFilter(tab.key)">
          {{ tab.label }} <span class="filter-count">{{ tab.count }}</span>
        </button>
      </div>

      <!-- 已导入状态提示 -->
      <div class="status-banner imported" v-if="currentBatch.status === 'imported'">
        ✅ 已成功导入 {{ currentBatch.importedCount }} 条记录
        <button class="btn btn-outline btn-sm ml-10" @click="rollbackBatch" :disabled="rollingBack">
          {{ rollingBack ? '回滚中...' : '撤销导入' }}
        </button>
      </div>
      <div class="status-banner rolled_back" v-if="currentBatch.status === 'rolled_back'">
        ↩️ 该批次已回滚
      </div>

      <!-- 明细列表 -->

      <!-- 顶部分页 -->
      <div class="pagination pagination-top" v-if="totalPages > 1">
        <button :disabled="currentPage <= 1" @click="currentPage--">‹ 上一页</button>
        <span class="page-info">{{ currentPage }} / {{ totalPages }}（共 {{ filteredRecords.length }} 条）</span>
        <button :disabled="currentPage >= totalPages" @click="currentPage++">下一页 ›</button>
      </div>

      <div class="records-table">
        <div v-if="currentBatch.totalCount > 0 && pagedRecords.length === 0 && filterTab === 'all'" class="empty-parse-warning">
          ⚠️ 解析失败：此文件可能使用了不支持的编码格式。请尝试用 Excel / WPS 重新保存为 "CSV UTF-8" 格式后再次导入。
        </div>
        <div v-else-if="allRecords.length === 0 && currentBatch.status !== 'preview'" class="empty-parse-warning" style="background:#f3f4f6;color:#6b7280">
          暂无记录
        </div>
        <div class="table-scroll" v-else>
        <table>
          <thead>
            <tr>
              <th style="width:40px">
                <input type="checkbox" :checked="isPageAllSelected" @change="togglePageSelect" v-if="currentBatch.status === 'preview'" />
              </th>
              <th>日期</th>
              <th>类型</th>
              <th>分类</th>
              <th>金额</th>
              <th>商家/描述</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in pagedRecords" :key="record.id" :class="{ duplicate: record.isDuplicate }">
              <td>
                <input
                  type="checkbox"
                  :checked="record.selected"
                  @change="toggleRecord(record)"
                  :disabled="currentBatch.status !== 'preview'"
                  v-if="currentBatch.status === 'preview'"
                />
                <span v-else>-</span>
              </td>
              <td>{{ formatDate(record.date) }}</td>
              <td>
                <span :class="['type-tag', record.type]">{{ record.type === 'income' ? '收入' : '支出' }}</span>
              </td>
              <td>
                <span v-if="editingId !== record.id" @dblclick="startEdit(record)" class="editable">
                  {{ record.category }}
                </span>
                <input
                  v-else
                  v-model="editValue"
                  @blur="saveEdit(record)"
                  @keyup.enter="saveEdit(record)"
                  class="edit-input"
                  ref="editInput"
                />
              </td>
              <td class="amount">¥{{ Number(record.amount).toFixed(2) }}</td>
              <td class="desc-cell">
                <div class="merchant">{{ record.merchant || '-' }}</div>
                <div class="desc">{{ record.description || '' }}</div>
              </td>
              <td>
                <span v-if="record.isDuplicate" class="dup-tag" :title="'相似度 ' + (record.similarity * 100).toFixed(0) + '%'">
                  ⚠️ 疑似重复
                </span>
                <span v-else-if="record.status === 'imported'" class="imported-tag">已入库</span>
                <span v-else-if="record.status === 'rolled_back'" class="rollback-tag">已回滚</span>
                <span v-else class="pending-tag">待确认</span>
              </td>
            </tr>
          </tbody>
        </table>
        </div>

        <!-- 底部分页 -->
        <div class="pagination" v-if="totalPages > 1">
          <button :disabled="currentPage <= 1" @click="currentPage--">‹ 上一页</button>
          <span class="page-info">{{ currentPage }} / {{ totalPages }}</span>
          <button :disabled="currentPage >= totalPages" @click="currentPage++">下一页 ›</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { api } from '../utils/api.js'
import { useAppStore } from '../stores/app.js'

const PAGE_SIZE = 20
const store = useAppStore()

const isDragging = ref(false)
const pasteContent = ref('')
const currentBatch = ref(null)
const batchHistory = ref([])
const importing = ref(false)
const rollingBack = ref(false)
const editingId = ref(null)
const editValue = ref('')
const currentPage = ref(1)
const filterTab = ref('all')

// ---- 全部记录 ----

const allRecords = computed(() => {
  return currentBatch.value?.records || []
})

// ---- 筛选 ----

const filterTabs = computed(() => {
  const records = allRecords.value
  const all = records.length
  const selected = records.filter(r => r.selected).length
  const unselected = records.filter(r => !r.selected).length
  const dup = records.filter(r => r.isDuplicate).length
  return [
    { key: 'all', label: '全部', count: all },
    { key: 'selected', label: '已选', count: selected },
    { key: 'unselected', label: '未选', count: unselected },
    { key: 'duplicate', label: '疑似重复', count: dup }
  ]
})

const filteredRecords = computed(() => {
  const records = allRecords.value
  switch (filterTab.value) {
    case 'selected':   return records.filter(r => r.selected)
    case 'unselected': return records.filter(r => !r.selected)
    case 'duplicate':  return records.filter(r => r.isDuplicate)
    default:           return records
  }
})

// ---- 分页 ----

const totalPages = computed(() => Math.max(1, Math.ceil(filteredRecords.value.length / PAGE_SIZE)))

const pagedRecords = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return filteredRecords.value.slice(start, start + PAGE_SIZE)
})

const isPageAllSelected = computed(() => {
  const page = pagedRecords.value
  if (page.length === 0) return false
  return page.every(r => r.selected)
})

// ---- 全局选中统计 ----

const selectedCount = computed(() => {
  return allRecords.value.filter(r => r.selected).length
})

// ---- 切换筛选时回到第 1 页 ----

function switchFilter(key) {
  filterTab.value = key
  currentPage.value = 1
}

watch(filterTab, () => { currentPage.value = 1 })
watch(totalPages, (tp) => { if (currentPage.value > tp) currentPage.value = tp })

// ---- 文件上传 ----

function handleFileSelect(e) {
  const file = e.target.files?.[0]
  if (file) uploadFile(file)
}

function handleDrop(e) {
  isDragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) uploadFile(file)
}

async function uploadFile(file) {
  try {
    const res = await api.importUploadFile(file, store.selectedLedgerId)
    if (res.success) {
      currentBatch.value = res.data
      currentPage.value = 1
      filterTab.value = 'all'
    }
  } catch (e) {
    alert('上传失败: ' + (e.message || e))
  }
}

// ---- 粘贴导入 ----

async function handlePasteImport() {
  try {
    const res = await api.importPaste(pasteContent.value, store.selectedLedgerId)
    if (res.success) {
      currentBatch.value = res.data
      pasteContent.value = ''
      currentPage.value = 1
      filterTab.value = 'all'
    }
  } catch (e) {
    alert('解析失败: ' + (e.message || e))
  }
}

// ---- 选中操作 ----

function toggleRecord(record) {
  record.selected = !record.selected
}

// 切换当前页全选/全不选
function togglePageSelect() {
  const target = !isPageAllSelected.value
  pagedRecords.value.forEach(r => r.selected = target)
}

// 全选所有匹配筛选条件的记录
function selectAllMatching() {
  filteredRecords.value.forEach(r => r.selected = true)
}

// 全不选（全部记录）
function deselectAll() {
  allRecords.value.forEach(r => r.selected = false)
}

// 仅选非重复（全部记录）
function selectNonDuplicate() {
  allRecords.value.forEach(r => {
    r.selected = !r.isDuplicate
  })
}

// ---- 编辑分类 ----

function startEdit(record) {
  editingId.value = record.id
  editValue.value = record.category
}

async function saveEdit(record) {
  const newCategory = editValue.value.trim()
  if (newCategory && newCategory !== record.category) {
    try {
      await api.updateImportRecord(currentBatch.value.id, record.id, {
        category: newCategory
      })
      record.category = newCategory
    } catch (e) {
      console.warn('修改失败', e)
    }
  }
  editingId.value = null
}

// ---- 确认导入 ----

async function confirmImport() {
  if (!confirm(`确认导入 ${selectedCount.value} 条记录？`)) return

  importing.value = true
  try {
    const selectedIds = allRecords.value.filter(r => r.selected).map(r => r.id)
    const res = await api.confirmImport(currentBatch.value.id, selectedIds)
    if (res.success) {
      await loadBatch(currentBatch.value.id)
      await Promise.all([store.refreshToday(), store.refreshMonthly()])
      alert(`成功导入 ${res.data.importedCount} 条记录`)
    }
  } catch (e) {
    alert('导入失败: ' + (e.message || e))
  } finally {
    importing.value = false
  }
}

// ---- 回滚 ----

async function rollbackBatch() {
  if (!confirm('确认撤销本次导入？所有导入的记录将被删除。')) return

  rollingBack.value = true
  try {
    const res = await api.rollbackImport(currentBatch.value.id)
    if (res.success) {
      await loadBatch(currentBatch.value.id)
      await Promise.all([store.refreshToday(), store.refreshMonthly()])
      alert('已撤销导入')
    }
  } catch (e) {
    alert('回滚失败: ' + (e.message || e))
  } finally {
    rollingBack.value = false
  }
}

// ---- 加载批次 & 历史 ----

async function loadBatch(id) {
  try {
    const res = await api.getImportBatch(id)
    if (res.success) {
      currentBatch.value = res.data
      currentPage.value = 1
      filterTab.value = 'all'
    }
  } catch (e) {
    console.warn('加载批次失败', e)
  }
}

async function loadHistory() {
  try {
    const res = await api.getImportBatches(1, 10)
    if (res.success) {
      batchHistory.value = res.data.list
    }
  } catch (e) {
    console.warn('加载历史失败', e)
  }
}

function backToList() {
  currentBatch.value = null
  loadHistory()
}

// ---- 工具函数 ----

function sourceLabel(type) {
  const map = { wechat: '微信账单', alipay: '支付宝账单', excel: 'Excel表格', generic: '通用CSV', unknown: '未知格式' }
  return map[type] || type
}

function statusLabel(status) {
  const map = { preview: '预览中', imported: '已导入', rolled_back: '已回滚', failed: '失败' }
  return map[status] || status
}

function formatTime(date) {
  if (!date) return ''
  const d = new Date(date)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatDate(date) {
  if (!date) return '-'
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

onMounted(() => {
  loadHistory()
})
</script>

<style scoped>
.import-page {
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 24px;
}
.page-header h2 {
  margin: 0 0 8px;
  font-size: 24px;
}
.desc {
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
}

/* 上传区域 */
.upload-section {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 24px;
}

.upload-card, .history-card {
  background: var(--bg-card);
  border-radius: 16px;
  padding: 24px;
  border: 1px solid var(--border);
}

.drop-zone {
  border: 2px dashed var(--border);
  border-radius: 12px;
  padding: 48px 24px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  background: var(--bg);
}
.drop-zone:hover, .drop-zone.dragging {
  border-color: var(--primary);
  background: rgba(79, 70, 229, 0.04);
}
.upload-icon {
  font-size: 48px;
  margin-bottom: 12px;
}
.upload-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}
.upload-hint {
  font-size: 13px;
  color: var(--text-secondary);
}

.divider {
  text-align: center;
  margin: 20px 0;
  position: relative;
}
.divider::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--border);
}
.divider span {
  background: var(--bg-card);
  padding: 0 12px;
  position: relative;
  color: var(--text-secondary);
  font-size: 13px;
}

.paste-input {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: monospace;
  font-size: 13px;
  resize: vertical;
  background: var(--bg);
  color: var(--text);
  margin-bottom: 12px;
  box-sizing: border-box;
}

/* 历史列表 */
.history-card h3 {
  margin: 0 0 16px;
  font-size: 16px;
}
.history-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.history-item {
  padding: 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
  border: 1px solid var(--border);
}
.history-item:hover {
  background: var(--bg);
}
.history-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.history-name {
  font-weight: 500;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
}
.history-source {
  font-size: 12px;
  color: var(--primary);
  background: rgba(79, 70, 229, 0.1);
  padding: 2px 8px;
  border-radius: 4px;
}
.history-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}
.history-count {
  color: var(--text-secondary);
}
.history-time {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.status-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
}
.status-tag.preview { background: #fef3c7; color: #92400e; }
.status-tag.imported { background: #d1fae5; color: #065f46; }
.status-tag.rolled_back { background: #e5e7eb; color: #374151; }

/* 预览区域 */
.preview-section {
  background: var(--bg-card);
  border-radius: 16px;
  padding: 24px;
  border: 1px solid var(--border);
}

.preview-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.preview-header h3 {
  margin: 0;
  flex: 1;
}
.source-badge {
  background: rgba(79, 70, 229, 0.1);
  color: var(--primary);
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 13px;
}

.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}
.stat-card {
  background: var(--bg);
  padding: 16px;
  border-radius: 12px;
  text-align: center;
}
.stat-num {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 4px;
}
.stat-label {
  font-size: 13px;
  color: var(--text-secondary);
}
.stat-card.success .stat-num { color: #059669; }
.stat-card.warning .stat-num { color: #d97706; }
.stat-card.primary .stat-num { color: var(--primary); }

.action-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg);
  border-radius: 8px;
}
.action-left { display: flex; gap: 8px; }
.action-right { display: flex; gap: 12px; align-items: center; }
.selected-count {
  font-size: 14px;
  color: var(--text-secondary);
}

.status-banner {
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.status-banner.imported {
  background: #d1fae5;
  color: #065f46;
}
.status-banner.rolled_back {
  background: #e5e7eb;
  color: #374151;
}
.ml-10 { margin-left: 10px; }

/* 筛选 Tab */
.filter-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 12px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  width: fit-content;
}
.filter-tab {
  padding: 6px 16px;
  border: none;
  background: var(--bg);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  border-right: 1px solid var(--border);
  transition: all 0.15s;
}
.filter-tab:last-child { border-right: none; }
.filter-tab:hover { background: rgba(79, 70, 229, 0.06); }
.filter-tab.active {
  background: var(--primary);
  color: #fff;
}
.filter-count {
  display: inline-block;
  margin-left: 4px;
  font-size: 11px;
  opacity: 0.75;
}

/* 分页 */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px 12px;
  font-size: 13px;
}
.pagination-top {
  border-bottom: 1px solid var(--border);
  margin-bottom: 0;
}
.pagination:not(.pagination-top) {
  border-top: 1px solid var(--border);
}
.pagination button {
  padding: 6px 14px;
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: 6px;
  cursor: pointer;
  color: var(--text);
  font-size: 13px;
}
.pagination button:disabled {
  opacity: 0.4;
  cursor: default;
}
.pagination button:not(:disabled):hover {
  border-color: var(--primary);
  color: var(--primary);
}
.page-info {
  color: var(--text-secondary);
}

/* 表格 */
.records-table {
  border: 1px solid var(--border);
  border-radius: 8px;
}
.table-scroll {
  max-height: 440px;
  overflow-y: auto;
}
.table-scroll table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.table-scroll thead {
  position: sticky;
  top: 0;
  z-index: 1;
}
.records-table > table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.empty-parse-warning {
  padding: 32px 24px;
  text-align: center;
  color: #d97706;
  background: #fffbeb;
  font-size: 14px;
  line-height: 1.6;
}
.records-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.records-table th {
  background: var(--bg);
  padding: 12px;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}
.records-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.records-table tr:last-child td {
  border-bottom: none;
}
.records-table tr.duplicate {
  background: rgba(217, 119, 6, 0.06);
}

.type-tag {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.type-tag.expense { background: #fee2e2; color: #b91c1c; }
.type-tag.income { background: #d1fae5; color: #059669; }

.amount {
  font-weight: 600;
  font-family: monospace;
}

.desc-cell {
  max-width: 200px;
}
.merchant {
  font-weight: 500;
}
.desc {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dup-tag {
  color: #d97706;
  font-size: 12px;
  background: #fef3c7;
  padding: 2px 8px;
  border-radius: 4px;
}
.imported-tag {
  color: #059669;
  font-size: 12px;
  background: #d1fae5;
  padding: 2px 8px;
  border-radius: 4px;
}
.pending-tag {
  color: #6b7280;
  font-size: 12px;
  background: #f3f4f6;
  padding: 2px 8px;
  border-radius: 4px;
}
.rollback-tag {
  color: #6b7280;
  font-size: 12px;
  background: #f3f4f6;
  padding: 2px 8px;
  border-radius: 4px;
}

.editable {
  cursor: text;
  border-bottom: 1px dashed transparent;
}
.editable:hover {
  border-bottom-color: var(--border);
}

.edit-input {
  padding: 4px 8px;
  border: 1px solid var(--primary);
  border-radius: 4px;
  font-size: 14px;
  width: 100px;
}

/* 响应式 */
@media (max-width: 900px) {
  .upload-section {
    grid-template-columns: 1fr;
  }
  .stats-row {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
