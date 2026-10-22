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

// 统一的路由 try/catch 包装，避免每个 handler 重复写
export function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (e) {
      console.error(`[${req.method} ${req.originalUrl}]`, e)
      return fail(res, 9001, e.message || '服务器内部错误')
    }
  }
}
