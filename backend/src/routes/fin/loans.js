// 借款与公司间往来：借出/借入/代付/拆借 + 还款冲账
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

const router = express.Router()
const INCLUDE = {
  company: { select: { id: true, code: true, name: true } },
  person: { select: { id: true, name: true } },
  repayments: { orderBy: { repayDate: 'asc' } }
}

router.get('/summary', requirePermission('loan.view'), wrap(async (req, res) => {
  const where = { deletedAt: null, ...scopeWhere(req.user), status: { not: 'CLOSED' } }
  const list = await prisma.loan.findMany({ where, include: INCLUDE, orderBy: { dueDate: 'asc' } })
  const outstanding = list.reduce((s, l) => s + Number(l.principal) - Number(l.repaidAmount), 0)
  const overdue = list.filter((l) => l.dueDate && l.dueDate < new Date())
  return ok(res, {
    count: list.length,
    outstanding: Math.round(outstanding * 100) / 100,
    overdueCount: overdue.length,
    overdueAmount: Math.round(overdue.reduce((s, l) => s + Number(l.principal) - Number(l.repaidAmount), 0) * 100) / 100,
    list
  })
}))

router.use(crudRouter({
  model: 'loan', entity: 'loan',
  perms: { view: 'loan.view', manage: 'loan.manage' },
  fields: ['companyId', 'direction', 'counterpartyName', 'personId', 'relatedCompanyId', 'principal',
    'interestRate', 'startDate', 'dueDate', 'status', 'remark'],
  dateFields: ['startDate', 'dueDate'],
  searchFields: ['code', 'counterpartyName'],
  filters: { status: 'status', direction: 'direction' },
  dateRangeField: 'dueDate',
  include: INCLUDE,
  required: ['companyId', 'direction', 'principal'],
  hooks: {
    beforeCreate: async (data) => {
      data.code = await nextCode('LN', { monthly: false })
      return { data }
    }
  }
}))

// 登记还款：可选同时生成流水
router.post('/:id/repay', requirePermission('loan.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const { amount, repayDate, accountId, remark, createTransaction = true } = req.body || {}
  if (!amount) return badRequest(res, '请填写还款金额')

  const loan = await prisma.loan.findFirst({ where: { id, deletedAt: null } })
  if (!loan) return notFound(res)

  const date = toDate(repayDate) || new Date()
  let txn = null
  if (createTransaction && accountId) {
    const account = await prisma.account.findFirst({ where: { id: BigInt(accountId), deletedAt: null } })
    if (!account) return notFound(res, '账户不存在')
    // 公司借出的钱收回 = 收入；公司借入的钱归还 = 支出
    const direction = ['COMPANY_TO_PERSON', 'COMPANY_TO_COMPANY', 'ADVANCE'].includes(loan.direction) ? 'IN' : 'OUT'
    txn = await prisma.transaction.create({
      data: {
        code: await nextCode('TXN', { date }),
        companyId: loan.companyId, accountId: account.id, txnDate: date,
        direction, amount: new Prisma.Decimal(amount), currency: account.currency,
        counterparty: loan.counterpartyName, bizType: 'REPAY',
        refType: 'LOAN', refId: loan.id, status: 'RECONCILED',
        remark: remark || `${loan.code} 还款`
      }
    })
    await recalcAccountBalance(account.id)
  }

  await prisma.loanRepayment.create({
    data: { loanId: id, repayDate: date, amount: new Prisma.Decimal(amount), transactionId: txn?.id || null, remark }
  })
  const repaid = new Prisma.Decimal(loan.repaidAmount).plus(amount)
  const status = repaid.gte(loan.principal) ? 'CLOSED' : 'PARTIAL'
  const updated = await prisma.loan.update({ where: { id }, data: { repaidAmount: repaid, status }, include: INCLUDE })

  await logAudit(req, { action: 'UPDATE', entity: 'loan', entityId: id, summary: `${loan.code} 还款 ${amount}`, before: loan, after: updated })
  return ok(res, { loan: updated, transaction: txn })
}))

export default router
