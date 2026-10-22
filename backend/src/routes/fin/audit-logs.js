// 操作日志
import express from 'express'
import prisma from '../../lib/prisma.js'
import { requirePermission } from '../../lib/auth.js'
import { ok, wrap } from '../../lib/response.js'
import { toDate } from '../../lib/period.js'

const router = express.Router()

router.get('/', requirePermission('audit.view'), wrap(async (req, res) => {
  const { page = 1, page_size = 30, entity, action, keyword, date_from, date_to } = req.query
  const take = Math.min(Number(page_size) || 30, 200)
  const where = {}
  if (entity) where.entity = entity
  if (action) where.action = action
  if (keyword) where.OR = [{ summary: { contains: keyword } }, { userName: { contains: keyword } }]
  if (date_from || date_to) {
    where.createdAt = {}
    if (date_from) where.createdAt.gte = toDate(date_from)
    if (date_to) where.createdAt.lte = new Date(toDate(date_to).getTime() + 86400000 - 1)
  }
  const [list, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: (Number(page) - 1) * take, take }),
    prisma.auditLog.count({ where })
  ])
  return ok(res, { list, total, page: Number(page), pageSize: take })
}))

export default router
