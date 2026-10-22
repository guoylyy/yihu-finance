// AI 助手可用的受控只读接口（需求 §4：AI 可读数据、可生成摘要，但没有付款权限）
import express from 'express'
import prisma from '../../lib/prisma.js'
import { requirePermission, scopeWhere } from '../../lib/auth.js'
import { ok, badRequest, wrap } from '../../lib/response.js'
import { buildSummaryMd, findDuplicateInvoices } from '../../lib/close.js'
import { nowPeriod, periodRange } from '../../lib/period.js'
import { round2 } from '../../lib/money.js'

const router = express.Router()

// 月报（Markdown）
router.get('/monthly-report', requirePermission('analytics.view'), wrap(async (req, res) => {
  const { company_id, period = nowPeriod() } = req.query
  if (!company_id) return badRequest(res, '请选择公司')
  return ok(res, { markdown: await buildSummaryMd(company_id, period) })
}))

/**
 * 异常清单：把「需要人看一眼」的事情集中列出来
 * 需求 §10-12：发现缺失账号、重复发票和未核对流水
 */
router.get('/anomalies', requirePermission('analytics.view'), wrap(async (req, res) => {
  const scope = req.query.company_id ? { companyId: BigInt(req.query.company_id) } : scopeWhere(req.user)
  const period = req.query.period || nowPeriod()
  const { start, end } = periodRange(period)
  const anomalies = []

  const [missingAccountItems, unreconciled, abnormal, overdueAR, overduePay, staleAccounts, noInvoiceBigExpense, companies] =
    await Promise.all([
      prisma.payrollItem.findMany({
        where: { status: 'MISSING_ACCOUNT', payroll: { deletedAt: null, ...scope } },
        include: { payroll: { select: { code: true, period: true, companyId: true } } }, take: 100
      }),
      prisma.transaction.findMany({
        where: { deletedAt: null, ...scope, status: 'UNRECONCILED' },
        select: { id: true, code: true, txnDate: true, amount: true, direction: true, counterparty: true, companyId: true },
        orderBy: { txnDate: 'desc' }, take: 100
      }),
      prisma.transaction.count({ where: { deletedAt: null, ...scope, status: 'ABNORMAL' } }),
      prisma.receivable.findMany({
        where: { deletedAt: null, ...scope, status: { in: ['PENDING', 'PARTIAL'] }, expectDate: { lt: new Date() } },
        include: { customer: { select: { name: true } } }, take: 50
      }),
      prisma.payment.findMany({
        where: { deletedAt: null, ...scope, status: { in: ['PENDING_APPROVAL', 'APPROVED'] }, planDate: { lt: new Date() } },
        take: 50
      }),
      prisma.account.findMany({
        where: { deletedAt: null, status: 'ACTIVE', ...scope, OR: [{ balanceAt: null }, { balanceAt: { lt: start } }] },
        include: { company: { select: { code: true } } }
      }),
      prisma.transaction.findMany({
        where: { deletedAt: null, ...scope, direction: 'OUT', invoiceId: null, txnDate: { gte: start, lte: end }, amount: { gte: 10000 } },
        select: { id: true, code: true, amount: true, counterparty: true, txnDate: true }, take: 50
      }),
      prisma.company.findMany({ where: { deletedAt: null, status: 'ACTIVE', ...scopeWhere(req.user, 'id') }, select: { id: true, code: true } })
    ])

  if (missingAccountItems.length) {
    anomalies.push({
      key: 'missing_account', level: 'warn', title: '工资明细缺少银行账号',
      count: missingAccountItems.length,
      detail: `${missingAccountItems.slice(0, 10).map((i) => `${i.payroll.period} ${i.name}`).join('、')}${missingAccountItems.length > 10 ? ' 等' : ''}`,
      action: '到「基础资料 → 员工」补齐银行账号后重新生成银行模板'
    })
  }
  if (unreconciled.length) {
    anomalies.push({
      key: 'unreconciled', level: 'warn', title: '流水待核对',
      count: unreconciled.length,
      detail: `最近一笔：${unreconciled[0].code} ${unreconciled[0].counterparty || ''} ${unreconciled[0].amount}`,
      action: '在「流水管理」批量标记已核对'
    })
  }
  if (abnormal) {
    anomalies.push({ key: 'abnormal', level: 'danger', title: '标记为异常的流水', count: abnormal, detail: `${abnormal} 笔`, action: '逐笔核实后改状态' })
  }
  for (const cid of companies.map((c) => c.id)) {
    const dups = await findDuplicateInvoices(cid)
    if (dups.length) {
      const code = companies.find((c) => String(c.id) === String(cid))?.code
      anomalies.push({
        key: 'dup_invoice', level: 'danger', title: `${code} 存在重复发票号`,
        count: dups.length, detail: dups.slice(0, 10).join('、'), action: '在「发票台账 → 查重」中作废重复记录'
      })
    }
  }
  if (overdueAR.length) {
    anomalies.push({
      key: 'overdue_ar', level: 'warn', title: '逾期未收款',
      count: overdueAR.length,
      detail: `合计 ¥${round2(overdueAR.reduce((s, r) => s + Number(r.amount) - Number(r.receivedAmount), 0))}`,
      action: '联系客户或调整预计收款日'
    })
  }
  if (overduePay.length) {
    anomalies.push({
      key: 'overdue_pay', level: 'danger', title: '逾期未付款',
      count: overduePay.length,
      detail: `合计 ¥${round2(overduePay.reduce((s, p) => s + Number(p.amount), 0))}`,
      action: '尽快审批付款或改计划付款日'
    })
  }
  if (staleAccounts.length) {
    anomalies.push({
      key: 'stale_balance', level: 'info', title: '账户余额未更新',
      count: staleAccounts.length,
      detail: staleAccounts.map((a) => `${a.company.code}/${a.name}`).join('、'),
      action: '导入最新流水或手工更新余额'
    })
  }
  if (noInvoiceBigExpense.length) {
    anomalies.push({
      key: 'no_invoice', level: 'info', title: '万元以上支出未关联发票',
      count: noInvoiceBigExpense.length,
      detail: noInvoiceBigExpense.slice(0, 5).map((t) => `${t.counterparty || t.code} ¥${t.amount}`).join('、'),
      action: '补录发票并与流水关联'
    })
  }

  return ok(res, {
    period,
    total: anomalies.reduce((s, a) => s + a.count, 0),
    anomalies
  })
}))

export default router
