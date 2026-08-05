/**
 * RBAC 中间件 — 角色权限控制
 * 角色: owner(全部) > admin(CRUD) > member(读写) > viewer(只读)
 */
import db from '../db.js'

const ROLE_HIERARCHY = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
}

export function requireRole(...roles) {
  return async (req, res, next) => {
    const ledgerId = req.params.ledgerId || req.query.ledgerId || req.body?.ledgerId || req.body?.ledger_id
    if (!ledgerId) {
      return next() // 无账本参数时放行，由业务层处理
    }

    try {
      const member = await db('ledger_members')
        .where({ ledger_id: ledgerId, user_id: req.userId })
        .first()

      if (!member) {
        return res.status(403).json({ success: false, error: '无权访问此账本' })
      }

      const userLevel = ROLE_HIERARCHY[member.role] || 0
      const requiredLevel = Math.min(...roles.map(r => ROLE_HIERARCHY[r] || 0))

      if (userLevel < requiredLevel) {
        return res.status(403).json({
          success: false,
          error: `需要 ${roles.join('/')} 权限，当前角色: ${member.role}`
        })
      }

      req.ledgerRole = member.role
      next()
    } catch (err) {
      console.error('[RBAC] check failed:', err.message)
      return res.status(500).json({ success: false, error: '权限检查失败' })
    }
  }
}

/** 创建账本时自动将创建者设为 owner */
export async function assignOwnerRole(ledgerId, userId) {
  try {
    await db('ledger_members').insert({
      ledger_id: ledgerId,
      user_id: userId,
      role: 'owner'
    }).onConflict(['ledger_id', 'user_id']).ignore()
  } catch (err) {
    console.error('[RBAC] assign owner failed:', err.message)
  }
}
