// 月结工作台（需求 §5.9）
import express from 'express'
import prisma from '../../lib/prisma.js'
import { requirePermission, scopeWhere } from '../../lib/auth.js'
import { ok, badRequest, notFound, wrap } from '../../lib/response.js'
import { buildChecklist, buildSummaryMd } from '../../lib/close.js'
import { periodRange, nowPeriod } from '../../lib/period.js'
import { logAudit } from '../../lib/audit.js'
import { round2 } from '../../lib/money.js'

const router = express.Router()

router.get('/', requirePermission('close.view'), wrap(async (req, res) => {
  const where = { deletedAt: null, AND: [scopeWhere(req.user)] } // 范围放 AND，下面的 company_id 不能覆盖它
  if (req.query.company_id) where.companyId = BigInt(req.query.company_id)
  if (req.query.period) where.period = req.query.period
  const list = await prisma.closePeriod.findMany({
    where, include: { company: { select: { id: true, code: true, name: true } } },
    orderBy: [{ period: 'desc' }, { companyId: 'asc' }], take: 200
  })
  return ok(res, { list })
}))

// 月结工作台：某公司某月的检查清单 + 当前状态
router.get('/checklist', requirePermission('close.view'), wrap(async (req, res) => {
  const { company_id, period = nowPeriod() } = req.query
  if (!company_id) return badRequest(res, '请选择公司')
  const [checklist, record] = await Promise.all([
    buildChecklist(company_id, period),
    prisma.closePeriod.findFirst({ where: { companyId: BigInt(company_id), period, deletedAt: null } })
  ])
  return ok(res, { ...checklist, record })
}))

router.get('/summary', requirePermission('close.view'), wrap(async (req, res) => {
  const { company_id, period = nowPeriod() } = req.query
  if (!company_id) return badRequest(res, '请选择公司')
  const md = await buildSummaryMd(company_id, period)
  if (req.query.download === '1') {
    const company = await prisma.company.findUnique({ where: { id: BigInt(company_id) } })
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="close-${company.code}-${period}.md"`)
    return res.send(md)
  }
  return ok(res, { markdown: md })
}))

// 锁定月份
router.post('/close', requirePermission('close.manage'), wrap(async (req, res) => {
  const { companyId, period, force = false } = req.body || {}
  if (!companyId || !period) return badRequest(res, '请选择公司和月份')

  const checklist = await buildChecklist(companyId, period)
  const failed = checklist.items.filter((i) => !i.pass)
  if (failed.length && !force) {
    return badRequest(res, `还有 ${failed.length} 项检查未通过：${failed.map((f) => f.title).join('、')}。确认无误可勾选「强制月结」`)
  }

  // 期末余额要算「截至当月最后一天」的口径，不能直接取账户当前余额
  // （当前余额已包含下个月发生的流水，直接用会把月结数做错）
  const { end } = periodRange(period)
  const accounts = await prisma.account.findMany({
    where: { companyId: BigInt(companyId), deletedAt: null, status: 'ACTIVE', currency: 'CNY' }
  })
  let endingBalance = 0
  for (const a of accounts) {
    const rows = await prisma.transaction.groupBy({
      by: ['direction'],
      where: { accountId: a.id, deletedAt: null, txnDate: { lte: end } },
      _sum: { amount: true }
    })
    const sum = (d) => Number(rows.find((r) => r.direction === d)?._sum.amount || 0)
    endingBalance += Number(a.initialBalance) + sum('IN') - sum('OUT')
  }
  endingBalance = round2(endingBalance)
  const summaryMd = await buildSummaryMd(companyId, period)

  const data = {
    companyId: BigInt(companyId), period, status: 'CLOSED',
    incomeTotal: checklist.incomeTotal, expenseTotal: checklist.expenseTotal,
    netCashFlow: checklist.netCashFlow, endingBalance,
    checklist: checklist.items, summaryMd,
    closedAt: new Date(), closedBy: req.user.name
  }
  const row = await prisma.closePeriod.upsert({
    where: { companyId_period: { companyId: BigInt(companyId), period } },
    create: data, update: data
  })
  await logAudit(req, { action: 'CLOSE', entity: 'closePeriod', entityId: row.id, summary: `${period} 月结锁定${force ? '（强制）' : ''}` })
  return ok(res, row)
}))

router.post('/reopen', requirePermission('close.manage'), wrap(async (req, res) => {
  const { companyId, period, reason } = req.body || {}
  const row = await prisma.closePeriod.findFirst({ where: { companyId: BigInt(companyId), period, deletedAt: null } })
  if (!row) return notFound(res, '该月份没有月结记录')
  const updated = await prisma.closePeriod.update({
    where: { id: row.id }, data: { status: 'OPEN', remark: reason || row.remark }
  })
  await logAudit(req, { action: 'REOPEN', entity: 'closePeriod', entityId: row.id, summary: `${period} 解锁月结：${reason || '未填原因'}` })
  return ok(res, updated)
}))

export default router
