import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-secret-change-me')

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required in production')
}

if (process.env.NODE_ENV === 'production' && /change-me/i.test(JWT_SECRET)) {
  throw new Error('JWT_SECRET must be changed in production')
}

export function authMiddleware(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: '未登录' })
  }
  try {
    req.userId = jwt.verify(h.slice(7), JWT_SECRET).userId
    next()
  } catch {
    return res.status(401).json({ success: false, error: '登录已过期' })
  }
}

export const signToken = (userId) => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' })

export { JWT_SECRET }
