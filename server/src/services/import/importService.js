/**
 * 导入服务 - 核心逻辑
 *
 * 功能：
 * 1. 创建导入批次（解析预览，不落库）
 * 2. 重复检测
 * 3. 确认入库（人工确认后批量写入）
 * 4. 导入历史查询
 * 5. 回滚撤销
 */

import db from '../../db.js'
import { parseFile, parseCsvFile, parseCsvContent, calculateSimilarity } from './billParser.js'
import { embedRecord, deleteRecordVector } from '../vectorMemory.js'

const DUPLICATE_THRESHOLD = 0.85 // 相似度超过 0.85 视为重复

// ---- 1. 创建导入批次（解析 + 预览） ----

/**
 * 从 CSV 文件创建导入批次
 */
async function createBatchFromFile({ userId, ledgerId = null, filePath, fileName }) {
  const parseResult = await parseFile(filePath, fileName)
  return createBatchInternal({
    userId,
    ledgerId,
    sourceType: parseResult.sourceType,
    fileName,
    records: parseResult.records,
    totalCount: parseResult.totalCount
  })
}

/**
 * 从 CSV 文本内容创建导入批次
 */
async function createBatchFromContent({ userId, ledgerId = null, content, fileName = 'paste.csv' }) {
  const parseResult = parseCsvContent(content)
  return createBatchInternal({
    userId,
    ledgerId,
    sourceType: parseResult.sourceType,
    fileName,
    records: parseResult.records,
    totalCount: parseResult.totalCount
  })
}

/**
 * 内部：创建批次通用逻辑
 */
async function createBatchInternal({ userId, ledgerId, sourceType, fileName, records, totalCount }) {
  // 检测重复
  const { recordsWithDup, duplicateCount } = await detectDuplicatesForRecords(userId, records)

  const validCount = recordsWithDup.filter(r => r.amount > 0 && r.date).length
  const errorCount = totalCount - validCount

  // 保存批次
  const [batchId] = await db('import_batches').insert({
    user_id: userId,
    ledger_id: ledgerId,
    source_type: sourceType,
    file_name: fileName,
    total_count: totalCount,
    valid_count: validCount,
    duplicate_count: duplicateCount,
    error_count: errorCount,
    imported_count: 0,
    status: 'preview',
    preview_data: JSON.stringify(recordsWithDup.slice(0, 200)) // 预览只存前 200 条
  })

  // 保存明细
  const detailRows = recordsWithDup.map(r => ({
    batch_id: batchId,
    user_id: userId,
    original_row: JSON.stringify(r.raw || {}),
    mapped_type: r.type,
    mapped_amount: r.amount,
    mapped_category: r.category,
    mapped_date: r.date,
    mapped_description: r.description,
    mapped_merchant: r.merchant,
    status: 'pending',
    is_duplicate: r.isDuplicate ? 1 : 0,
    duplicate_similarity: r.similarity || 0,
    duplicate_of_record_id: r.duplicateOf || null,
    selected: r.isDuplicate ? 0 : 1 // 重复的默认不选中
  }))

  if (detailRows.length > 0) {
    await db('import_records').insert(detailRows)
  }

  return getBatchDetail(batchId, userId)
}

// ---- 2. 重复检测 ----

async function detectDuplicatesForRecords(userId, newRecords) {
  if (!newRecords || newRecords.length === 0) {
    return { recordsWithDup: [], duplicateCount: 0 }
  }

  // 取用户近 90 天的记录用于比对
  const dateMin = new Date()
  dateMin.setDate(dateMin.getDate() - 90)
  const dateStr = dateMin.toISOString().slice(0, 10)

  const existingRecords = await db('records')
    .where('user_id', userId)
    .where('date', '>=', dateStr)
    .select('id', 'amount', 'category', 'date', 'description', 'merchant', 'type')

  let duplicateCount = 0
  const recordsWithDup = newRecords.map(record => {
    let maxSim = 0
    let dupId = null

    for (const existing of existingRecords) {
      // 类型不同跳过
      if (existing.type !== record.type) continue

      const sim = calculateSimilarity(
        { amount: existing.amount, category: existing.category, date: existing.date, merchant: existing.merchant, description: existing.description },
        record
      )

      if (sim > maxSim) {
        maxSim = sim
        dupId = existing.id
      }
    }

    const isDuplicate = maxSim >= DUPLICATE_THRESHOLD
    if (isDuplicate) duplicateCount++

    return {
      ...record,
      isDuplicate,
      similarity: maxSim,
      duplicateOf: dupId
    }
  })

  return { recordsWithDup, duplicateCount }
}

