// 公司管理 + 单公司财务概览
import express from 'express'
import prisma from '../../lib/prisma.js'
import { crudRouter } from '../../lib/crud.js'
import { requirePermission, scopeWhere } from '../../lib/auth.js'
import { ok, notFound, wrap } from '../../lib/response.js'
import { periodRange, nowPeriod } from '../../lib/period.js'

const router = express.Router()

router.use(crudRouter({
  model: 'company',
  entity: 'company',
  perms: { view: 'company.view', manage: 'company.manage' },
  fields: ['code', 'name', 'taxNo', 'legalPerson', 'mainBusiness', 'sharePercent', 'capital', 'sortOrder', 'status', 'remark'],
  searchFields: ['code', 'name', 'taxNo'],
  filters: { status: 'status' },
  orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  scoped: false,
  required: ['code', 'name']
}))

// 单公司财务概览：账户余额 + 当月收支 + 待收待付
router.get('/:id/overview', requirePermission('company.view'), wrap(async (req, res) => {
  const companyId = BigInt(req.params.id)
  const period = req.query.period || nowPeriod()
  const { start, end } = periodRange(period)

  const company = await prisma.company.findFirst({ where: { id: companyId, deletedAt: null } })
  if (!company) return notFound(res)

  const [accounts, income, expense, receivable, payable, unreconciled] = await Promise.all([
    prisma.account.findMany({ where: { companyId, deletedAt: null, status: 'ACTIVE' }, orderBy: { isPrimary: 'desc' } }),
    prisma.transaction.aggregate({
      where: { companyId, deletedAt: null, direction: 'IN', txnDate: { gte: start, lte: end } },
      _sum: { amount: true }, _count: true
    }),
    prisma.transaction.aggregate({
      where: { companyId, deletedAt: null, direction: 'OUT', txnDate: { gte: start, lte: end } },
      _sum: { amount: true }, _count: true
    }),
    prisma.receivable.aggregate({
      where: { companyId, deletedAt: null, status: { in: ['PENDING', 'PARTIAL'] } },
      _sum: { amount: true, receivedAmount: true }
    }),
    prisma.payment.aggregate({
      where: { companyId, deletedAt: null, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } },
      _sum: { amount: true }
    }),
    prisma.transaction.count({ where: { companyId, deletedAt: null, status: 'UNRECONCILED' } })
  ])

  const balanceByCurrency = {}
  for (const a of accounts) {
    balanceByCurrency[a.currency] = Number(balanceByCurrency[a.currency] || 0) + Number(a.balance)
  }

  return ok(res, {
    company,
    period,
    accounts,
    balanceByCurrency,
    income: Number(income._sum.amount || 0),
    incomeCount: income._count,
    expense: Number(expense._sum.amount || 0),
    expenseCount: expense._count,
    netCashFlow: Number(income._sum.amount || 0) - Number(expense._sum.amount || 0),
    pendingReceivable: Number(receivable._sum.amount || 0) - Number(receivable._sum.receivedAmount || 0),
    pendingPayment: Number(payable._sum.amount || 0),
    unreconciledCount: unreconciled
  })
}))

export default router
