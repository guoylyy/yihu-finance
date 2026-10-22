// 用户与角色（仅管理员）
import express from 'express'
import bcrypt from 'bcryptjs'
import prisma from '../../lib/prisma.js'
import { requirePermission, PERMISSIONS } from '../../lib/auth.js'
import { ok, badRequest, notFound, wrap } from '../../lib/response.js'
import { logAudit } from '../../lib/audit.js'

const router = express.Router()
router.use(requirePermission('user.manage'))

const SAFE = { id: true, username: true, name: true, phone: true, role: true, companyScope: true, status: true, lastLoginAt: true, createdAt: true, remark: true }

router.get('/', wrap(async (req, res) => {
  const list = await prisma.user.findMany({ where: { deletedAt: null }, select: SAFE, orderBy: { id: 'asc' } })
  return ok(res, { list })
}))

router.get('/permissions', wrap(async (req, res) => {
  const roles = {}
  for (const [perm, list] of Object.entries(PERMISSIONS)) {
    for (const r of list) (roles[r] ||= []).push(perm)
  }
  return ok(res, { matrix: PERMISSIONS, roles })
}))

router.post('/', wrap(async (req, res) => {
  const { username, password, name, role, phone, companyScope, remark } = req.body || {}
  if (!username || !password || !name || !role) return badRequest(res, '用户名、密码、姓名、角色为必填')
  const exist = await prisma.user.findFirst({ where: { username, deletedAt: null } })
  if (exist) return badRequest(res, '用户名已存在')

  const row = await prisma.user.create({
    data: {
      username, name, role, phone, remark,
      passwordHash: await bcrypt.hash(password, 10),
      companyScope: companyScope?.length ? companyScope.map(String) : null
    },
    select: SAFE
  })
  await logAudit(req, { action: 'CREATE', entity: 'user', entityId: row.id, summary: `新建用户 ${username}` })
  return ok(res, row)
}))

router.put('/:id', wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const { name, role, phone, status, companyScope, password, remark } = req.body || {}
  const data = { name, role, phone, status, remark }
  if (companyScope !== undefined) data.companyScope = companyScope?.length ? companyScope.map(String) : null
  if (password) data.passwordHash = await bcrypt.hash(password, 10)
  const row = await prisma.user.update({ where: { id }, data, select: SAFE })
  await logAudit(req, { action: 'UPDATE', entity: 'user', entityId: id, summary: `修改用户 ${row.username}` })
  return ok(res, row)
}))

router.delete('/:id', wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  if (String(id) === String(req.user.id)) return badRequest(res, '不能停用自己的账号')
  const row = await prisma.user.update({ where: { id }, data: { deletedAt: new Date(), status: 'DISABLED' }, select: SAFE })
  await logAudit(req, { action: 'DELETE', entity: 'user', entityId: id, summary: `停用用户 ${row.username}` })
  return ok(res, { id: String(id) })
}))

export default router
