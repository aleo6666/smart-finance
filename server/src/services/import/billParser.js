/**
 * 账单解析器 - 支持多种格式导入
 *
 * 支持格式：
 * 1. wechat - 微信支付账单 CSV
 * 2. alipay - 支付宝账单 CSV
 * 3. generic - 通用 CSV（自动识别列）
 * 4. excel  - Excel/WPS 工作簿 (.xlsx)
 *
 * 统一输出标准格式：
 * {
 *   type: 'expense' | 'income',
 *   amount: Number,
 *   date: 'YYYY-MM-DD',
 *   category: String,
 *   merchant: String,
 *   description: String,
 *   sourceType: String,
 *   raw: Object  // 原始数据
 * }
 */

import { readFile } from 'fs/promises'
import ExcelJS from 'exceljs'

// ---- 编码检测与转换 ----

/**
 * 读取文件内容，自动检测编码（UTF-8 / GBK）并解码为字符串
 */
async function readFileAutoEncoding(filePath) {
  const buf = await readFile(filePath)

  // 尝试 UTF-8
  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  const replacementCount = (utf8Text.match(/�/g) || []).length

  // 如果有相当数量的替换字符，可能是 GBK
  if (replacementCount > 0 && replacementCount >= utf8Text.length * 0.01) {
    try {
      const gbkText = new TextDecoder('gbk', { fatal: false }).decode(buf)
      if (/[一-鿿]/.test(gbkText) && (gbkText.match(/�/g) || []).length < replacementCount) {
        return gbkText
      }
    } catch (_) { /* fall through */ }
  }

  return utf8Text
}

// ---- 分类映射表 ----

const WECHAT_CATEGORY_MAP = {
  '餐饮美食': '餐饮',
  '食品饮料': '餐饮',
  '交通出行': '交通',
  '交通': '交通',
  '购物消费': '购物',
  '购物': '购物',
  '休闲娱乐': '娱乐',
  '娱乐': '娱乐',
  '居家生活': '居家',
  '生活服务': '居家',
  '家居家装': '居家',
  '医疗健康': '医疗',
  '教育学习': '教育',
  '文化休闲': '教育',
  '运动健身': '运动',
  '旅行交通': '旅行',
  '酒店旅行': '旅行',
  '转账红包': '转账',
  '红包': '转账',
  '转账': '转账',
  '充值缴费': '缴费',
  '数码电器': '数码',
  '美容美发': '美容',
  '其他': '其他'
}

const ALIPAY_CATEGORY_MAP = {
  '餐饮美食': '餐饮',
  '交通出行': '交通',
  '服饰装扮': '购物',
  '日用百货': '居家',
  '家居家装': '居家',
  '休闲娱乐': '娱乐',
  '医疗健康': '医疗',
  '教育': '教育',
  '教育培训': '教育',
  '运动户外': '运动',
  '旅行': '旅行',
  '酒店': '旅行',
  '转账红包': '转账',
  '充值缴费': '缴费',
  '手机通讯': '缴费',
  '数码电器': '数码',
  '美容美发': '美容',
  '保险理财': '理财',
  '其他': '其他'
}

function mapCategory(category, sourceType) {
  if (!category) return '其他'
  const map = sourceType === 'wechat'
    ? WECHAT_CATEGORY_MAP
    : sourceType === 'alipay'
      ? ALIPAY_CATEGORY_MAP
      : {}
  return map[category] || category || '其他'
}

// ---- 格式自动识别 ----

function detectSourceType(firstLines) {
  const text = firstLines.join('\n')

  // 微信账单特征
  if (/微信支付账单|微信昵称|微信支付/.test(text) && /交易时间/.test(text)) {
    return 'wechat'
  }

  // 支付宝账单特征
  if (/支付宝/.test(text) && /交易时间/.test(text) && /交易分类/.test(text)) {
    return 'alipay'
  }

  // 通用 CSV：有日期/时间、金额等列
  if (/(?:日期|时间|date|time)/i.test(text) && /(?:金额|amount|价格|money)/i.test(text)) {
    return 'generic'
  }

  return 'unknown'
}

// ---- 金额解析 ----

