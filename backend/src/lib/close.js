// 月结：期间锁定校验、检查清单、月结摘要（Markdown）
import prisma from './prisma.js'
import dayjs from 'dayjs'
import { periodRange } from './period.js'
import { fmtMoney } from './money.js'

export function periodOf(date) {
  return dayjs(date).format('YYYY-MM')
}

/** 已锁定的月份不允许再改动流水/付款（需求 §5.9-8） */
export async function isPeriodLocked(companyId, date) {
  if (!companyId || !date) return false
  const row = await prisma.closePeriod.findFirst({
    where: { companyId: BigInt(companyId), period: periodOf(date), status: 'CLOSED', deletedAt: null }
  })
  return !!row
}

export async function assertPeriodOpen(companyId, date) {
  if (await isPeriodLocked(companyId, date)) {
    return `${periodOf(date)} 已月结锁定，如需修改请先解锁该月份`
  }
  return null
}

/** 月结检查清单：8 项，对应需求 §5.9 */
export async function buildChecklist(companyId, period) {
  const cid = BigInt(companyId)
  const { start, end } = periodRange(period)
  const inMonth = { gte: start, lte: end }

  const [accounts, staleAccounts, txnCount, unreconciled, abnormal, payrollUnlinked,
    reimburseUnpaid, dupInvoices, overdueAR, overduePay, income, expense] = await Promise.all([
    prisma.account.count({ where: { companyId: cid, deletedAt: null, status: 'ACTIVE' } }),
    prisma.account.count({
      where: { companyId: cid, deletedAt: null, status: 'ACTIVE', OR: [{ balanceAt: null }, { balanceAt: { lt: start } }] }
    }),
    prisma.transaction.count({ where: { companyId: cid, deletedAt: null, txnDate: inMonth } }),
    prisma.transaction.count({ where: { companyId: cid, deletedAt: null, txnDate: inMonth, status: 'UNRECONCILED' } }),
    prisma.transaction.count({ where: { companyId: cid, deletedAt: null, txnDate: inMonth, status: 'ABNORMAL' } }),
    prisma.payroll.count({ where: { companyId: cid, deletedAt: null, period, status: { not: 'PAID' } } }),
    prisma.reimbursement.count({ where: { companyId: cid, deletedAt: null, status: { in: ['PENDING', 'APPROVED'] } } }),
    findDuplicateInvoices(cid),
    prisma.receivable.count({
      where: { companyId: cid, deletedAt: null, status: { in: ['PENDING', 'PARTIAL'] }, expectDate: { lt: new Date() } }
    }),
    prisma.payment.count({
      where: { companyId: cid, deletedAt: null, status: { in: ['PENDING_APPROVAL', 'APPROVED'] }, planDate: { lt: new Date() } }
    }),
    prisma.transaction.aggregate({ where: { companyId: cid, deletedAt: null, direction: 'IN', txnDate: inMonth }, _sum: { amount: true } }),
    prisma.transaction.aggregate({ where: { companyId: cid, deletedAt: null, direction: 'OUT', txnDate: inMonth }, _sum: { amount: true } })
  ])

  const items = [
    { key: 'balance', title: '账户余额已更新', pass: staleAccounts === 0, detail: staleAccounts === 0 ? `${accounts} 个账户余额均已更新` : `${staleAccounts} 个账户余额早于本月，需更新` },
    { key: 'txn', title: '本月流水已导入', pass: txnCount > 0, detail: `本月 ${txnCount} 笔流水` },
    { key: 'reconcile', title: '流水已全部核对', pass: unreconciled === 0, detail: unreconciled === 0 ? '全部已核对' : `${unreconciled} 笔待核对` },
    { key: 'abnormal', title: '无异常流水', pass: abnormal === 0, detail: abnormal === 0 ? '无异常' : `${abnormal} 笔标记为异常` },
    { key: 'payroll', title: '工资已发放并关联付款', pass: payrollUnlinked === 0, detail: payrollUnlinked === 0 ? '本月工资已处理' : `${payrollUnlinked} 个工资批次未完成发放` },
    { key: 'reimburse', title: '报销已结清', pass: reimburseUnpaid === 0, detail: reimburseUnpaid === 0 ? '无待付报销' : `${reimburseUnpaid} 笔报销待审批/待付款` },
    { key: 'invoice', title: '发票无重复', pass: dupInvoices.length === 0, detail: dupInvoices.length === 0 ? '未发现重复发票号' : `重复发票号：${dupInvoices.slice(0, 5).join('、')}` },
    { key: 'overdue', title: '无逾期收付款', pass: overdueAR === 0 && overduePay === 0, detail: `逾期应收 ${overdueAR} 笔 / 逾期待付 ${overduePay} 笔` }
  ]

  const incomeTotal = Number(income._sum.amount || 0)
  const expenseTotal = Number(expense._sum.amount || 0)
  return {
    period,
    items,
    passCount: items.filter((i) => i.pass).length,
    total: items.length,
    incomeTotal,
    expenseTotal,
    netCashFlow: Math.round((incomeTotal - expenseTotal) * 100) / 100
  }
}

