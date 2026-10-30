// 发票台账：录入 / 导入 / 查重 / 与报销和流水关联
import express from 'express'
import multer from 'multer'
import prisma from '../../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { crudRouter } from '../../lib/crud.js'
import { requirePermission, scopeWhere, inScope } from '../../lib/auth.js'
import { ok, badRequest, notFound, forbidden, wrap, readableError } from '../../lib/response.js'
import { toDate } from '../../lib/period.js'
import { logAudit } from '../../lib/audit.js'
import { round2 } from '../../lib/money.js'
import XLSX from 'xlsx'
import { decodeFileName } from '../../lib/file.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

const INCLUDE = {
  company: { select: { id: true, code: true, name: true } },
  customer: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  reimbursement: { select: { id: true, code: true } }
}

// 统计：待处理 / 未入账
router.get('/stats', requirePermission('invoice.view'), wrap(async (req, res) => {
  const where = { deletedAt: null, AND: [scopeWhere(req.user)] } // 范围放 AND，下面的 company_id 不能覆盖它
  if (req.query.company_id) where.companyId = BigInt(req.query.company_id)
  const [byType, pending, dup] = await Promise.all([
    prisma.invoice.groupBy({ by: ['type'], where, _sum: { totalAmount: true, taxAmount: true }, _count: true }),
    prisma.invoice.count({ where: { ...where, status: 'PENDING' } }),
    prisma.invoice.groupBy({
      by: ['invoiceNo'], where, _count: { invoiceNo: true },
      having: { invoiceNo: { _count: { gt: 1 } } }
    })
  ])
  return ok(res, {
    byType: byType.map((t) => ({ type: t.type, count: t._count, total: Number(t._sum.totalAmount || 0), tax: Number(t._sum.taxAmount || 0) })),
    pendingCount: pending,
    duplicateNos: dup.map((d) => d.invoiceNo)
  })
}))

router.get('/duplicates', requirePermission('invoice.view'), wrap(async (req, res) => {
  const where = { deletedAt: null, ...scopeWhere(req.user) }
  const dup = await prisma.invoice.groupBy({
    by: ['invoiceNo'], where, _count: { invoiceNo: true }, having: { invoiceNo: { _count: { gt: 1 } } }
  })
  const nos = dup.map((d) => d.invoiceNo)
  const list = nos.length
    ? await prisma.invoice.findMany({ where: { ...where, invoiceNo: { in: nos } }, include: INCLUDE, orderBy: { invoiceNo: 'asc' } })
    : []
  return ok(res, { list, count: nos.length })
}))

router.use(crudRouter({
  model: 'invoice', entity: 'invoice',
  perms: { view: 'invoice.view', manage: 'invoice.manage' },
  fields: ['companyId', 'invoiceNo', 'invoiceCode', 'type', 'issueDate', 'sellerName', 'buyerName',
    'amount', 'taxAmount', 'totalAmount', 'customerId', 'supplierId', 'reimbursementId', 'status', 'remark'],
  dateFields: ['issueDate'],
  searchFields: ['invoiceNo', 'sellerName', 'buyerName'],
  filters: { status: 'status', type: 'type' },
  dateRangeField: 'issueDate',
  include: INCLUDE,
  orderBy: [{ issueDate: 'desc' }, { id: 'desc' }],
  required: ['companyId', 'invoiceNo', 'type'],
  hooks: {
    beforeCreate: async (data) => {
      const exist = await prisma.invoice.findFirst({
        where: { companyId: data.companyId, invoiceNo: data.invoiceNo, deletedAt: null }
      })
      if (exist) return { error: `发票号 ${data.invoiceNo} 已存在（${exist.id}），请勿重复录入` }
      fillAmounts(data)
      return { data }
    },
    beforeUpdate: (data) => { fillAmounts(data); return { data } }
  }
}))

// 价税合计 / 不含税金额 / 税额，缺哪个补哪个
function fillAmounts(data) {
  const amount = data.amount != null ? Number(data.amount) : null
  const tax = data.taxAmount != null ? Number(data.taxAmount) : null
  const total = data.totalAmount != null ? Number(data.totalAmount) : null
  if (total == null && amount != null && tax != null) data.totalAmount = round2(amount + tax)
  else if (amount == null && total != null && tax != null) data.amount = round2(total - tax)
  else if (tax == null && total != null && amount != null) data.taxAmount = round2(total - amount)
}

