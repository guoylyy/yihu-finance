// 操作留痕：需求 §9「所有付款修改保留操作记录」
import prisma from './prisma.js'

export async function logAudit(req, { action, entity, entityId, summary, before, after }) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: req.user?.id ? BigInt(req.user.id) : null,
        userName: req.user?.name || req.user?.username || null,
        action,
        entity,
        entityId: entityId != null ? String(entityId) : null,
        summary: summary?.slice(0, 500) || null,
        before: before ? JSON.parse(JSON.stringify(before, bigintReplacer)) : null,
        after: after ? JSON.parse(JSON.stringify(after, bigintReplacer)) : null,
        ip: req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || null
      }
    })
  } catch (e) {
    // 审计失败不阻断主流程，但要在日志里看得见
    console.error('[audit] 写入失败:', e.message)
  }
}

function bigintReplacer(_k, v) {
  return typeof v === 'bigint' ? v.toString() : v
}
