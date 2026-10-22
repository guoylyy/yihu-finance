// 应收 / 收款：登记应收 → 登记回款（自动生成流水）→ 状态流转
import express from 'express'
import prisma from '../../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { crudRouter } from '../../lib/crud.js'
import { requirePermission, scopeWhere } from '../../lib/auth.js'
import { ok, badRequest, notFound, wrap } from '../../lib/response.js'
import { nextCode } from '../../lib/code.js'
import { toDate } from '../../lib/period.js'
import { recalcAccountBalance } from '../../lib/balance.js'
import { logAudit } from '../../lib/audit.js'
import { assertPeriodOpen } from '../../lib/close.js'

const router = express.Router()

const INCLUDE = {
  company: { select: { id: true, code: true, name: true } },
  customer: { select: { id: true, name: true } },
  project: { select: { id: true, name: true } }
}

// 逾期应收（放在 /:id 之前）
router.get('/overdue', requirePermission('receivable.view'), wrap(async (req, res) => {
  const list = await prisma.receivable.findMany({
    where: {
      deletedAt: null, ...scopeWhere(req.user),
      status: { in: ['PENDING', 'PARTIAL'] },
      expectDate: { lt: new Date() }
    },
    include: INCLUDE, orderBy: { expectDate: 'asc' }
  })
  const total = list.reduce((s, r) => s + Number(r.amount) - Number(r.receivedAmount), 0)
  return ok(res, { list, total: Math.round(total * 100) / 100, count: list.length })
}))

router.use(crudRouter({
  model: 'receivable', entity: 'receivable',
  perms: { view: 'receivable.view', manage: 'receivable.manage' },
  fields: ['companyId', 'customerId', 'projectId', 'contractNo', 'title', 'amount', 'expectDate', 'confidence', 'status', 'remark'],
  dateFields: ['expectDate'],
  searchFields: ['code', 'title', 'contractNo'],
  filters: { status: 'status', customer_id: 'customerId' },
  dateRangeField: 'expectDate',
  include: INCLUDE,
  required: ['companyId', 'title', 'amount'],
  hooks: {
    beforeCreate: async (data) => {
      data.code = await nextCode('AR', { monthly: false })
      return { data }
    }
  }
}))

// 登记回款：写一笔收入流水并回填已收金额
router.post('/:id/receipt', requirePermission('receivable.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const { accountId, amount, receiptDate, remark } = req.body || {}
  if (!accountId || !amount) return badRequest(res, '请填写收款账户和金额')

  const ar = await prisma.receivable.findFirst({ where: { id, deletedAt: null } })
  if (!ar) return notFound(res)

  const account = await prisma.account.findFirst({ where: { id: BigInt(accountId), deletedAt: null } })
  if (!account) return notFound(res, '收款账户不存在')

  const date = toDate(receiptDate) || new Date()
  const locked = await assertPeriodOpen(ar.companyId, date)
  if (locked) return badRequest(res, locked)

  const amt = new Prisma.Decimal(amount)
  const received = new Prisma.Decimal(ar.receivedAmount).plus(amt)
  const status = received.gte(ar.amount) ? 'RECEIVED' : 'PARTIAL'
  const customer = ar.customerId ? await prisma.customer.findUnique({ where: { id: ar.customerId } }) : null

  const txn = await prisma.transaction.create({
    data: {
      code: await nextCode('TXN', { date }),
      companyId: ar.companyId, accountId: account.id, txnDate: date,
      direction: 'IN', amount: amt, currency: account.currency,
      counterparty: customer?.name || ar.title,
      bizType: 'SALES_RECEIPT', projectId: ar.projectId,
      refType: 'RECEIVABLE', refId: ar.id,
      status: 'RECONCILED',
      remark: remark || `${ar.code} 回款`
    }
  })
  const updated = await prisma.receivable.update({
    where: { id },
    data: { receivedAmount: received, status, actualDate: date },
    include: INCLUDE
  })
  await recalcAccountBalance(account.id)
  await logAudit(req, { action: 'UPDATE', entity: 'receivable', entityId: id, summary: `${ar.code} 登记回款 ${amount}`, before: ar, after: updated })
  return ok(res, { receivable: updated, transaction: txn })
}))

export default router
