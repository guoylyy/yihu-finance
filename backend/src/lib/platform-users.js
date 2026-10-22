// 平台用户 → 本系统用户
// 1. 已绑定（platformUserId）→ 直接用
// 2. 没绑定但用户名相同 → 绑定（老用户第一次从平台进来）
// 3. 都没有 → 新建：平台管理员建成 ADMIN，其他人建成 STAFF（只能提交报销），由管理员在「用户管理」里调角色和数据范围
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import prisma from './prisma.js'
import { signToken } from './auth.js'
import { logAudit } from './audit.js'

export async function resolveUser(pu) {
  if (!pu?.id) throw new Error('没有拿到平台身份，请从工作台重新打开')
  let user = await prisma.user.findFirst({ where: { platformUserId: Number(pu.id), deletedAt: null } })
  if (!user && pu.username) {
    const same = await prisma.user.findFirst({ where: { username: pu.username, deletedAt: null, platformUserId: null } })
    if (same) user = await prisma.user.update({ where: { id: same.id }, data: { platformUserId: Number(pu.id) } })
  }
  if (!user) {
    const role = pu.roles?.includes('ADMIN') ? 'ADMIN' : 'STAFF'
    let username = pu.username || `yh${pu.id}`
    if (await prisma.user.findFirst({ where: { username } })) username = `yh${pu.id}`
    user = await prisma.user.create({
      data: {
        username, name: pu.name || username, role, platformUserId: Number(pu.id), phone: pu.mobile || null,
        // 统一登录的用户不用本地密码：随机一个，不告诉任何人
        passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
        remark: '以虎 One 统一登录自动创建'
      }
    })
    await logAudit({ user: { id: String(user.id), name: user.name }, headers: {} }, {
      action: 'user.create.platform', entity: 'user', entityId: user.id, summary: `以虎 One 统一登录自动创建，角色 ${role}`
    })
  }
  if (user.status !== 'ACTIVE') throw new Error('你在集团财务里的账号已停用，请联系管理员')
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), ...(pu.name && pu.name !== user.name ? { name: pu.name } : {}) } })
  return { ...user, name: pu.name || user.name }
}

/** 与账号密码登录签发的 token 一致 */
export function signFor(user, expiresIn) {
  return signToken({
    id: String(user.id), username: user.username, name: user.name, role: user.role, companyScope: user.companyScope || null
  }, expiresIn)
}
