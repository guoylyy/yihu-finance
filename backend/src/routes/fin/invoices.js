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
import { LINKABLE_INVOICE_TYPES, invoiceSummary } from '../../lib/invoice-link.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

const INCLUDE = {
  company: { select: { id: true, code: true, name: true } },
  customer: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  reimbursement: { select: { id: true, code: true } },
  receivable: { select: { id: true, code: true, title: true, amount: true } }
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

// 发票挂应收 / 摘除（v1.4）：PATCH { receivableId }，传 null 或 '' 摘除
// 校验：应收在可见范围、未作废、与发票同公司；只有销项 / 红字发票能挂；作废发票不能挂。客户对不上只提示不拦
router.patch('/:id(\\d+)', requirePermission('invoice.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const body = req.body || {}
  if (!Object.prototype.hasOwnProperty.call(body, 'receivableId')) return badRequest(res, '请传 receivableId（传 null 表示摘除）')
  const raw = body.receivableId
  const unlink = raw === null || raw === ''
  if (!unlink && !/^[1-9]\d{0,18}$/.test(String(raw))) return badRequest(res, '应收 id 不合法')

  const before = await prisma.invoice.findFirst({ where: { id, deletedAt: null }, include: INCLUDE })
  if (!before || !inScope(req.user, before.companyId)) return notFound(res, '发票不存在或已作废')

  const warnings = []
  let ar = null
  if (!unlink) {
    ar = await prisma.receivable.findFirst({ where: { id: BigInt(raw), deletedAt: null }, include: { customer: { select: { id: true, name: true } } } })
    if (!ar || !inScope(req.user, ar.companyId)) return notFound(res, '应收不存在或已作废')
    if (String(ar.companyId) !== String(before.companyId)) return badRequest(res, `发票 ${before.invoiceNo} 与应收 ${ar.code} 不属于同一家公司，不能关联`)
    if (!LINKABLE_INVOICE_TYPES.includes(before.type)) return badRequest(res, `发票 ${before.invoiceNo} 是${{ PURCHASE: '进项', EXPENSE: '费用' }[before.type] || before.type}发票，只有销项 / 红字发票能挂应收`)
    if (before.status === 'VOID') return badRequest(res, `发票 ${before.invoiceNo} 已作废，不能挂应收`)
    if (String(before.receivableId) === String(ar.id)) return ok(res, { ...before, warnings: ['发票已挂在这笔应收上，未做改动'] })
    if (before.receivableId) warnings.push(`发票原挂在应收 ${before.receivable?.code}，已改挂到 ${ar.code}`)
    const cust = ar.customer
    if (cust && before.customerId && String(before.customerId) !== String(cust.id)) warnings.push(`发票客户与应收客户（${cust.name}）不一致，请核对`)
    else if (cust && !before.customerId && before.buyerName && !before.buyerName.includes(cust.name) && !cust.name.includes(before.buyerName)) {
      warnings.push(`发票购买方「${before.buyerName}」与应收客户「${cust.name}」不一致，请核对`)
    }
  } else if (!before.receivableId) {
    return ok(res, { ...before, warnings: ['发票本来就没挂应收，未做改动'] })
  }

  const row = await prisma.invoice.update({ where: { id }, data: { receivableId: unlink ? null : ar.id }, include: INCLUDE })
  const touched = [before.receivableId, row.receivableId].filter(Boolean)
  // 返回涉及应收的开票汇总，前端直接刷新差额
  const summaries = {}
  for (const rid of touched) {
    const r = await prisma.receivable.findUnique({ where: { id: rid }, select: { code: true, amount: true, invoices: { where: { deletedAt: null }, select: { type: true, totalAmount: true, status: true } } } })
    summaries[String(rid)] = { code: r.code, ...invoiceSummary(r.amount, r.invoices) }
  }
  await logAudit(req, {
    action: 'UPDATE', entity: 'invoice', entityId: id,
    summary: unlink ? `发票 ${before.invoiceNo} 从应收 ${before.receivable?.code} 摘除` : `发票 ${before.invoiceNo} 挂到应收 ${ar.code}${before.receivableId ? `（原 ${before.receivable?.code}）` : ''}`,
    before: { receivableId: before.receivableId }, after: { receivableId: row.receivableId }
  })
  return ok(res, { ...row, warnings, invoiceSummary: summaries })
}))

