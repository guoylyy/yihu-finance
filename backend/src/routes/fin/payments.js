// 付款单：草稿 → 待审批 → 待付款 → 已付款 → 已核对
// 需求 §4：AI 与业务人员均无权直接付款，审批与付款是两个独立权限点
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
import { executePayment } from '../../lib/payment.js'
import { toXlsxBuffer } from '../../lib/excel.js'

const router = express.Router()
const INCLUDE = {
  company: { select: { id: true, code: true, name: true } },
  account: { select: { id: true, name: true, currency: true } },
  payable: { select: { id: true, code: true, title: true } },
  transaction: { select: { id: true, code: true, txnDate: true } }
}

// 允许的状态流转
const FLOW = {
  submit: { from: ['DRAFT', 'REJECTED'], to: 'PENDING_APPROVAL', perm: 'payment.manage', label: '提交审批' },
  approve: { from: ['PENDING_APPROVAL'], to: 'APPROVED', perm: 'payment.approve', label: '审批通过' },
  reject: { from: ['PENDING_APPROVAL'], to: 'REJECTED', perm: 'payment.approve', label: '审批驳回' },
  cancel: { from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'], to: 'CANCELLED', perm: 'payment.manage', label: '取消付款' }
}

// 待付款清单（导出银行/财务使用）
router.get('/plan', requirePermission('payment.view'), wrap(async (req, res) => {
  const where = {
    deletedAt: null, ...scopeWhere(req.user),
    status: 'APPROVED'
  }
  if (req.query.company_id) where.companyId = BigInt(req.query.company_id)
  const list = await prisma.payment.findMany({ where, include: INCLUDE, orderBy: [{ planDate: 'asc' }, { id: 'asc' }] })
  const total = list.reduce((s, p) => s + Number(p.amount), 0)

  if (req.query.export === '1') {
    const data = list.map((p) => ({
      付款编号: p.code, 付款公司: p.company.code, 收款方: p.payeeName,
      收款账号: p.payeeAccountNo || '', 开户行: p.payeeBankName || '',
      金额: Number(p.amount), 付款用途: p.purpose || '',
      计划付款日: p.planDate ? p.planDate.toISOString().slice(0, 10) : '',
      审批人: p.approverName || ''
    }))
    const buf = toXlsxBuffer(data, '付款清单')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="payment-plan-${Date.now()}.xlsx"`)
    return res.send(buf)
  }
  return ok(res, { list, total: Math.round(total * 100) / 100, count: list.length })
}))

router.use(crudRouter({
  model: 'payment', entity: 'payment',
  perms: { view: 'payment.view', manage: 'payment.manage' },
  fields: ['companyId', 'accountId', 'payableId', 'payType', 'payeeName', 'payeeAccountNo', 'payeeBankName',
    'amount', 'purpose', 'planDate', 'sourceType', 'sourceId', 'status', 'remark'],
  dateFields: ['planDate'],
  searchFields: ['code', 'payeeName', 'purpose'],
  filters: { status: 'status', pay_type: 'payType', source_type: 'sourceType' },
  dateRangeField: 'planDate',
  include: INCLUDE,
  orderBy: [{ status: 'asc' }, { planDate: 'asc' }, { id: 'desc' }],
  required: ['companyId', 'payeeName', 'amount', 'payType'],
  hooks: {
    beforeCreate: async (data) => {
      data.code = await nextCode('PAY', { date: data.planDate || new Date() })
      if (!data.status) data.status = 'DRAFT'
      return { data }
    },
    beforeUpdate: (data, req, before) => {
      if (['PAID', 'RECONCILED'].includes(before.status)) {
        return { error: '已付款的付款单不可修改，请先撤销付款记录' }
      }
      return { data }
    },
    // 作废付款单时，它付出去时生成的那笔流水要一起作废，
    // 否则流水成了孤儿、账户余额凭空少一笔（踩过：误建工资批次撤销后余额对不上银行）
    afterWrite: async (row, req, action, before) => {
      if (action !== 'DELETE' || !before?.transactionId) return
      const txn = await prisma.transaction.findFirst({
        where: { id: before.transactionId, deletedAt: null }
      })
      if (!txn) return
      await prisma.transaction.update({
        where: { id: txn.id },
        data: { deletedAt: new Date(), remark: `${txn.remark || ''}（随付款单 ${before.code} 作废）`.slice(0, 500) }
      })
      await recalcAccountBalance(txn.accountId)
      await logAudit(req, {
        action: 'DELETE', entity: 'transaction', entityId: txn.id,
        summary: `随付款单 ${before.code} 作废流水 ${txn.code}`
      })
    }
  }
}))

// ── 状态流转 ──
for (const [action, cfg] of Object.entries(FLOW)) {
  router.post(`/:id/${action}`, requirePermission(cfg.perm), wrap(async (req, res) => {
    const id = BigInt(req.params.id)
    const before = await prisma.payment.findFirst({ where: { id, deletedAt: null } })
    if (!before) return notFound(res)
    if (!cfg.from.includes(before.status)) {
      return badRequest(res, `当前状态「${before.status}」不能执行「${cfg.label}」`)
    }
    const data = { status: cfg.to }
    if (action === 'approve') {
      data.approverId = BigInt(req.user.id)
      data.approverName = req.user.name
      data.approvedAt = new Date()
    }
    if (req.body?.remark) data.remark = req.body.remark
    const row = await prisma.payment.update({ where: { id }, data, include: INCLUDE })
    await logAudit(req, { action: action.toUpperCase(), entity: 'payment', entityId: id, summary: `${before.code} ${cfg.label}`, before, after: row })
    return ok(res, row)
  }))
}

// ── 批量审批 ──
router.post('/batch-approve', requirePermission('payment.approve'), wrap(async (req, res) => {
  const { ids = [] } = req.body || {}
  if (!ids.length) return badRequest(res, '请选择付款单')
  const result = await prisma.payment.updateMany({
    where: { id: { in: ids.map(BigInt) }, status: 'PENDING_APPROVAL', deletedAt: null },
    data: { status: 'APPROVED', approverId: BigInt(req.user.id), approverName: req.user.name, approvedAt: new Date() }
  })
  await logAudit(req, { action: 'APPROVE', entity: 'payment', summary: `批量审批通过 ${result.count} 笔付款` })
  return ok(res, { count: result.count })
}))

// ── 标记已付款：生成支出流水，回写来源单据 ──
router.post('/:id/pay', requirePermission('payment.pay'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const { accountId, paidDate, remark } = req.body || {}
  const payment = await prisma.payment.findFirst({ where: { id, deletedAt: null } })
  if (!payment) return notFound(res)
  if (payment.status !== 'APPROVED') return badRequest(res, '只有「待付款」状态的付款单可以标记付款')

  const r = await executePayment({ payment, accountId, paidDate, remark, req, include: INCLUDE })
  if (r.error) return badRequest(res, r.error)
  return ok(res, r)
}))

// ── 与已导入的银行流水手工关联（银行先到账、付款单后补的场景）──
router.post('/:id/link-transaction', requirePermission('payment.pay'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const { transactionId } = req.body || {}
  if (!transactionId) return badRequest(res, '请选择要关联的流水')
  const [payment, txn] = await Promise.all([
    prisma.payment.findFirst({ where: { id, deletedAt: null } }),
    prisma.transaction.findFirst({ where: { id: BigInt(transactionId), deletedAt: null } })
  ])
  if (!payment || !txn) return notFound(res)

  const updated = await prisma.payment.update({
    where: { id },
    data: { transactionId: txn.id, status: 'RECONCILED', paidDate: txn.txnDate, accountId: txn.accountId },
    include: INCLUDE
  })
  await prisma.transaction.update({
    where: { id: txn.id },
    data: { refType: 'PAYMENT', refId: payment.id, status: 'RECONCILED' }
  })
  await logAudit(req, { action: 'UPDATE', entity: 'payment', entityId: id, summary: `${payment.code} 关联流水 ${txn.code}` })
  return ok(res, updated)
}))

export default router