// Excel 批量导入发票
router.post('/import', requirePermission('invoice.manage'), upload.single('file'), wrap(async (req, res) => {
  const { companyId, type = 'PURCHASE' } = req.body || {}
  if (!companyId) return badRequest(res, '请选择所属公司')
  if (!inScope(req.user, companyId)) return forbidden(res, '无权在该公司下导入发票')
  if (!req.file) return badRequest(res, '请上传发票清单文件')

  const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true, codepage: 936 })
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
  const pick = (r, keys) => {
    for (const k of Object.keys(r)) {
      const nk = String(k).replace(/\s/g, '')
      if (keys.some((x) => nk.includes(x))) return r[k]
    }
    return ''
  }

  let success = 0
  const skipped = []
  for (const r of rows) {
    const invoiceNo = String(pick(r, ['发票号码', '发票号'])).trim()
    if (!invoiceNo) continue
    const exist = await prisma.invoice.findFirst({ where: { companyId: BigInt(companyId), invoiceNo, deletedAt: null } })
    if (exist) { skipped.push(`${invoiceNo}（重复）`); continue }
    const total = Number(String(pick(r, ['价税合计', '含税金额', '合计金额'])).replace(/[¥,\s]/g, '')) || 0
    const tax = Number(String(pick(r, ['税额'])).replace(/[¥,\s]/g, '')) || 0
    const amount = Number(String(pick(r, ['金额', '不含税'])).replace(/[¥,\s]/g, '')) || round2(total - tax)
    try {
      await prisma.invoice.create({
        data: {
          companyId: BigInt(companyId), invoiceNo,
          invoiceCode: String(pick(r, ['发票代码'])).trim() || null,
          type,
          issueDate: toDate(pick(r, ['开票日期', '日期'])),
          sellerName: String(pick(r, ['销售方', '开票方', '销方'])).trim() || null,
          buyerName: String(pick(r, ['购买方', '受票方', '购方'])).trim() || null,
          amount: new Prisma.Decimal(amount), taxAmount: new Prisma.Decimal(tax),
          totalAmount: new Prisma.Decimal(total || round2(amount + tax)),
          status: 'PENDING'
        }
      })
      success++
    } catch (e) {
      skipped.push(`${invoiceNo}（${readableError(e).message}）`)
    }
  }
  await logAudit(req, {
    action: 'IMPORT', entity: 'invoice',
    summary: `导入发票 ${decodeFileName(req.file.originalname)}：成功 ${success} 张，跳过 ${skipped.length} 张`
  })
  return ok(res, { success, skipped: skipped.slice(0, 30) })
}))

// 与流水关联
router.post('/:id/link-transaction', requirePermission('invoice.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const { transactionId } = req.body || {}
  if (!/^[1-9]\d{0,17}$/.test(String(transactionId ?? ''))) return badRequest(res, '请选择要关联的流水')
  const [invoice, txn] = await Promise.all([
    prisma.invoice.findFirst({ where: { id, deletedAt: null } }),
    prisma.transaction.findFirst({ where: { id: BigInt(transactionId), deletedAt: null } })
  ])
  // 数据范围：发票和流水都必须在可见公司内，范围外的按「不存在」处理（与详情接口同口径）
  if (!invoice || !inScope(req.user, invoice.companyId)) return notFound(res, '发票不存在或已作废')
  if (!txn || !inScope(req.user, txn.companyId)) return notFound(res, '流水不存在或已作废')
  await prisma.transaction.update({ where: { id: txn.id }, data: { invoiceId: invoice.id } })
  const row = await prisma.invoice.update({ where: { id }, data: { status: 'BOOKED' }, include: INCLUDE })
  await logAudit(req, { action: 'UPDATE', entity: 'invoice', entityId: id, summary: `发票 ${invoice.invoiceNo} 关联流水 ${txn.code}` })
  return ok(res, row)
}))

export default router
