import db from '../db.js'

const HEALTH_PREFIX = '/api/health'

export function auditLogMiddleware(req, res, next) {
  if (req.originalUrl === HEALTH_PREFIX || req.path === HEALTH_PREFIX) {
    return next()
  }

  res.on('finish', () => {
    const entry = {
      user_id: req.userId || null,
      method: req.method,
      path: (req.originalUrl || req.path).slice(0, 256),
      status_code: res.statusCode,
      ip: req.ip || req.socket?.remoteAddress || null
    }

    db('audit_logs').insert(entry).catch(err => {
      console.error('[AuditLog] insert failed:', err.message)
    })
  })

  next()
}
