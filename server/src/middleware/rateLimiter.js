import rateLimit from 'express-rate-limit'

/** 严格限制：登录/注册/改密，15分钟内同一IP最多10次 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '操作过于频繁，请15分钟后再试' }
})

/** 通用限制：所有API，1分钟60次 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '请求过于频繁，请稍后重试' }
})

/** 敏感操作限制：导出、删除等高危操作，15分钟最多5次 */
export const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '操作过于频繁，请15分钟后再试' }
})
