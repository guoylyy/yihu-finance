// 付款执行：把付款单变成一笔真实的支出流水，并回写来源单据
// 付款管理的「标记已付款」和应付台账的「快速付款」共用这里，避免两处逻辑走偏
import prisma from './prisma.js'
import { Prisma } from '@prisma/client'
import { createWithCode } from './code.js'
import { toDate } from './period.js'
import { recalcAccountBalance } from './balance.js'
import { assertPeriodOpen } from './close.js'
import { logAudit } from './audit.js'

// 付款类型 → 流水业务类型
const BIZ_BY_PAYTYPE = {
  SALARY: 'SALARY', LABOR: 'LABOR', REIMBURSE: 'REIMBURSE', SUPPLIER: 'PURCHASE',
  SERVICE: 'SERVICE', TAX: 'TAX', INTERCOMPANY: 'INTERCOMPANY', OTHER: 'OTHER_OUT'
}

/**
 * 执行付款
 * @returns {{ error?: string, payment?: object, transaction?: object }}
 */
export async function executePayment({ payment, accountId, paidDate, remark, req, include }) {
  const acctId = accountId || payment.accountId
  if (!acctId) return { error: '请选择付款账户' }

  const account = await prisma.account.findFirst({ where: { id: BigInt(acctId), deletedAt: null } })
  if (!account) return { error: '付款账户不存在' }

  const date = toDate(paidDate) || new Date()
  const locked = await assertPeriodOpen(payment.companyId, date)
  if (locked) return { error: locked }

  const txn = await createWithCode('transaction', 'TXN', { date }, {
    data: {
      companyId: payment.companyId, accountId: account.id, txnDate: date,
      direction: 'OUT', amount: payment.amount, currency: account.currency,
      counterparty: payment.payeeName, counterpartyAccount: payment.payeeAccountNo,
      bizType: BIZ_BY_PAYTYPE[payment.payType] || 'OTHER_OUT',
      refType: 'PAYMENT', refId: payment.id,
      status: 'RECONCILED',
      remark: remark || payment.purpose || `${payment.code} 付款`
    }
  })

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'PAID', paidDate: date, accountId: account.id, transactionId: txn.id },
    include
  })

  await writeBackSource(payment, txn, date)
  await recalcAccountBalance(account.id)
  await logAudit(req, {
    action: 'PAY', entity: 'payment', entityId: payment.id,
    summary: `${payment.code} 付款 ${payment.amount} 至 ${payment.payeeName}`,
    before: payment, after: updated
  })

  return { payment: updated, transaction: txn }
}

/** 回写来源单据：报销、工资批次、应付款 */
async function writeBackSource(payment, txn, date) {
  if (payment.sourceType === 'REIMBURSEMENT' && payment.sourceId) {
    await prisma.reimbursement.update({
      where: { id: payment.sourceId },
      data: { status: 'PAID', paymentId: payment.id, transactionId: txn.id }
    }).catch(() => {})
  }

  if (payment.sourceType === 'PAYROLL' && payment.sourceId) {
    const payroll = await prisma.payroll.findUnique({ where: { id: payment.sourceId } })
    if (payroll) {
      const paidSum = await prisma.payment.aggregate({
        where: { sourceType: 'PAYROLL', sourceId: payroll.id, status: { in: ['PAID', 'RECONCILED'] }, deletedAt: null },
        _sum: { amount: true }
      })
      if (new Prisma.Decimal(paidSum._sum.amount || 0).gte(payroll.netTotal)) {
        await prisma.payroll.update({ where: { id: payroll.id }, data: { status: 'PAID', payDate: date } })
      }
    }
  }

  if (payment.payableId) {
    const payable = await prisma.payable.findUnique({ where: { id: payment.payableId } })
    if (payable) {
      const paid = new Prisma.Decimal(payable.paidAmount).plus(payment.amount)
      await prisma.payable.update({
        where: { id: payable.id },
        data: { paidAmount: paid, status: paid.gte(payable.amount) ? 'PAID' : 'PARTIAL' }
      })
    }
  }
}
