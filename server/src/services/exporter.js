import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import { createCanvas } from 'canvas'
import QRCode from 'qrcode'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultPdfFontPath = path.join(__dirname, '..', 'assets', 'NotoSansSC-Regular.otf')

function recordAmount(record) {
  return Number(record.amount_cny ?? record.amount ?? 0)
}

export async function buildExcelBuffer(report) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('报表')

  sheet.addRow(['收入', report.income, '支出', report.expense, '结余', report.balance])
  sheet.addRow([])
  sheet.addRow(['分类', '金额(CNY)', '笔数'])
  for (const item of report.byCategory || []) {
    sheet.addRow([item.category, Number(item.total || 0), Number(item.count || 0)])
  }

  sheet.addRow([])
  sheet.addRow(['日期', '类型', '分类', '金额', '币种', '商家', '成员', '项目', '描述'])
  for (const record of report.records || []) {
    sheet.addRow([
      record.date,
      record.type,
      record.category,
      recordAmount(record),
      record.currency,
      record.merchant,
      record.member,
      record.project,
      record.description
    ])
  }

  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export function buildPdfBuffer(report, { fontPath = defaultPdfFontPath } = {}) {
  if (!existsSync(fontPath)) {
    return Promise.reject(new Error(`缺少中文字体文件: ${fontPath}`))
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    const doc = new PDFDocument()
    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.registerFont('CJK', fontPath)
    doc.font('CJK')

    doc.fontSize(18).text('Smart Finance Report')
    doc.fontSize(12).text(`Income: ${report.income}  Expense: ${report.expense}  Balance: ${report.balance}`)
    doc.moveDown()
    doc.text('Categories')
    for (const item of report.byCategory || []) {
      doc.text(`${item.category}: ${item.total} (${item.count})`)
    }

    doc.moveDown()
    doc.text('Records')
    for (const record of (report.records || []).slice(0, 100)) {
      doc.text(`${record.date} ${record.type} ${record.category} ${recordAmount(record)}${record.currency || ''} ${record.description || ''}`)
    }
    doc.end()
  })
}

export function buildImageBuffer(report) {
  const canvas = createCanvas(750, 1000)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 750, 1000)

  ctx.fillStyle = '#111827'
  ctx.font = '30px sans-serif'
  ctx.fillText('Smart Finance Report', 30, 60)
  ctx.font = '24px sans-serif'
  ctx.fillText(`Income ${report.income}  Expense ${report.expense}`, 30, 115)
  ctx.fillText(`Balance ${report.balance}`, 30, 155)

  ctx.font = '20px sans-serif'
  let y = 220
  for (const item of (report.byCategory || []).slice(0, 20)) {
    ctx.fillText(`${item.category}: ${item.total}`, 30, y)
    y += 36
  }

  return canvas.toBuffer('image/png')
}

export async function makeShareQr(url) {
  return QRCode.toBuffer(url)
}