function parseAmount(raw) {
  if (!raw) return 0
  const cleaned = String(raw).replace(/[^\d.-]/g, '')
  const num = parseFloat(cleaned)
  return Number.isFinite(num) ? Math.abs(num) : 0
}

// ---- 日期解析 ----

function parseDate(raw) {
  if (!raw) return ''
  const str = String(raw).trim()

  // YYYY-MM-DD HH:mm:ss
  const fullMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (fullMatch) {
    const [, y, m, d] = fullMatch
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  return str.slice(0, 10)
}

// ---- 解析收支类型 ----

function parseType(rawDirection, amount) {
  const dir = String(rawDirection || '').trim()
  // 精确匹配，避免 "不计收支" 中的 "收" 被误判为收入
  if (dir === '收入' || dir === '收') return 'income'
  if (dir === '支出' || dir === '支') return 'expense'
  // "不计收支" 等中性交易按金额符号推断
  return amount >= 0 ? 'expense' : 'income'
}

// ---- 微信账单解析 ----

function parseWechatRow(row) {
  const amount = parseAmount(row['金额(元)'] || row['金额'])
  const type = parseType(row['收/支'], amount)
  const category = mapCategory(row['交易类型'] || row['交易分类'], 'wechat')

  return {
    type,
    amount,
    date: parseDate(row['交易时间']),
    category,
    merchant: row['交易对方'] || '',
    description: row['商品'] || row['商品说明'] || '',
    sourceType: 'wechat',
    raw: row
  }
}

// ---- 支付宝账单解析 ----

function parseAlipayRow(row) {
  const amount = parseAmount(row['金额'] || row['金额(元)'])
  const type = parseType(row['收/支'], amount)
  const category = mapCategory(row['交易分类'], 'alipay')

  return {
    type,
    amount,
    date: parseDate(row['交易时间']),
    category,
    merchant: row['交易对方'] || '',
    description: row['商品说明'] || '',
    sourceType: 'alipay',
    raw: row
  }
}

// ---- 通用 CSV 解析 ----

function parseGenericRow(row) {
  // 尝试识别常见列名
  const dateCol = Object.keys(row).find(k => /日期|date|时间|time/i.test(k))
  const amountCol = Object.keys(row).find(k => /金额|amount|价格|money/i.test(k))
  const categoryCol = Object.keys(row).find(k => /分类|category|类型/i.test(k))
  const typeCol = Object.keys(row).find(k => /收支|类型|type|收|支/i.test(k))
  const descCol = Object.keys(row).find(k => /描述|备注|说明|desc|remark|note/i.test(k))
  const merchantCol = Object.keys(row).find(k => /商家|对方|商户|merchant/i.test(k))

  const amount = parseAmount(amountCol ? row[amountCol] : 0)
  const type = typeCol ? parseType(row[typeCol], amount) : 'expense'

  return {
    type,
    amount,
    date: parseDate(dateCol ? row[dateCol] : ''),
    category: categoryCol ? mapCategory(row[categoryCol], 'generic') : '其他',
    merchant: merchantCol ? row[merchantCol] : '',
    description: descCol ? row[descCol] : '',
    sourceType: 'generic',
    raw: row
  }
}

// ---- CSV 行解析（处理表头） ----

function parseCsvLine(line) {
  // RFC 4180 CSV 解析：处理引号包裹字段和 "" 转义
  const result = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"') {
        // "" 转义为字面双引号
        if (line[i + 1] === '"') {
          current += '"'
          i++ // 跳过下一个引号
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        result.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
  }
  result.push(current.trim())
  return result
}

// ---- Excel 日期转换 ----

/**
 * Excel 序列号 → Date
 * Excel 将日期存储为 1899-12-30 以来的天数（含 1900 闰年 bug）
 */
function excelSerialToDate(serial) {
  const n = Number(serial)
  if (!Number.isFinite(n) || n < 1 || n > 100000) return null
  // Excel serial 1 = 1900-01-01
  const jsEpoch = new Date(1900, 0, 1) // Jan 1, 1900
  const ms = jsEpoch.getTime() + (n - 1) * 86400000
  // Excel 1900 闰年 bug：n >= 61 时多算了不存在的 1900-02-29
  if (n >= 61) return new Date(ms - 86400000)
  return new Date(ms)
}

function isExcelDateSerial(value) {
  // Excel 日期序列号范围：1 (1900-01-01) ~ ~50000 (2036)
  return typeof value === 'number' && value >= 1 && value <= 60000 &&
    Number.isInteger(value) && !Number.isNaN(value)
}

/**
 * 智能日期转换：Date 对象 / Excel 序列号 / 字符串
 */
function parseExcelDate(value) {
  if (value instanceof Date && !isNaN(value)) {
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'number' && isExcelDateSerial(value)) {
    const date = excelSerialToDate(value)
    return date ? date.toISOString().slice(0, 10) : ''
  }
  return parseDate(value)
}

// ---- Excel 解析 ----

/**
 * 合并单元格去重：Excel 合并单元格后每个格都填相同值
 * 返回去重后的数组（只保留第一次出现的值，后续连续相同的值置空）
 */
function deduplicateMergedCells(cells) {
  const result = [...cells]
  let prev = null
  for (let i = 0; i < result.length; i++) {
    const v = String(result[i] ?? '')
    if (v && v === prev) {
      result[i] = ''
    } else if (v) {
      prev = v
    }
  }
  // 移除尾部空值
  while (result.length > 0 && String(result[result.length - 1] ?? '') === '') {
    result.pop()
  }
  return result
}

/**
 * 判断一行是否为微信/支付宝账单的元数据行（非数据行）
 */
function isMetadataRow(cellTexts) {
  const all = cellTexts.join(' ')
  // 微信账单元数据特征
  if (/微信支付账单明细|微信昵称|起始时间|终止时间|导出类型|导出时间|共\d+笔记录|收入：|支出：|中性交易：/.test(all)) return true
  // 注释行
  if (/^注[：:]/.test(all)) return true
  if (/本明细仅供|本账单中|若交易记录明细/.test(all)) return true
  // 分隔线
  if (/^[-—]+\s*微信支付/.test(all)) return true
  return false
}

/**
 * 判断一行是否为表头（有多个不同的列名关键词）
 */
function isHeaderRow(cellTexts) {
  const nonEmpty = cellTexts.filter(t => t.trim())
  // 表头至少要有 2 个不同值的非空单元格
  if (nonEmpty.length < 2) return false
  const unique = new Set(nonEmpty.map(t => t.trim()).filter(Boolean))
  if (unique.size < 2) return false
  // 必须包含日期或金额相关关键词
  const all = cellTexts.join(' ')
  return /(?:日期|时间|date|time|金额|amount|价格|分类|收支|商家|描述|类型|交易)/i.test(all)
}

/**
 * 解析 Excel/WPS 工作簿 (.xlsx)
 * 支持微信/支付宝导出的 xlsx 格式（含合并单元格）
 */
async function parseExcelFile(filePath) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)

  // 找到第一个有数据的 sheet
  const sheets = workbook.worksheets.filter(ws => ws.rowCount >= 2)
  if (sheets.length === 0) {
    return { sourceType: 'excel', records: [], totalCount: 0, validCount: 0 }
  }

  const ws = sheets[0]

  // 读取所有行，每行去重合并单元格后用非空值组成数组
  const allRows = []
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = []
    row.eachCell({ includeEmpty: false }, (cell) => cells.push(cell.value))
    if (cells.length > 0) {
      const deduped = deduplicateMergedCells(cells)
      allRows.push(deduped)
    }
  })

  if (allRows.length < 2) {
    return { sourceType: 'excel', records: [], totalCount: 0, validCount: 0 }
  }

  // 找表头行：扫描前 40 行，跳过元数据行，找真正的表头
  let headerIndex = -1
  const maxScan = Math.min(allRows.length, 40)
  for (let i = 0; i < maxScan; i++) {
    const cellTexts = allRows[i].map(c => String(c ?? ''))
    if (isHeaderRow(cellTexts) && !isMetadataRow(cellTexts)) {
      headerIndex = i
      break
    }
  }

  if (headerIndex < 0) {
    // 没有找到表头，回退到第一行
    headerIndex = 0
  }

  const headers = allRows[headerIndex].map(c => String(c ?? '').trim())

  // 数据行：表头之后，跳过空行和元数据行
  const dataRows = []
  for (let i = headerIndex + 1; i < allRows.length; i++) {
    const cellTexts = allRows[i].map(c => String(c ?? ''))
    // 跳过空行和元数据行
    if (cellTexts.every(t => !t.trim())) continue
    if (isMetadataRow(cellTexts)) continue
    dataRows.push(allRows[i])
  }

  // 检测来源（根据列名）
  const headerText = headers.join(',')
  let sourceType = 'excel'
  if (/收\/支/.test(headerText) && /交易对方/.test(headerText)) {
    sourceType = 'wechat'
  } else if (/交易分类/.test(headerText)) {
    sourceType = 'alipay'
  }

  const records = []
  for (const values of dataRows) {
    if (values.length === 0) continue

    const row = {}
    headers.forEach((h, i) => {
      row[h] = values[i] ?? ''
    })

    // Excel 日期字段用智能转换
    const dateCol = headers.find(h => /日期|时间|date|time/i.test(h))
    const dateValue = dateCol ? parseExcelDate(row[dateCol]) : parseDate(row['交易时间'] || row.date || '')

    let parsed
    switch (sourceType) {
      case 'wechat':
        parsed = parseWechatRow(row)
        if (dateValue) parsed.date = dateValue
        break
      case 'alipay':
        parsed = parseAlipayRow(row)
        if (dateValue) parsed.date = dateValue
        break
      default:
        parsed = {
          type: parseType(row['收/支'] || row['收支'] || row.type || row['类型'], parseAmount(row['金额(元)'] || row['金额'] || row.amount || row['价格'])),
          amount: parseAmount(row['金额(元)'] || row['金额'] || row.amount || row['价格']),
          date: dateValue,
          category: mapCategory(row['交易分类'] || row['分类'] || row.category || row['类型'], 'generic'),
          merchant: row['交易对方'] || row['商家'] || row['对方'] || row.merchant || '',
          description: row['商品'] || row['商品说明'] || row['描述'] || row['备注'] || row.description || '',
          sourceType: 'excel',
          raw: row
        }
    }

    if (parsed.amount > 0 && parsed.date) {
      records.push(parsed)
    }
  }

  return {
    sourceType,
    records,
    totalCount: dataRows.length,
    validCount: records.length
  }
}