router.use(crudRouter({
  model: 'invoice', entity: 'invoice',
  perms: { view: 'invoice.view', manage: 'invoice.manage' },
  fields: ['companyId', 'invoiceNo', 'invoiceCode', 'type', 'issueDate', 'sellerName', 'buyerName',
    'amount', 'taxAmount', 'totalAmount', 'customerId', 'supplierId', 'reimbursementId', 'status', 'remark'],
  dateFields: ['issueDate'],
  searchFields: ['invoiceNo', 'sellerName', 'buyerName'],
  // receivableId / receivable_id：查某笔应收挂了哪些发票（v1.4）。receivableId 不在 fields 里：挂/摘只能走 PATCH，整行 PUT 不会误改
  filters: { status: 'status', type: 'type', receivableId: 'receivableId', receivable_id: 'receivableId' },
  dateRangeField: 'issueDate',
  include: INCLUDE,
  orderBy: [{ issueDate: 'desc' }, { id: 'desc' }],
  required: ['companyId', 'invoiceNo', 'type'],
  hooks: {
    // ?linked=1 只看已挂应收的，?linked=0 只看没挂的（filters 只能精确匹配，表达不了 IS NULL）
    listWhere: (where, req) => {
      if (req.query.linked === '1') where.receivableId = { not: null }
      else if (req.query.linked === '0') where.receivableId = null
    },
    beforeCreate: async (data) => {
      const exist = await prisma.invoice.findFirst({
        where: { companyId: data.companyId, invoiceNo: data.invoiceNo, deletedAt: null }
      })
      if (exist) return { error: `发票号 ${data.invoiceNo} 已存在（${exist.id}），请勿重复录入` }
      fillAmounts(data)
      return { data }
    },
    beforeUpdate: (data, req, before) => {
      // 已挂应收的发票：不能改到别的公司、不能改成进项/费用（否则应收那边的开票汇总失真）；先摘除再改
      if (before.receivableId) {
        if (data.companyId != null && String(data.companyId) !== String(before.companyId)) return { error: `发票 ${before.invoiceNo} 已挂应收，不能改公司；请先摘除` }
        if (data.type && !LINKABLE_INVOICE_TYPES.includes(data.type)) return { error: `发票 ${before.invoiceNo} 已挂应收，只能是销项 / 红字发票；请先摘除` }
      }
      fillAmounts(data)
      return { data }
    }
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

// ── 导入时判断发票类型（v1.4）──
// 以前整批写死 PURCHASE（前端 Invoices.vue 固定传 type=PURCHASE，后端默认值也是它），
// 销项发票导进来被记成进项，后面「按销项找应收的发票」会漏。现在逐行判断，优先级：
//   ① 文件里有「发票类型 / 类型 / 进销项」列且能认出来 → 用它
//   ② 金额为负 → RED 红字发票
//   ③ 销售方 = 本公司（税号相同，或名称相同）→ SALES 销项；购买方 = 本公司 → PURCHASE 进项
//   ④ 都判断不了 → 用请求里显式传的 type（前端的默认 PURCHASE 也算），并在返回里计入 undetermined 提醒人工复核
const INVOICE_TYPE_WORDS = [
  [/红字|红冲|负数/, 'RED'], [/销项|销售|开出/, 'SALES'], [/进项|采购|取得|收到/, 'PURCHASE'], [/费用/, 'EXPENSE']
]
const VALID_INVOICE_TYPES = ['SALES', 'PURCHASE', 'EXPENSE', 'RED']
const normName = (v) => String(v || '').replace(/[\s()（）【】\[\]·.,，、]/g, '').toUpperCase()
const normTax = (v) => String(v || '').replace(/\s/g, '').toUpperCase()

export function inferInvoiceType({ typeText, total, sellerName, sellerTax, buyerName, buyerTax }, company, fallback) {
  const t = String(typeText || '').trim()
  if (VALID_INVOICE_TYPES.includes(t.toUpperCase())) return { type: t.toUpperCase(), by: 'column' }
  const hit = t && INVOICE_TYPE_WORDS.find(([re]) => re.test(t))
  if (hit) return { type: hit[1], by: 'column' }
  if (Number(total) < 0) return { type: 'RED', by: 'negative' }
  const tax = normTax(company.taxNo)
  const names = [company.name, company.code].map(normName).filter(Boolean)
  const isUs = (n, tx) => (tax && normTax(tx) === tax) || (n && names.includes(normName(n)))
  const seller = isUs(sellerName, sellerTax)
  const buyer = isUs(buyerName, buyerTax)
  if (seller && !buyer) return { type: 'SALES', by: 'party' }
  if (buyer && !seller) return { type: 'PURCHASE', by: 'party' }
  return { type: fallback, by: 'fallback' }
}

// Excel 批量导入发票
router.post('/import', requirePermission('invoice.manage'), upload.single('file'), wrap(async (req, res) => {
  const { companyId } = req.body || {}
  const fallbackType = VALID_INVOICE_TYPES.includes(req.body?.type) ? req.body.type : 'PURCHASE'
  if (!companyId) return badRequest(res, '请选择所属公司')
  if (!inScope(req.user, companyId)) return forbidden(res, '无权在该公司下导入发票')
  if (!req.file) return badRequest(res, '请上传发票清单文件')
  const company = await prisma.company.findFirst({ where: { id: BigInt(companyId), deletedAt: null } })
  if (!company) return badRequest(res, '所属公司不存在')

  const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true, codepage: 936 })
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
  const pick = (r, keys) => {
    for (const k of Object.keys(r)) {
      const nk = String(k).replace(/\s/g, '')
      if (keys.some((x) => nk.includes(x))) return r[k]
    }
    return ''
  }
  // 表头同时含「方」和「税号/识别号」的列，如「销售方纳税人识别号」「购方税号」
  const pickTax = (r, sides) => {
    for (const k of Object.keys(r)) {
      const nk = String(k).replace(/\s/g, '')
      if (sides.some((x) => nk.includes(x)) && /税号|识别号/.test(nk)) return r[k]
    }
    return ''
  }
  // 名称列：排除税号/地址/电话/账号列，避免「销售方识别号」被当成销售方名称
  const pickName = (r, sides) => {
    for (const k of Object.keys(r)) {
      const nk = String(k).replace(/\s/g, '')
      if (sides.some((x) => nk.includes(x)) && !/税号|识别号|地址|电话|账号|开户/.test(nk)) return r[k]
    }
    return ''
  }

  let success = 0
  const skipped = []
  const byType = {}
  let undetermined = 0
  for (const r of rows) {
    const invoiceNo = String(pick(r, ['发票号码', '发票号'])).trim()
    if (!invoiceNo) continue
    const exist = await prisma.invoice.findFirst({ where: { companyId: BigInt(companyId), invoiceNo, deletedAt: null } })
    if (exist) { skipped.push(`${invoiceNo}（重复）`); continue }
    const total = Number(String(pick(r, ['价税合计', '含税金额', '合计金额'])).replace(/[¥,\s]/g, '')) || 0
    const tax = Number(String(pick(r, ['税额'])).replace(/[¥,\s]/g, '')) || 0
    const amount = Number(String(pick(r, ['金额', '不含税'])).replace(/[¥,\s]/g, '')) || round2(total - tax)
    const sellerName = String(pickName(r, ['销售方', '开票方', '销方'])).trim() || null
    const buyerName = String(pickName(r, ['购买方', '受票方', '购方'])).trim() || null
    const { type, by } = inferInvoiceType({
      typeText: pick(r, ['发票类型', '进销项', '类型']), total: total || amount,
      sellerName, sellerTax: pickTax(r, ['销售方', '开票方', '销方']),
      buyerName, buyerTax: pickTax(r, ['购买方', '受票方', '购方'])
    }, company, fallbackType)
    try {
      await prisma.invoice.create({
        data: {
          companyId: BigInt(companyId), invoiceNo,
          invoiceCode: String(pick(r, ['发票代码'])).trim() || null,
          type,
          issueDate: toDate(pick(r, ['开票日期', '日期'])),
          sellerName, buyerName,
          amount: new Prisma.Decimal(amount), taxAmount: new Prisma.Decimal(tax),
          totalAmount: new Prisma.Decimal(total || round2(amount + tax)),
          status: 'PENDING'
        }
      })
      success++
      byType[type] = (byType[type] || 0) + 1
      if (by === 'fallback') undetermined++
    } catch (e) {
      skipped.push(`${invoiceNo}（${readableError(e).message}）`)
    }
  }
  await logAudit(req, {
    action: 'IMPORT', entity: 'invoice',
    summary: `导入发票 ${decodeFileName(req.file.originalname)}：成功 ${success} 张，跳过 ${skipped.length} 张，` +
      `类型 ${JSON.stringify(byType)}，无法判断按 ${fallbackType} 记 ${undetermined} 张`
  })
  return ok(res, { success, skipped: skipped.slice(0, 30), byType, undetermined, fallbackType })
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
