// 统一响应封装：{ code, message, data }
// code = 0 表示成功，其余为业务错误码（与前端 api/index.js 的映射表对齐）
export function ok(res, data = null, message = 'ok') {
  return res.json({ code: 0, message, data })
}

export function fail(res, code = 9001, message = '服务器内部错误', httpStatus = 200) {
  return res.status(httpStatus).json({ code, message, data: null })
}

export function badRequest(res, message = '请求参数不合法') {
  return fail(res, 9002, message)
}

export function notFound(res, message = '资源不存在或已被删除') {
  return fail(res, 9004, message)
}

export function forbidden(res, message = '您没有该操作的权限') {
  return fail(res, 9003, message, 403)
}

// Prisma 的报错原文（invocation、约束名、SQL 片段）不给前端看，翻成能读懂的话
const UNIQUE_LABEL = [
  [/code/, '业务编号冲突，请重试'],
  [/invoice_no|invoiceNo/, '该公司下发票号已存在，请勿重复录入'],
  [/username/, '用户名已存在'],
  [/fingerprint/, '这笔刚才已提交过，请刷新后查看']
]
export function readableError(e) {
  const name = e?.constructor?.name || ''
  if (e?.code === 'P2002') {
    const target = Array.isArray(e.meta?.target) ? e.meta.target.join(',') : String(e.meta?.target || '')
    return { code: 9002, message: UNIQUE_LABEL.find(([re]) => re.test(target))?.[1] || '数据重复，与已有记录冲突' }
  }
  if (e?.code === 'P2003') return { code: 9002, message: '关联的记录不存在或已删除' }
  if (e?.code === 'P2025') return { code: 9004, message: '资源不存在或已被删除' }
  if (/^PrismaClient/.test(name) || /prisma\.\w+\.\w+\(\)/.test(String(e?.message))) return { code: 9001, message: '服务器内部错误（数据库操作失败，已记录日志）' }
  return { code: 9001, message: e?.message || '服务器内部错误' }
}

// 统一的路由 try/catch 包装，避免每个 handler 重复写
export function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (e) {
      console.error(`[${req.method} ${req.originalUrl}]`, e)
      const r = readableError(e)
      return fail(res, r.code, r.message)
    }
  }
}
