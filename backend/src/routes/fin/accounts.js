// 账户管理：余额、期初、内部转账、余额核对
import express from 'express'
import prisma from '../../lib/prisma.js'
import { crudRouter } from '../../lib/crud.js'
import { requirePermission, maskAccountNo, scopeWhere, inScope, can } from '../../lib/auth.js'
import { ok, badRequest, notFound, wrap } from '../../lib/response.js'
import { recalcAccountBalance } from '../../lib/balance.js'
import { withCodes } from '../../lib/code.js'
import { toDate } from '../../lib/period.js'
import { logAudit } from '../../lib/audit.js'
import { Prisma } from '@prisma/client'
import { round2 } from '../../lib/money.js'

const router = express.Router()

// 汇总：集团/各公司余额（放在 crudRouter 之前，避免被 /:id 吃掉）
router.get('/summary', requirePermission('account.view'), wrap(async (req, res) => {
  const where = { deletedAt: null, status: 'ACTIVE', ...scopeWhere(req.user) }
  const accounts = await prisma.account.findMany({
    where,
    include: { company: { select: { id: true, code: true, name: true, sortOrder: true } } }
  })
  const byCompany = new Map()
  for (const a of accounts) {
    const key = String(a.companyId)
    if (!byCompany.has(key)) {
      byCompany.set(key, { companyId: key, code: a.company.code, name: a.company.name, sortOrder: a.company.sortOrder, currencies: {}, accounts: [] })
    }
    const item = byCompany.get(key)
    item.currencies[a.currency] = Number(item.currencies[a.currency] || 0) + Number(a.balance)
    item.accounts.push({
      id: String(a.id), name: a.name, type: a.type, currency: a.currency,
      balance: a.balance, balanceAt: a.balanceAt, isPrimary: a.isPrimary,
      initialBalance: a.initialBalance, initialDate: a.initialDate,
      accountNo: maskAccountNo(a.accountNo, req.user)
    })
  }
  const companies = [...byCompany.values()].sort((a, b) => a.sortOrder - b.sortOrder)
  const groupTotal = {}
  for (const c of companies) {
    for (const [cur, v] of Object.entries(c.currencies)) {
      c.currencies[cur] = round2(v)
      groupTotal[cur] = round2(Number(groupTotal[cur] || 0) + v)
    }
  }
  return ok(res, { companies, groupTotal })
}))

// 内部转账：一次生成两条互指的流水
router.post('/transfer', requirePermission('transaction.manage'), wrap(async (req, res) => {
  const { fromAccountId, toAccountId, amount, txnDate, remark } = req.body || {}
  if (!fromAccountId || !toAccountId || !amount) return badRequest(res, '请填写转出账户、转入账户和金额')
  if (String(fromAccountId) === String(toAccountId)) return badRequest(res, '转出与转入账户不能相同')

  const [from, to] = await Promise.all([
    prisma.account.findUnique({ where: { id: BigInt(fromAccountId) } }),
    prisma.account.findUnique({ where: { id: BigInt(toAccountId) } })
  ])
  // 数据范围：转出、转入两个账户都必须在可见公司内（公司间转账也一样，看不到对方公司就不能往那边转）
  if (!from || from.deletedAt || !inScope(req.user, from.companyId)) return notFound(res, '转出账户不存在')
  if (!to || to.deletedAt || !inScope(req.user, to.companyId)) return notFound(res, '转入账户不存在')
  if (from.currency !== to.currency) return badRequest(res, '暂不支持跨币种转账，请分别登记两笔流水')

  const date = toDate(txnDate) || new Date()
  const amt = new Prisma.Decimal(amount)
  const isInter = from.companyId !== to.companyId
  const bizType = isInter ? 'INTERCOMPANY' : 'TRANSFER'

  // 一次取两个连续编号：转出、转入各一个（以前是转出号 +1 硬算，并发时会和别人的号撞）
  const result = await withCodes('TXN', { date, count: 2 }, ([outCode, inCode]) => prisma.$transaction(async (tx) => {
    const outTxn = await tx.transaction.create({
      data: {
        code: outCode, companyId: from.companyId, accountId: from.id, txnDate: date,
        direction: 'OUT', amount: amt, currency: from.currency,
        counterparty: to.name, bizType, status: 'RECONCILED',
        remark: remark || `转账至 ${to.name}`
      }
    })
    const inTxn = await tx.transaction.create({
      data: {
        code: inCode,
        companyId: to.companyId, accountId: to.id, txnDate: date,
        direction: 'IN', amount: amt, currency: to.currency,
        counterparty: from.name, bizType, status: 'RECONCILED',
        transferPairId: outTxn.id,
        remark: remark || `由 ${from.name} 转入`
      }
    })
    await tx.transaction.update({ where: { id: outTxn.id }, data: { transferPairId: inTxn.id } })
    return { outTxn, inTxn }
  }))

  await Promise.all([recalcAccountBalance(from.id), recalcAccountBalance(to.id)])
  await logAudit(req, { action: 'CREATE', entity: 'transfer', entityId: result.outTxn.id, summary: `${from.name} → ${to.name} 转账 ${amount}` })
  return ok(res, result)
}))

router.use(crudRouter({
  model: 'account',
  entity: 'account',
  perms: { view: 'account.view', manage: 'account.manage' },
  fields: ['companyId', 'name', 'type', 'bankName', 'accountNo', 'currency', 'initialBalance', 'initialDate', 'balance', 'balanceAt', 'isPrimary', 'status', 'remark'],
  dateFields: ['balanceAt', 'initialDate'],
  searchFields: ['name', 'bankName', 'accountNo'],
  filters: { status: 'status', type: 'type' },
  include: { company: { select: { id: true, code: true, name: true } } },
  orderBy: [{ companyId: 'asc' }, { isPrimary: 'desc' }, { id: 'asc' }],
  required: ['companyId', 'name'],
  hooks: {
    beforeCreate: (data) => {
      // 新建账户时把期初余额同步成当前余额，之后由流水推算
      if (data.initialBalance != null && data.balance == null) data.balance = data.initialBalance
      return { data }
    },
    afterWrite: async (row) => { await recalcAccountBalance(row.id) }
  }
}))

// 余额核对：账面余额 vs 流水推算余额
router.get('/:id/reconcile', requirePermission('account.view'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const account = await prisma.account.findFirst({ where: { id, deletedAt: null } })
  if (!account) return notFound(res)

  const rows = await prisma.transaction.groupBy({
    by: ['direction'], where: { accountId: id, deletedAt: null }, _sum: { amount: true }, _count: true
  })
  const sum = (d) => Number(rows.find((r) => r.direction === d)?._sum.amount || 0)
  const computed = Number(account.initialBalance) + sum('IN') - sum('OUT')
  const unreconciled = await prisma.transaction.count({ where: { accountId: id, deletedAt: null, status: 'UNRECONCILED' } })

  return ok(res, {
    account: { ...account, accountNo: maskAccountNo(account.accountNo, req.user) },
    initialBalance: Number(account.initialBalance),
    incomeTotal: sum('IN'),
    expenseTotal: sum('OUT'),
    computedBalance: Math.round(computed * 100) / 100,
    recordedBalance: Number(account.balance),
    diff: Math.round((Number(account.balance) - computed) * 100) / 100,
    txnCount: rows.reduce((s, r) => s + r._count, 0),
    unreconciledCount: unreconciled
  })
}))

export default router