// ---- 文件类型检测 ----

const EXCEL_EXTENSIONS = ['.xlsx', '.xls']

/**
 * 通过文件名或文件魔数检测是否为 Excel 文件
 * xlsx 是 ZIP 格式，以 PK (0x50 0x4B) 开头
 */
async function isExcelFile(filePath, fileName) {
  // 1. 检查文件名扩展名
  const nameToCheck = fileName || filePath
  const lower = nameToCheck.toLowerCase()
  if (EXCEL_EXTENSIONS.some(ext => lower.endsWith(ext))) return true

  // 2. 检查文件魔数（multer 保存的临时文件没有扩展名）
  try {
    const buf = await readFile(filePath)
    // xlsx 文件以 ZIP magic bytes 0x50 0x4B 开头
    if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B) return true
  } catch (_) { /* ignore */ }

  return false
}

/**
 * 统一入口：根据文件名和文件内容自动选择 CSV 或 Excel 解析器
 */
async function parseFile(filePath, fileName) {
  if (await isExcelFile(filePath, fileName)) {
    return parseExcelFile(filePath)
  }
  return parseCsvFile(filePath)
}

// ---- 从文件路径读取并解析 ----

/**
 * 解析 CSV 账单文件
 * @param {string} filePath - CSV 文件路径
 * @returns {Promise<Object>} { sourceType, records, totalCount, validCount }
 */