// ---- 3. 确认导入 ----

/**
 * 确认导入选中的记录
 * @param {number} batchId - 批次 ID
 * @param {number} userId - 用户 ID
 * @param {Array<number>} selectedIds - 选中的明细 ID（不传则导入所有 selected=1 的）
 */
async function confirmImport({ batchId, userId, selectedIds = null }) {
  const batch = await db('import_batches')
    .where({ id: batchId, user_id: userId })
    .first()

  if (!batch) throw new Error('批次不存在')
  if (batch.status === 'imported') throw new Error('该批次已导入')
  if (batch.status === 'rolled_back') throw new Error('该批次已回滚')

  // 获取要导入的明细
  let query = db('import_records').where({ batch_id: batchId, user_id: userId, status: 'pending' })

  if (selectedIds && selectedIds.length > 0) {
    query = query.whereIn('id', selectedIds)
  } else {
    query = query.where('selected', 1)
  }

  const toImport = await query
  if (toImport.length === 0) throw new Error('没有可导入的记录')

  const importedRecordIds = []

  await db.transaction(async trx => {
    for (const item of toImport) {
      // 插入 records 表
      const [recordId] = await trx('records').insert({
        device_id: `user-${userId}`,
        user_id: userId,
        ledger_id: batch.ledger_id,
        type: item.mapped_type,
        amount: item.mapped_amount,
        currency: 'CNY',
        amount_cny: item.mapped_amount,
        category: item.mapped_category,
        description: item.mapped_description || item.mapped_category,
        merchant: item.mapped_merchant,
        date: item.mapped_date
      })

      importedRecordIds.push(recordId)

      // 更新明细状态
      await trx('import_records')
        .where({ id: item.id })
        .update({
          status: 'imported',
          record_id: recordId,
          imported_at: new Date()
        })
    }

    // 更新批次状态
    await trx('import_batches')
      .where({ id: batchId })
      .update({
        status: 'imported',
        imported_count: importedRecordIds.length,
        imported_at: new Date()
      })
  })

  // 异步同步向量索引（不阻塞）
  syncVectorsAsync(importedRecordIds).catch(err => {
    console.warn('[Import] 向量同步失败:', err.message)
  })

  return {
    success: true,
    batchId,
    importedCount: importedRecordIds.length,
    recordIds: importedRecordIds
  }
}

// 异步同步向量
async function syncVectorsAsync(recordIds) {
  for (const id of recordIds) {
    try {
      const record = await db('records').where({ id }).first()
      if (record) await embedRecord(record)
    } catch (e) {
      console.warn(`[Import] 记录 ${id} 向量化失败:`, e.message)
    }
  }
}

// ---- 4. 批次查询 ----

async function getBatchList({ userId, page = 1, pageSize = 20 }) {
  const offset = (page - 1) * pageSize

  const [list, total] = await Promise.all([
    db('import_batches')
      .where({ user_id: userId })
      .orderBy('created_at', 'desc')
      .offset(offset)
      .limit(pageSize)
      .select('id', 'source_type', 'file_name', 'total_count', 'valid_count', 'imported_count', 'status', 'created_at', 'imported_at'),
    db('import_batches').where({ user_id: userId }).count('id as cnt').first()
  ])

  return {
    list: list.map(row => ({
      id: row.id,
      sourceType: row.source_type,
      fileName: row.file_name,
      totalCount: row.total_count,
      validCount: row.valid_count,
      importedCount: row.imported_count,
      status: row.status,
      createdAt: row.created_at,
      importedAt: row.imported_at
    })),
    total: total?.cnt || 0,
    page,
    pageSize
  }
}

