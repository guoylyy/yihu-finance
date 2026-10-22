// 登录 / 当前用户
import express from 'express'
import bcrypt from 'bcryptjs'
import prisma from '../lib/prisma.js'
import { signToken, auth, PERMISSIONS } from '../lib/auth.js'
import { ok, fail, wrap } from '../lib/response.js'
import { localLoginAllowed } from '../lib/platform.js'

const router = express.Router()

router.post('/login', wrap(async (req, res) => {
  const { username, password, remember } = req.body || {}
  if (!localLoginAllowed()) return fail(res, 1007, '请从以虎 One 工作台进入（统一登录）')
  if (!username || !password) return fail(res, 9002, '请输入用户名和密码')

  const user = await prisma.user.findFirst({ where: { username, deletedAt: null } })
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return fail(res, 1004, '用户名或密码错误')
  }
  if (user.status !== 'ACTIVE') return fail(res, 1005, '账号已停用，请联系管理员')

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
  const payload = {
    id: String(user.id),
    username: user.username,
    name: user.name,
    role: user.role,
    companyScope: user.companyScope || null
  }
  return ok(res, { token: signToken(payload, remember ? '30d' : undefined), user: payload })
}))

router.get('/me', auth, wrap(async (req, res) => {
  const perms = Object.entries(PERMISSIONS)
    .filter(([, roles]) => roles.includes(req.user.role))
    .map(([p]) => p)
  return ok(res, { user: req.user, permissions: perms })
}))

router.post('/change-password', auth, wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  if (!newPassword || newPassword.length < 6) return fail(res, 9002, '新密码至少 6 位')
  const user = await prisma.user.findUnique({ where: { id: BigInt(req.user.id) } })
  if (!user || !(await bcrypt.compare(oldPassword || '', user.passwordHash))) {
    return fail(res, 1006, '原密码不正确')
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10) }
  })
  return ok(res, null, '密码已修改')
}))

export default router
