// 报销：提交 → 审批 → 生成付款单 → 付款回写
import express from 'express'
import prisma from '../../lib/prisma.js'
import { crudRouter } from '../../lib/crud.js'
import { requirePermission } from '../../lib/auth.js'
import { ok, badRequest, notFound, wrap } from '../../lib/response.js'
import { nextCode } from '../../lib/code.js'
import { toDate } from '../../lib/period.js'
import { logAudit } from '../../lib/audit.js'

const router = express.Router()
const INCLUDE = {
  company: { select: { id: true, code: true, name: true } },
  person: { select: { id: true, name: true, bankAccount: true, bankName: true } },
  invoices: { select: { id: true, invoiceNo: true, totalAmount: true } }
}

router.use(crudRouter({
  model: 'reimbursement', entity: 'reimbursement',
  perms: { view: 'reimburse.view', manage: 'reimburse.submit' },
  fields: ['companyId', 'personId', 'applicantName', 'category', 'amount', 'expenseDate', 'reason', 'status', 'remark'],
  dateFields: ['expenseDate'],
  searchFields: ['code', 'applicantName', 'reason'],
  filters: { status: 'status', category: 'category', person_id: 'personId' },
  dateRangeField: 'expenseDate',
  include: INCLUDE,
  orderBy: [{ status: 'asc' }, { id: 'desc' }],
  required: ['companyId', 'applicantName', 'amount'],
  hooks: {
    beforeCreate: async (data) => {
      data.code = await nextCode('EXP')
      if (!data.status) data.status = 'PENDING'
      if (!data.category) data.category = '其他'
      return { data }
    },
    beforeUpdate: (data, req, before) => {
      if (before.status === 'PAID') return { error: '已付款的报销单不可修改' }
      return { data }
    }
  }
}))

router.post('/:id/approve', requirePermission('reimburse.approve'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const before = await prisma.reimbursement.findFirst({ where: { id, deletedAt: null } })
  if (!before) return notFound(res)
  if (!['PENDING', 'DRAFT'].includes(before.status)) return badRequest(res, `当前状态「${before.status}」不能审批`)
  const row = await prisma.reimbursement.update({ where: { id }, data: { status: 'APPROVED' }, include: INCLUDE })
  await logAudit(req, { action: 'APPROVE', entity: 'reimbursement', entityId: id, summary: `${before.code} 审批通过`, before, after: row })
  return ok(res, row)
}))

router.post('/:id/reject', requirePermission('reimburse.approve'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const before = await prisma.reimbursement.findFirst({ where: { id, deletedAt: null } })
  if (!before) return notFound(res)
  const row = await prisma.reimbursement.update({
    where: { id }, data: { status: 'REJECTED', remark: req.body?.remark || before.remark }, include: INCLUDE
  })
  await logAudit(req, { action: 'REJECT', entity: 'reimbursement', entityId: id, summary: `${before.code} 驳回`, before, after: row })
  return ok(res, row)
}))

// 批量生成付款单（可多选同一人多笔合并）
router.post('/generate-payments', requirePermission('reimburse.approve'), wrap(async (req, res) => {
  const { ids = [], accountId, planDate, merge = true } = req.body || {}
  if (!ids.length) return badRequest(res, '请选择报销单')

  const list = await prisma.reimbursement.findMany({
    where: { id: { in: ids.map(BigInt) }, deletedAt: null, status: 'APPROVED' },
    include: { person: true, company: true }
  })
  if (!list.length) return badRequest(res, '所选报销单中没有「待付款」状态的记录')

  const groups = new Map()
  for (const r of list) {
    const key = merge ? `${r.companyId}:${r.applicantName}` : String(r.id)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  const created = []
  for (const rows of groups.values()) {
    const first = rows[0]
    const total = rows.reduce((s, r) => s + Number(r.amount), 0)
    const payment = await createWithCode('payment', 'PAY', {}, {
      data: {
        companyId: first.companyId,
        accountId: accountId ? BigInt(accountId) : null,
        payType: 'REIMBURSE',
        payeeName: first.applicantName,
        payeeAccountNo: first.person?.bankAccount || null,
        payeeBankName: first.person?.bankName || null,
        amount: Math.round(total * 100) / 100,
        purpose: `报销付款：${rows.map((r) => r.code).join('、')}`,
        planDate: toDate(planDate),
        sourceType: 'REIMBURSEMENT',
        sourceId: rows.length === 1 ? first.id : null,
        status: 'DRAFT',
        remark: rows.map((r) => `${r.category} ${r.amount}`).join('；')
      }
    })
    await prisma.reimbursement.updateMany({
      where: { id: { in: rows.map((r) => r.id) } }, data: { paymentId: payment.id }
    })
    created.push(payment)
  }
  await logAudit(req, { action: 'CREATE', entity: 'reimbursement', summary: `${list.length} 笔报销生成 ${created.length} 张付款单` })
  return ok(res, { count: created.length, payments: created })
}))

export default router
