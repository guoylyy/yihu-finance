// JWT 鉴权 + 权限矩阵 + 公司数据范围
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'

// 部署在以虎 One 上没配 JWT_SECRET 时，从平台注入的应用密钥派生（重置应用密钥 = 所有人重新登录）
const SECRET = process.env.JWT_SECRET ||
  (process.env.YH_CLIENT_SECRET && crypto.createHash('sha256').update(`yihu-finance-jwt:${process.env.YH_CLIENT_SECRET}`).digest('hex')) ||
  'dev-secret'
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d'

export function signToken(payload, expiresIn) {
  return jwt.sign(payload, SECRET, { expiresIn: expiresIn || EXPIRES_IN })
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET)
  } catch {
    return null
  }
}

export function auth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ code: 1001, message: '未授权', data: null })
  }
  const payload = verifyToken(header.slice(7))
  if (!payload) {
    return res.status(401).json({ code: 1002, message: 'Token 无效或过期', data: null })
  }
  req.user = payload
  next()
}

/**
 * 权限点矩阵：key = 模块.动作，value = 拥有该权限的角色
 * 角色：ADMIN 管理者 / FINANCE 财务 / MANAGER 经理 / STAFF 业务 / VIEWER 只读
 * 需求文档 §4：AI 助手与业务人员均不得直接触发付款
 */
export const PERMISSIONS = {
  'finance.view':       ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],   // 录入助手（只出草稿，写入仍按各模块 manage 权限）
  'dashboard.view':     ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],
  'company.view':       ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],
  'company.manage':     ['ADMIN'],
  'account.view':       ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],
  'account.manage':     ['ADMIN', 'FINANCE'],
  'account.viewFullNo': ['ADMIN', 'FINANCE'],   // 看完整账号（其余角色脱敏）
  'transaction.view':   ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],
  'transaction.manage': ['ADMIN', 'FINANCE'],
  'transaction.import': ['ADMIN', 'FINANCE'],
  'party.view':         ['ADMIN', 'FINANCE', 'MANAGER', 'STAFF', 'VIEWER'],
  'party.manage':       ['ADMIN', 'FINANCE'],
  'receivable.view':    ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],
  'receivable.manage':  ['ADMIN', 'FINANCE'],
  'payable.view':       ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],
  'payable.manage':     ['ADMIN', 'FINANCE'],
  'payment.view':       ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],
  'payment.manage':     ['ADMIN', 'FINANCE'],
  'payment.approve':    ['ADMIN'],              // 审批仅管理者
  'payment.pay':        ['ADMIN', 'FINANCE'],   // 标记已付款
  'payroll.view':       ['ADMIN', 'FINANCE'],
  'payroll.manage':     ['ADMIN', 'FINANCE'],
  'reimburse.view':     ['ADMIN', 'FINANCE', 'MANAGER', 'STAFF'],
  'reimburse.submit':   ['ADMIN', 'FINANCE', 'MANAGER', 'STAFF'],
  'reimburse.approve':  ['ADMIN', 'FINANCE'],
  'invoice.view':       ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],
  'invoice.manage':     ['ADMIN', 'FINANCE'],
  'loan.view':          ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],
  'loan.manage':        ['ADMIN', 'FINANCE'],
  'close.view':         ['ADMIN', 'FINANCE', 'MANAGER'],
  'close.manage':       ['ADMIN', 'FINANCE'],
  'analytics.view':     ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],
  'forecast.view':      ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'],
  'forecast.manage':    ['ADMIN', 'FINANCE'],
  'user.manage':        ['ADMIN'],
  'audit.view':         ['ADMIN']
}

export function can(user, perm) {
  const roles = PERMISSIONS[perm]
  if (!roles) return false
  return !!user && roles.includes(user.role)
}

export function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ code: 1001, message: '未登录', data: null })
    }
    if (!can(req.user, perm)) {
      return res.status(403).json({
        code: 9003,
        message: `需要「${perm}」权限，当前角色 ${req.user.role} 不具备`,
        data: null
      })
    }
    next()
  }
}

/**
 * 公司数据范围：companyScope 为 null 时可见全部公司
 * 返回可直接展开进 Prisma where 的片段
 */
export function scopeWhere(user, field = 'companyId') {
  const scope = user?.companyScope
  if (!Array.isArray(scope) || scope.length === 0) return {}
  return { [field]: { in: scope.map(BigInt) } }
}

export function inScope(user, companyId) {
  const scope = user?.companyScope
  if (!Array.isArray(scope) || scope.length === 0) return true
  return scope.map(String).includes(String(companyId))
}

// 账号脱敏：仅授权角色看完整值
export function maskAccountNo(no, user) {
  if (!no) return no
  if (can(user, 'account.viewFullNo')) return no
  if (no.length <= 4) return '****'
  return '**** **** ' + no.slice(-4)
}