async function getBatchDetail(batchId, userId) {
  const batch = await db('import_batches')
    .where({ id: batchId, user_id: userId })
    .first()

  if (!batch) return null

  const records = await db('import_records')
    .where({ batch_id: batchId, user_id: userId })
    .orderBy('id', 'asc')
    .select(
      'id', 'mapped_type', 'mapped_amount', 'mapped_category', 'mapped_date',
      'mapped_description', 'mapped_merchant', 'status', 'is_duplicate',
      'duplicate_similarity', 'selected', 'record_id'
    )

  return {
    id: batch.id,
    sourceType: batch.source_type,
    fileName: batch.file_name,
    status: batch.status,
    totalCount: batch.total_count,
    validCount: batch.valid_count,
    duplicateCount: batch.duplicate_count,
    errorCount: batch.error_count,
    importedCount: batch.imported_count,
    createdAt: batch.created_at,
    importedAt: batch.imported_at,
    records: records.map(r => ({
      id: r.id,
      type: r.mapped_type,
      amount: Number(r.mapped_amount),
      category: r.mapped_category,
      date: r.mapped_date,
      description: r.mapped_description,
      merchant: r.mapped_merchant,
      status: r.status,
      isDuplicate: !!r.is_duplicate,
      similarity: Number(r.duplicate_similarity),
      selected: !!r.selected,
      recordId: r.record_id
    }))
  }
}

// ---- 5. 更新明细（人工编辑） ----

async function updateRecord({ batchId, recordId, userId, updates }) {
  const batch = await db('import_batches').where({ id: batchId, user_id: userId }).first()
  if (!batch) throw new Error('批次不存在')
  if (batch.status !== 'preview') throw new Error('仅预览状态可编辑')

  const updateData = {}
  if (updates.category !== undefined) updateData.mapped_category = updates.category
  if (updates.amount !== undefined) updateData.mapped_amount = updates.amount
  if (updates.date !== undefined) updateData.mapped_date = updates.date
  if (updates.description !== undefined) updateData.mapped_description = updates.description
  if (updates.merchant !== undefined) updateData.mapped_merchant = updates.merchant
  if (updates.type !== undefined) updateData.mapped_type = updates.type
  if (updates.selected !== undefined) updateData.selected = updates.selected ? 1 : 0

  await db('import_records')
    .where({ id: recordId, batch_id: batchId, user_id: userId })
    .update(updateData)

  return getBatchDetail(batchId, userId)
}

// ---- 6. 回滚导入 ----

/**
 * 回滚某个导入批次（24小时内可回滚）
 */
async function rollbackBatch({ batchId, userId }) {
  const batch = await db('import_batches')
    .where({ id: batchId, user_id: userId })
    .first()

  if (!batch) throw new Error('批次不存在')
  if (batch.status !== 'imported') throw new Error('仅已导入的批次可回滚')

  // 检查是否在 24 小时内
  const importedAt = new Date(batch.imported_at)
  const hoursPassed = (Date.now() - importedAt.getTime()) / (1000 * 60 * 60)
  if (hoursPassed > 24) {
    throw new Error('导入超过 24 小时，无法回滚')
  }

  // 获取导入的记录 ID
  const importedRecords = await db('import_records')
    .where({ batch_id: batchId, status: 'imported' })
    .select('record_id')

  const recordIds = importedRecords.map(r => r.record_id).filter(Boolean)

  await db.transaction(async trx => {
    // 删除 records
    if (recordIds.length > 0) {
      await trx('records').whereIn('id', recordIds).del()
    }

    // 更新明细状态
    await trx('import_records')
      .where({ batch_id: batchId })
      .update({ status: 'rolled_back', record_id: null })

    // 更新批次状态
    await trx('import_batches')
      .where({ id: batchId })
      .update({
        status: 'rolled_back',
        imported_count: 0,
        rolled_back_at: new Date()
      })
  })

  // 删除向量索引
  for (const id of recordIds) {
    deleteRecordVector(id).catch(() => {})
  }

  return {
    success: true,
    batchId,
    rolledBackCount: recordIds.length
  }
}

export {
  createBatchFromFile,
  createBatchFromContent,
  confirmImport,
  getBatchList,
  getBatchDetail,
  updateRecord,
  rollbackBatch,
  detectDuplicatesForRecords
}

export default {
  createBatchFromFile,
  createBatchFromContent,
  confirmImport,
  getBatchList,
  getBatchDetail,
  updateRecord,
  rollbackBatch
}