export async function findDuplicateInvoices(companyId) {
  const rows = await prisma.invoice.groupBy({
    by: ['invoiceNo'],
    where: { companyId: BigInt(companyId), deletedAt: null },
    _count: { invoiceNo: true },
    having: { invoiceNo: { _count: { gt: 1 } } }
  })
  return rows.map((r) => r.invoiceNo)
}

/** 生成 Markdown 月结摘要（可直接贴回 Obsidian 账本） */
export async function buildSummaryMd(companyId, period) {
  const cid = BigInt(companyId)
  const { start, end } = periodRange(period)
  const inMonth = { gte: start, lte: end }

  const [company, checklist, byBizType, accounts, topExpense] = await Promise.all([
    prisma.company.findUnique({ where: { id: cid } }),
    buildChecklist(companyId, period),
    prisma.transaction.groupBy({
      by: ['direction', 'bizType'],
      where: { companyId: cid, deletedAt: null, txnDate: inMonth },
      _sum: { amount: true }, _count: true
    }),
    prisma.account.findMany({ where: { companyId: cid, deletedAt: null, status: 'ACTIVE' } }),
    prisma.transaction.findMany({
      where: { companyId: cid, deletedAt: null, direction: 'OUT', txnDate: inMonth },
      orderBy: { amount: 'desc' }, take: 5,
      select: { txnDate: true, amount: true, counterparty: true, bizType: true, remark: true }
    })
  ])

  const BIZ = {
    SALES_RECEIPT: '客户回款', SALARY: '工资', LABOR: '劳务费', REIMBURSE: '报销',
    PURCHASE: '采购付款', SERVICE: '服务费', TAX: '税费', RENT: '房租', SOFTWARE: '软件和云服务',
    INTERCOMPANY: '公司间往来', LOAN: '借款', REPAY: '还款', TRANSFER: '内部转账',
    OTHER_IN: '其他收入', OTHER_OUT: '其他支出'
  }
  const lines = []
  lines.push(`# ${company.code} ${period} 月结摘要`, '')
  lines.push(`> 生成时间：${dayjs().format('YYYY-MM-DD HH:mm')}`, '')
  lines.push('## 一、资金总览', '')
  lines.push('| 账户 | 币种 | 期末余额 | 更新时间 |', '| --- | --- | ---: | --- |')
  for (const a of accounts) {
    lines.push(`| ${a.name} | ${a.currency} | ${fmtMoney(a.balance)} | ${a.balanceAt ? dayjs(a.balanceAt).format('YYYY-MM-DD') : '—'} |`)
  }
  lines.push('')
  lines.push('## 二、本月收支', '')
  lines.push(`- 收入合计：**¥${fmtMoney(checklist.incomeTotal)}**`)
  lines.push(`- 支出合计：**¥${fmtMoney(checklist.expenseTotal)}**`)
  lines.push(`- 净现金流：**¥${fmtMoney(checklist.netCashFlow)}**`, '')
  lines.push('| 方向 | 业务类型 | 笔数 | 金额 |', '| --- | --- | ---: | ---: |')
  for (const r of byBizType.sort((a, b) => Number(b._sum.amount) - Number(a._sum.amount))) {
    lines.push(`| ${r.direction === 'IN' ? '收' : '支'} | ${BIZ[r.bizType] || r.bizType} | ${r._count} | ${fmtMoney(r._sum.amount)} |`)
  }
  lines.push('')
  if (topExpense.length) {
    lines.push('## 三、本月最大 5 笔支出', '')
    lines.push('| 日期 | 对方 | 类型 | 金额 |', '| --- | --- | --- | ---: |')
    for (const t of topExpense) {
      lines.push(`| ${dayjs(t.txnDate).format('MM-DD')} | ${t.counterparty || t.remark || '—'} | ${BIZ[t.bizType] || t.bizType} | ${fmtMoney(t.amount)} |`)
    }
    lines.push('')
  }
  lines.push('## 四、月结检查', '')
  for (const i of checklist.items) {
    lines.push(`- ${i.pass ? '✅' : '⚠️'} ${i.title}：${i.detail}`)
  }
  lines.push('')
  return lines.join('\n')
}
