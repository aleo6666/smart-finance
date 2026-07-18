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

function getReportParams(req, now) {
  const { periodType = 'month', periodValue, ledgerId, category, member, merchant, project } = req.query
  return {
    userId: req.userId,
    ledgerId: ledgerId ? Number(ledgerId) : null,
    periodType,
    periodValue: periodValue || formatLocalMonth(now()),
    filters: { category, member, merchant, project }
  }
}

function setDownloadHeaders(res, contentType, filename) {
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
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

  router.get('/excel', async (req, res) => {
    const report = await buildReport(getReportParams(req, now))
    const buffer = await buildExcelBuffer(report)
    setDownloadHeaders(
      res,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `report-${Date.now()}.xlsx`
    )
    res.send(buffer)
  })

  router.get('/pdf', async (req, res) => {
    const report = await buildReport(getReportParams(req, now))
    const buffer = await buildPdfBuffer(report)
    setDownloadHeaders(res, 'application/pdf', `report-${Date.now()}.pdf`)
    res.send(buffer)
  })

  router.get('/image', async (req, res) => {
    const report = await buildReport(getReportParams(req, now))
    const buffer = await buildImageBuffer(report)
    setDownloadHeaders(res, 'image/png', `report-${Date.now()}.png`)
    res.send(buffer)
  })

  return router
}

export default createExportRouter()