async function parseCsvFile(filePath) {
  const lines = await readAllLines(filePath)
  return parseCsvLines(lines)
}

/**
 * 按行拆分 CSV 文本，保留引用字段内的换行
 */
function splitCsvLines(content) {
  const lines = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (inQuotes) {
      current += ch
      if (ch === '"' && content[i + 1] !== '"') inQuotes = false
    } else {
      if (ch === '"') {
        current += ch
        inQuotes = true
      } else if (ch === '\r') {
        lines.push(current)
        current = ''
        if (content[i + 1] === '\n') i++
      } else if (ch === '\n') {
        lines.push(current)
        current = ''
      } else {
        current += ch
      }
    }
  }
  if (current) lines.push(current)
  return lines
}

/**
 * 从 CSV 文本内容解析
 * @param {string} content - CSV 文本
 */
function parseCsvContent(content) {
  const lines = splitCsvLines(String(content || '')).filter(l => l.trim())
  return parseCsvLines(lines)
}

function parseCsvLines(lines) {
  if (!lines || lines.length === 0) {
    return { sourceType: 'unknown', records: [], totalCount: 0, validCount: 0 }
  }

  // 剥离 UTF-8 BOM（防止首列表头被 BOM 前缀污染）
  if (lines.length > 0 && lines[0].charCodeAt(0) === 0xFEFF) {
    lines[0] = lines[0].slice(1)
  }

  // 识别格式（取前 30 行判断）
  const previewLines = lines.slice(0, 30)
  const sourceType = detectSourceType(previewLines)

  // 找到表头行
  let headerIndex = -1
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const line = lines[i]
    if (/交易时间|日期|date|金额|amount/i.test(line) && line.includes(',')) {
      headerIndex = i
      break
    }
  }

  // 找不到表头，默认第一行是表头
  if (headerIndex < 0) headerIndex = 0

  const headers = parseCsvLine(lines[headerIndex])
  const dataLines = lines.slice(headerIndex + 1).filter(l => l.trim())

  const records = []
  for (const line of dataLines) {
    const values = parseCsvLine(line)
    if (values.length < 2) continue

    const row = {}
    headers.forEach((h, i) => {
      row[h.trim()] = values[i] || ''
    })

    let parsed
    switch (sourceType) {
      case 'wechat':
        parsed = parseWechatRow(row)
        break
      case 'alipay':
        parsed = parseAlipayRow(row)
        break
      case 'generic':
      default:
        parsed = parseGenericRow(row)
    }

    // 过滤无效记录
    if (parsed.amount > 0 && parsed.date) {
      records.push(parsed)
    }
  }

  return {
    sourceType,
    records,
    totalCount: dataLines.length,
    validCount: records.length
  }
}

