// 管理驾驶舱（需求 §6.1）
import express from 'express'
import prisma from '../../lib/prisma.js'
import { requirePermission, scopeWhere } from '../../lib/auth.js'
import { ok, wrap } from '../../lib/response.js'
import { periodRange, nowPeriod, lastPeriods } from '../../lib/period.js'
import { forecast } from '../../lib/forecast.js'
import { round2 } from '../../lib/money.js'

const router = express.Router()

router.get('/', requirePermission('dashboard.view'), wrap(async (req, res) => {
  const scope = scopeWhere(req.user)
  const period = req.query.period || nowPeriod()
  const { start, end } = periodRange(period)
  const inMonth = { gte: start, lte: end }

  const [companies, accounts, income, expense, receivable, payment, unreconciled, overdueAR, overduePay] = await Promise.all([
    prisma.company.findMany({ where: { deletedAt: null, status: 'ACTIVE', ...scopeWhere(req.user, 'id') }, orderBy: { sortOrder: 'asc' } }),
    prisma.account.findMany({ where: { deletedAt: null, status: 'ACTIVE', ...scope } }),
    prisma.transaction.aggregate({ where: { deletedAt: null, ...scope, direction: 'IN', txnDate: inMonth }, _sum: { amount: true }, _count: true }),
    prisma.transaction.aggregate({ where: { deletedAt: null, ...scope, direction: 'OUT', txnDate: inMonth }, _sum: { amount: true }, _count: true }),
    prisma.receivable.aggregate({ where: { deletedAt: null, ...scope, status: { in: ['PENDING', 'PARTIAL'] } }, _sum: { amount: true, receivedAmount: true }, _count: true }),
    prisma.payment.aggregate({ where: { deletedAt: null, ...scope, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } }, _sum: { amount: true }, _count: true }),
    prisma.transaction.count({ where: { deletedAt: null, ...scope, status: 'UNRECONCILED' } }),
    prisma.receivable.count({ where: { deletedAt: null, ...scope, status: { in: ['PENDING', 'PARTIAL'] }, expectDate: { lt: new Date() } } }),
    prisma.payment.count({ where: { deletedAt: null, ...scope, status: { in: ['PENDING_APPROVAL', 'APPROVED'] }, planDate: { lt: new Date() } } })
  ])

  // 各公司余额（按币种）
  const companyMap = new Map(companies.map((c) => [String(c.id), {
    id: String(c.id), code: c.code, name: c.name, currencies: {}, total: 0
  }]))
  const groupTotal = {}
  for (const a of accounts) {
    const item = companyMap.get(String(a.companyId))
    if (!item) continue
    item.currencies[a.currency] = round2(Number(item.currencies[a.currency] || 0) + Number(a.balance))
    if (a.currency === 'CNY') item.total = round2(item.total + Number(a.balance))
    groupTotal[a.currency] = round2(Number(groupTotal[a.currency] || 0) + Number(a.balance))
  }

  // 近 12 个月收支趋势（集团口径）
  const periods = lastPeriods(12)
  const trendStart = periodRange(periods[0]).start
  const trendRows = await prisma.$queryRawUnsafe(`
    SELECT DATE_FORMAT(t.txn_date, '%Y-%m') AS period, t.direction, SUM(t.amount) AS total
    FROM transactions t
    WHERE t.deleted_at IS NULL AND t.txn_date >= ?
    ${req.user.companyScope?.length ? `AND t.company_id IN (${req.user.companyScope.map(Number).join(',')})` : ''}
    GROUP BY period, t.direction ORDER BY period
  `, trendStart)
  const trend = periods.map((p) => {
    const i = trendRows.find((r) => r.period === p && r.direction === 'IN')
    const o = trendRows.find((r) => r.period === p && r.direction === 'OUT')
    const inc = Number(i?.total || 0)
    const exp = Number(o?.total || 0)
    return { period: p, income: inc, expense: exp, net: round2(inc - exp) }
  })

  const cash = await forecast(req.user, { days: [30, 60, 90] })

  return ok(res, {
    period,
    groupTotal,
    companies: [...companyMap.values()],
    income: Number(income._sum.amount || 0),
    expense: Number(expense._sum.amount || 0),
    netCashFlow: round2(Number(income._sum.amount || 0) - Number(expense._sum.amount || 0)),
    incomeCount: income._count,
    expenseCount: expense._count,
    pendingReceivable: round2(Number(receivable._sum.amount || 0) - Number(receivable._sum.receivedAmount || 0)),
    pendingReceivableCount: receivable._count,
    pendingPayment: Number(payment._sum.amount || 0),
    pendingPaymentCount: payment._count,
    unreconciledCount: unreconciled,
    overdueReceivableCount: overdueAR,
    overduePaymentCount: overduePay,
    trend,
    forecast: cash
  })
}))

export default router
