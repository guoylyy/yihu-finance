// 应付台账（供应商欠款 / 待付事项），付款动作在 payments 模块
import express from 'express'
import prisma from '../../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { crudRouter } from '../../lib/crud.js'
import { requirePermission, can, scopeWhere } from '../../lib/auth.js'
import { ok, badRequest, notFound, wrap } from '../../lib/response.js'
import { nextCode } from '../../lib/code.js'
import { toDate } from '../../lib/period.js'
import { logAudit } from '../../lib/audit.js'
import { executePayment } from '../../lib/payment.js'

const router = express.Router()
const INCLUDE = {
  company: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, name: true } }
}

router.get('/overdue', requirePermission('payable.view'), wrap(async (req, res) => {
  const list = await prisma.payable.findMany({
    where: {
      deletedAt: null, ...scopeWhere(req.user),
      status: { in: ['PENDING', 'PARTIAL'] }, dueDate: { lt: new Date() }
    },
    include: INCLUDE, orderBy: { dueDate: 'asc' }
  })
  const total = list.reduce((s, r) => s + Number(r.amount) - Number(r.paidAmount), 0)
  return ok(res, { list, total: Math.round(total * 100) / 100, count: list.length })
}))

router.use(crudRouter({
  model: 'payable', entity: 'payable',
  perms: { view: 'payable.view', manage: 'payable.manage' },
  fields: ['companyId', 'supplierId', 'payeeName', 'bizType', 'title', 'amount', 'dueDate', 'status', 'remark'],
  dateFields: ['dueDate'],
  searchFields: ['code', 'title', 'payeeName'],
  filters: { status: 'status', biz_type: 'bizType', supplier_id: 'supplierId' },
  dateRangeField: 'dueDate',
  include: INCLUDE,
  required: ['companyId', 'payeeName', 'amount'],
  hooks: {
    beforeCreate: async (data) => {
      data.code = await nextCode('AP', { monthly: false })
      if (!data.title) data.title = `${data.payeeName} 应付款`
      return { data }
    }
  }
}))

// 应付业务类型 → 付款类型
const PAY_TYPE_BY_BIZ = {
  PURCHASE: 'SUPPLIER', SERVICE: 'SERVICE', TAX: 'TAX', RENT: 'SERVICE',
  SOFTWARE: 'SERVICE', SALARY: 'SALARY', LABOR: 'LABOR', REIMBURSE: 'REIMBURSE',
  INTERCOMPANY: 'INTERCOMPANY'
}

/**
 * 快速付款：在应付台账上直接付掉，不用去付款管理重录一遍
 * mode = 'PAY'    直接记为已付款并生成流水（需要审批 + 付款两个权限）
 * mode = 'SUBMIT' 只生成付款单并提交审批，后续走正常流程
 */
router.post('/:id/quick-pay', requirePermission('payable.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const { accountId, amount, paidDate, remark, mode = 'PAY' } = req.body || {}

  const payable = await prisma.payable.findFirst({
    where: { id, deletedAt: null }, include: { supplier: true }
  })
  if (!payable) return notFound(res)
  if (payable.status === 'PAID') return badRequest(res, '这笔应付款已经付清了')

  const remain = new Prisma.Decimal(payable.amount).minus(payable.paidAmount)
  const payAmount = amount != null && amount !== '' ? new Prisma.Decimal(amount) : remain
  if (payAmount.lte(0)) return badRequest(res, '付款金额要大于 0')
  if (payAmount.gt(remain)) return badRequest(res, `付款金额超过未付余额 ${remain.toFixed(2)}`)

  if (mode === 'PAY') {
    // 直接付款相当于自己给自己审批，两个权限都得有
    if (!can(req.user, 'payment.approve')) {
      return badRequest(res, '你没有付款审批权限，请改用「生成付款单送审」')
    }
    if (!can(req.user, 'payment.pay')) return badRequest(res, '你没有执行付款的权限')
    if (!accountId) return badRequest(res, '请选择付款账户')
  }

  const payment = await prisma.payment.create({
    data: {
      code: await nextCode('PAY', { date: toDate(paidDate) || new Date() }),
      companyId: payable.companyId,
      accountId: accountId ? BigInt(accountId) : null,
      payableId: payable.id,
      payType: PAY_TYPE_BY_BIZ[payable.bizType] || 'OTHER',
      payeeName: payable.payeeName,
      payeeAccountNo: payable.supplier?.bankAccount || null,
      payeeBankName: payable.supplier?.bankName || null,
      amount: payAmount,
      purpose: payable.title || `${payable.code} 付款`,
      planDate: toDate(paidDate) || payable.dueDate,
      status: mode === 'PAY' ? 'APPROVED' : 'PENDING_APPROVAL',
      approverId: mode === 'PAY' ? BigInt(req.user.id) : null,
      approverName: mode === 'PAY' ? req.user.name : null,
      approvedAt: mode === 'PAY' ? new Date() : null,
      remark: remark || `由应付台账 ${payable.code} 快速付款`
    }
  })
  await logAudit(req, {
    action: 'CREATE', entity: 'payment', entityId: payment.id,
    summary: `应付 ${payable.code} 快速${mode === 'PAY' ? '付款' : '送审'} ${payAmount.toFixed(2)} 至 ${payable.payeeName}`
  })

  if (mode !== 'PAY') {
    return ok(res, { payment, paid: false }, '付款单已生成并提交审批')
  }

  const r = await executePayment({ payment, accountId, paidDate, remark, req })
  if (r.error) {
    // 付款没成功就别留一张挂着的单子
    await prisma.payment.update({ where: { id: payment.id }, data: { deletedAt: new Date() } })
    return badRequest(res, r.error)
  }

  const updatedPayable = await prisma.payable.findUnique({ where: { id }, include: INCLUDE })
  return ok(res, { payment: r.payment, transaction: r.transaction, payable: updatedPayable, paid: true })
}))

// 某笔应付款的付款记录
router.get('/:id/payments', requirePermission('payable.view'), wrap(async (req, res) => {
  const list = await prisma.payment.findMany({
    where: { payableId: BigInt(req.params.id), deletedAt: null },
    orderBy: { id: 'desc' },
    include: { account: { select: { name: true } }, transaction: { select: { code: true, txnDate: true } } }
  })
  return ok(res, { list })
}))

export default router
