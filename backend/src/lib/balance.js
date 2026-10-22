// 账户余额 = 期初余额 + 收入合计 - 支出合计（只认未删除流水）
// 任何流水增删改后都必须调用，保证「余额与流水永远对得上」
import prisma from './prisma.js'
import { Prisma } from '@prisma/client'

export async function recalcAccountBalance(accountId) {
  const id = BigInt(accountId)
  const account = await prisma.account.findUnique({ where: { id } })
  if (!account) return null

  const rows = await prisma.transaction.groupBy({
    by: ['direction'],
    where: { accountId: id, deletedAt: null },
    _sum: { amount: true }
  })
  const sum = (dir) =>
    new Prisma.Decimal(rows.find((r) => r.direction === dir)?._sum.amount || 0)

  const balance = new Prisma.Decimal(account.initialBalance).plus(sum('IN')).minus(sum('OUT'))
  return prisma.account.update({
    where: { id },
    data: { balance, balanceAt: new Date() }
  })
}

export async function recalcCompanyAccounts(companyId) {
  const accounts = await prisma.account.findMany({
    where: { companyId: BigInt(companyId), deletedAt: null },
    select: { id: true }
  })
  for (const a of accounts) await recalcAccountBalance(a.id)
}
