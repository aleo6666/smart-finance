import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { buildReport as defaultBuildReport } from '../services/reportGenerator.js'
import {
  buildExcelBuffer as defaultBuildExcelBuffer,
  buildImageBuffer as defaultBuildImageBuffer,
  buildPdfBuffer as defaultBuildPdfBuffer
} from '../services/exporter.js'

function formatLocalMonth(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function formatLocalDate(date) {
  return `${formatLocalMonth(date)}-${String(date.getDate()).padStart(2, '0')}`
}

function defaultPeriodValue(periodType, date) {
  if (periodType === 'year') return String(date.getFullYear())
  if (periodType === 'quarter') {
    return `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`
  }
  if (periodType === 'week') return formatLocalDate(date)
  return formatLocalMonth(date)
}

function isRealDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [, year, month, day] = match.map(Number)
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

function isValidPeriodValue(periodType, value) {
  if (typeof value !== 'string') return false
  if (periodType === 'month') return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
  if (periodType === 'year') return /^\d{4}$/.test(value)
  if (periodType === 'quarter') return /^\d{4}-Q[1-4]$/.test(value)
  return isRealDate(value)
}

function getReportParams(req, now) {
  const { periodType = 'month', periodValue, ledgerId, category, member, merchant, project } = req.query
  if (!['month', 'year', 'quarter', 'week'].includes(periodType)) {
    return { error: '不支持的周期类型' }
  }

  const resolvedPeriodValue = periodValue === undefined
    ? defaultPeriodValue(periodType, now())
    : periodValue
  if (!isValidPeriodValue(periodType, resolvedPeriodValue)) {
    return { error: '周期值格式不正确' }
  }

  let resolvedLedgerId = null
  if (ledgerId !== undefined) {
    if (typeof ledgerId !== 'string' || !/^[1-9]\d*$/.test(ledgerId)) {
      return { error: '账本ID必须为正整数' }
    }
    resolvedLedgerId = Number(ledgerId)
    if (!Number.isSafeInteger(resolvedLedgerId)) {
      return { error: '账本ID必须为正整数' }
    }
  }

  return {
    params: {
      userId: req.userId,
      ledgerId: resolvedLedgerId,
      periodType,
      periodValue: resolvedPeriodValue,
      filters: { category, member, merchant, project }
    }
  }
}

function setDownloadHeaders(res, contentType, filename) {
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
}

function createExportHandler({ buildReport, buildBuffer, contentType, extension, now }) {
  return async (req, res) => {
    try {
      const result = getReportParams(req, now)
      if (result.error) {
        return res.status(400).json({ success: false, error: result.error })
      }

      const report = await buildReport(result.params)
      const buffer = await buildBuffer(report)
      setDownloadHeaders(res, contentType, `report-${Date.now()}.${extension}`)
      return res.send(buffer)
    } catch {
      return res.status(500).json({ success: false, error: '报表导出失败' })
    }
  }
}

export function createExportRouter({
  buildReport = defaultBuildReport,
  buildExcelBuffer = defaultBuildExcelBuffer,
  buildPdfBuffer = defaultBuildPdfBuffer,
  buildImageBuffer = defaultBuildImageBuffer,
  now = () => new Date()
} = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.get('/excel', createExportHandler({
    buildReport,
    buildBuffer: buildExcelBuffer,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
    now
  }))
  router.get('/pdf', createExportHandler({
    buildReport,
    buildBuffer: buildPdfBuffer,
    contentType: 'application/pdf',
    extension: 'pdf',
    now
  }))
  router.get('/image', createExportHandler({
    buildReport,
    buildBuffer: buildImageBuffer,
    contentType: 'image/png',
    extension: 'png',
    now
  }))

  return router
}

export default createExportRouter()