// ---- 读取文件所有行 ----

async function readAllLines(filePath) {
  const text = await readFileAutoEncoding(filePath)
  return text.split(/\r?\n/)
}

// ---- 重复检测（相似度） ----

/**
 * 计算两条记录的相似度（用于去重检测）
 * 返回 0-1，1 表示完全相同
 */
function calculateSimilarity(a, b) {
  if (!a || !b) return 0

  // 日期不同直接 0
  if (a.date && b.date && a.date !== b.date) return 0

  // 金额差超过 0.01 直接 0
  if (Math.abs(Number(a.amount) - Number(b.amount)) > 0.01) return 0

  let score = 0
  const total = 4

  // 金额完全匹配
  if (Math.abs(Number(a.amount) - Number(b.amount)) <= 0.01) score += 1

  // 分类相同
  if (a.category === b.category) score += 1

  // 商家/描述关键词匹配
  const aText = `${a.merchant || ''} ${a.description || ''}`.toLowerCase()
  const bText = `${b.merchant || ''} ${b.description || ''}`.toLowerCase()
  if (aText && bText) {
    if (aText === bText) {
      score += 2
    } else if (aText.includes(bText) || bText.includes(aText)) {
      score += 1.5
    } else {
      // 简单字符重叠
      const aSet = new Set(aText)
      const bSet = new Set(bText)
      let overlap = 0
      for (const c of aSet) if (bSet.has(c)) overlap++
      const totalChars = new Set([...aSet, ...bSet]).size
      if (totalChars > 0) score += 2 * (overlap / totalChars)
    }
  }

  return Math.min(1, score / total)
}

export {
  parseFile,
  parseCsvFile,
  parseExcelFile,
  parseCsvContent,
  parseCsvLines,
  parseCsvLine,
  splitCsvLines,
  detectSourceType,
  calculateSimilarity,
  mapCategory,
  WECHAT_CATEGORY_MAP,
  ALIPAY_CATEGORY_MAP
}

export default { parseFile, parseCsvFile, parseExcelFile, parseCsvContent, calculateSimilarity }
