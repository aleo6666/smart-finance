import { Router } from 'express'
import db from '../db.js'

const router = Router()

function renderHtml(data) {
  const rows = (data.records || []).map(r => `<tr><td>${r.date}</td><td>${r.type}</td><td>${r.category}</td><td>${r.amount} ${r.currency || ''}</td><td>${r.merchant || ''}</td></tr>`).join('')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>财务报表</title>
    <style>body{font-family:sans-serif;padding:20px;max-width:900px;margin:0 auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px;text-align:left}th{background:#f5f5f5}</style></head>
    <body><h2>财务报表 ${data.period?.value || ''}</h2>
    <p>收入：<b>${data.income || 0}</b> · 支出：<b>${data.expense || 0}</b> · 结余：<b>${data.balance || 0}</b></p>
    <table><tr><th>日期</th><th>类型</th><th>分类</th><th>金额</th><th>商家</th></tr>${rows}</table></body></html>`
}

router.get('/:token', async (req, res) => {
  const share = await db('report_shares').where({ token: req.params.token }).first()
  if (!share) return res.status(404).send('链接无效')
  if (share.expire_at && new Date(share.expire_at) < new Date()) return res.status(410).send('链接已过期')
  const report = await db('reports').where({ id: share.report_id }).first()
  if (!report) return res.status(404).send('报表不存在')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(renderHtml(typeof report.summary_json === 'string' ? JSON.parse(report.summary_json) : report.summary_json || {}))
})

export default router
