// 经营分析（需求 §6.2）：收支趋势 / 费用排名 / 人力成本 / 项目 / 供应商
import express from 'express'
import prisma from '../../lib/prisma.js'
import { requirePermission, scopeWhere } from '../../lib/auth.js'
import { ok, wrap } from '../../lib/response.js'
import { lastPeriods, periodRange } from '../../lib/period.js'
import { round2 } from '../../lib/money.js'

const router = express.Router()

// 拼 where 片段：一律带表别名，join 查询里 deleted_at / company_id 两边都有，不加前缀会 ambiguous
function scopeSql(req, alias = 't') {
  const a = alias ? `${alias}.` : ''
  const ids = req.user?.companyScope
  const parts = [`${a}deleted_at IS NULL`]
  if (req.query.company_id) parts.push(`${a}company_id = ${Number(req.query.company_id)}`)
  // 数据范围始终叠加（不是 else）：指定了公司也不能越出范围
  if (Array.isArray(ids) && ids.length) parts.push(`${a}company_id IN (${ids.map(Number).join(',')})`)
  return parts.join(' AND ')
}

router.get('/trend', requirePermission('analytics.view'), wrap(async (req, res) => {
  const months = Number(req.query.months) || 12
  const periods = lastPeriods(months)
  const start = periodRange(periods[0]).start
  const rows = await prisma.$queryRawUnsafe(`
    SELECT DATE_FORMAT(t.txn_date,'%Y-%m') AS period, t.direction, SUM(t.amount) AS total, COUNT(*) AS cnt
    FROM transactions t WHERE ${scopeSql(req)} AND t.txn_date >= ?
    GROUP BY period, t.direction ORDER BY period
  `, start)
  const list = periods.map((p) => {
    const inc = Number(rows.find((r) => r.period === p && r.direction === 'IN')?.total || 0)
    const exp = Number(rows.find((r) => r.period === p && r.direction === 'OUT')?.total || 0)
    return { period: p, income: inc, expense: exp, net: round2(inc - exp) }
  })
  return ok(res, { list })
}))

router.get('/by-category', requirePermission('analytics.view'), wrap(async (req, res) => {
  const { period_from, period_to, direction = 'OUT' } = req.query
  const from = period_from ? periodRange(period_from).start : periodRange(lastPeriods(12)[0]).start
  const to = period_to ? periodRange(period_to).end : new Date()
  const rows = await prisma.$queryRawUnsafe(`
    SELECT t.biz_type AS bizType, c.name AS categoryName, SUM(t.amount) AS total, COUNT(*) AS cnt
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE ${scopeSql(req)} AND t.direction = ? AND t.txn_date BETWEEN ? AND ?
    GROUP BY t.biz_type, c.name ORDER BY total DESC
  `, direction, from, to)
  return ok(res, {
    list: rows.map((r) => ({ bizType: r.bizType, categoryName: r.categoryName, total: Number(r.total), count: Number(r.cnt) })),
    total: round2(rows.reduce((s, r) => s + Number(r.total), 0))
  })
}))

router.get('/by-company', requirePermission('analytics.view'), wrap(async (req, res) => {
  const months = Number(req.query.months) || 6
  const start = periodRange(lastPeriods(months)[0]).start
  const rows = await prisma.$queryRawUnsafe(`
    SELECT c.code, c.name, t.direction, SUM(t.amount) AS total
    FROM transactions t JOIN companies c ON c.id = t.company_id
    WHERE ${scopeSql(req)} AND t.txn_date >= ?
    GROUP BY c.code, c.name, t.direction
  `, start)
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.code)) map.set(r.code, { code: r.code, name: r.name, income: 0, expense: 0 })
    const item = map.get(r.code)
    if (r.direction === 'IN') item.income = Number(r.total)
    else item.expense = Number(r.total)
  }
  const list = [...map.values()].map((i) => ({ ...i, net: round2(i.income - i.expense) }))
  return ok(res, { list, months })
}))

// 人力成本：工资 + 劳务费 + 报销
router.get('/labor-cost', requirePermission('analytics.view'), wrap(async (req, res) => {
  const months = Number(req.query.months) || 12
  const periods = lastPeriods(months)
  const start = periodRange(periods[0]).start
  const rows = await prisma.$queryRawUnsafe(`
    SELECT DATE_FORMAT(t.txn_date,'%Y-%m') AS period, t.biz_type AS bizType, SUM(t.amount) AS total
    FROM transactions t
    WHERE ${scopeSql(req)} AND t.direction='OUT' AND t.txn_date >= ?
      AND t.biz_type IN ('SALARY','LABOR','REIMBURSE')
    GROUP BY period, t.biz_type ORDER BY period
  `, start)
  const list = periods.map((p) => {
    const pick = (t) => Number(rows.find((r) => r.period === p && r.bizType === t)?.total || 0)
    const salary = pick('SALARY')
    const labor = pick('LABOR')
    const reimburse = pick('REIMBURSE')
    return { period: p, salary, labor, reimburse, total: round2(salary + labor + reimburse) }
  })
  return ok(res, { list })
}))

// 支出对手方 TOP N（供应商 / 收款方）
router.get('/top-counterparty', requirePermission('analytics.view'), wrap(async (req, res) => {
  const months = Number(req.query.months) || 6
  const limit = Number(req.query.limit) || 15
  const start = periodRange(lastPeriods(months)[0]).start
  const rows = await prisma.$queryRawUnsafe(`
    SELECT t.counterparty, SUM(t.amount) AS total, COUNT(*) AS cnt
    FROM transactions t
    WHERE ${scopeSql(req)} AND t.direction = ? AND t.txn_date >= ?
      AND t.counterparty IS NOT NULL AND t.counterparty <> ''
    GROUP BY t.counterparty ORDER BY total DESC LIMIT ${limit}
  `, req.query.direction || 'OUT', start)
  return ok(res, { list: rows.map((r) => ({ name: r.counterparty, total: Number(r.total), count: Number(r.cnt) })) })
}))

// 项目收支
router.get('/by-project', requirePermission('analytics.view'), wrap(async (req, res) => {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT p.name, t.direction, SUM(t.amount) AS total
    FROM transactions t JOIN projects p ON p.id = t.project_id
    WHERE ${scopeSql(req)}
    GROUP BY p.name, t.direction
  `)
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.name)) map.set(r.name, { name: r.name, income: 0, expense: 0 })
    const item = map.get(r.name)
    if (r.direction === 'IN') item.income = Number(r.total)
    else item.expense = Number(r.total)
  }
  return ok(res, { list: [...map.values()].map((i) => ({ ...i, net: round2(i.income - i.expense) })) })
}))

export default router
