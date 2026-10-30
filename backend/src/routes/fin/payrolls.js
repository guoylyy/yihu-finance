// 工资：导入工资表 → 校验银行账号 → 生成 5 万拆分的银行模板 → 生成付款单
import express from 'express'
import multer from 'multer'
import prisma from '../../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { requirePermission, scopeWhere } from '../../lib/auth.js'
import { ok, badRequest, notFound, wrap } from '../../lib/response.js'
import { nextCode } from '../../lib/code.js'
import { toDate } from '../../lib/period.js'
import { logAudit } from '../../lib/audit.js'
import { parsePayrollFile } from '../../lib/excel.js'
import { decodeFileName } from '../../lib/file.js'
import { splitByLimit, batchSummary, buildBankFile, FILE_LIMIT } from '../../lib/bankTemplate.js'
import { round2 } from '../../lib/money.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

const INCLUDE = { company: { select: { id: true, code: true, name: true } } }

async function recalcTotals(payrollId) {
  const items = await prisma.payrollItem.findMany({ where: { payrollId } })
  const gross = items.reduce((s, i) => s + Number(i.gross), 0)
  const net = items.reduce((s, i) => s + Number(i.net), 0)
  return prisma.payroll.update({
    where: { id: payrollId },
    data: { grossTotal: round2(gross), netTotal: round2(net), personCount: items.length }
  })
}

router.get('/', requirePermission('payroll.view'), wrap(async (req, res) => {
  const { page = 1, page_size = 20, company_id, period, status } = req.query
  const take = Math.min(Number(page_size) || 20, 200)
  const where = { deletedAt: null, AND: [scopeWhere(req.user)] } // 范围放 AND，下面的 company_id 不能覆盖它
  if (company_id) where.companyId = BigInt(company_id)
  if (period) where.period = period
  if (status) where.status = status

  const [list, total] = await Promise.all([
    prisma.payroll.findMany({ where, include: INCLUDE, orderBy: [{ period: 'desc' }, { id: 'desc' }], skip: (Number(page) - 1) * take, take }),
    prisma.payroll.count({ where })
  ])
  return ok(res, { list, total, page: Number(page), pageSize: take })
}))

router.get('/:id', requirePermission('payroll.view'), wrap(async (req, res) => {
  const payroll = await prisma.payroll.findFirst({
    where: { id: BigInt(req.params.id), deletedAt: null },
    include: { ...INCLUDE, items: { orderBy: { id: 'asc' }, include: { person: { select: { id: true, name: true, bankAccount: true } } } } }
  })
  if (!payroll) return notFound(res)
  const payments = await prisma.payment.findMany({
    where: { sourceType: 'PAYROLL', sourceId: payroll.id, deletedAt: null }, orderBy: { id: 'asc' }
  })
  const missingAccount = payroll.items.filter((i) => !i.bankAccount).map((i) => i.name)
  return ok(res, { ...payroll, payments, missingAccount })
}))

router.post('/', requirePermission('payroll.manage'), wrap(async (req, res) => {
  const { companyId, period, title, payDate, remark } = req.body || {}
  if (!companyId || !period) return badRequest(res, '请选择公司和工资所属月份')
  const row = await createWithCode('payroll', 'PR', { date: new Date(period + '-01') }, {
    data: {
      companyId: BigInt(companyId), period, title: title || `${period} 工资`,
      payDate: toDate(payDate), remark
    },
    include: INCLUDE
  })
  await logAudit(req, { action: 'CREATE', entity: 'payroll', entityId: row.id, summary: `新建工资批次 ${row.code}` })
  return ok(res, row)
}))

router.put('/:id', requirePermission('payroll.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const before = await prisma.payroll.findFirst({ where: { id, deletedAt: null } })
  if (!before) return notFound(res)
  if (before.status === 'PAID') return badRequest(res, '已发放的工资批次不可修改')
  const { title, period, payDate, status, remark } = req.body || {}
  const row = await prisma.payroll.update({
    where: { id },
    data: { title, period, payDate: toDate(payDate), status, remark },
    include: INCLUDE
  })
  await logAudit(req, { action: 'UPDATE', entity: 'payroll', entityId: id, summary: `修改工资批次 ${row.code}`, before, after: row })
  return ok(res, row)
}))

router.delete('/:id', requirePermission('payroll.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const before = await prisma.payroll.findFirst({ where: { id, deletedAt: null } })
  if (!before) return notFound(res)
  if (before.status === 'PAID') return badRequest(res, '已发放的工资批次不可作废')
  await prisma.payroll.update({ where: { id }, data: { deletedAt: new Date() } })
  await logAudit(req, { action: 'DELETE', entity: 'payroll', entityId: id, summary: `作废工资批次 ${before.code}` })
  return ok(res, { id: String(id) })
}))

// ── 导入工资表（Excel）──
router.post('/:id/import', requirePermission('payroll.manage'), upload.single('file'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const payroll = await prisma.payroll.findFirst({ where: { id, deletedAt: null } })
  if (!payroll) return notFound(res)
  if (payroll.status === 'PAID') return badRequest(res, '已发放的工资批次不可再导入')
  if (!req.file) return badRequest(res, '请上传工资表文件')

  let parsed
  try {
    parsed = parsePayrollFile(req.file.buffer, decodeFileName(req.file.originalname))
  } catch (e) {
    return badRequest(res, e.message)
  }

  // 用姓名匹配员工档案，补齐银行账号
  const persons = await prisma.person.findMany({
    where: { deletedAt: null, OR: [{ companyId: payroll.companyId }, { companyId: null }] }
  })
  const byName = new Map(persons.map((p) => [p.name, p]))

  const replace = req.body.replace !== 'false'
  if (replace) await prisma.payrollItem.deleteMany({ where: { payrollId: id } })

  for (const r of parsed.rows) {
    const person = byName.get(r.name)
    const bankAccount = r.bankAccount || person?.bankAccount || null
    await prisma.payrollItem.create({
      data: {
        payrollId: id,
        personId: person?.id || null,
        name: r.name,
        gross: new Prisma.Decimal(r.gross),
        deductSocial: new Prisma.Decimal(r.deductSocial),
        deductFund: new Prisma.Decimal(r.deductFund),
        deductTax: new Prisma.Decimal(r.deductTax),
        net: new Prisma.Decimal(r.net),
        bankAccount,
        bankName: person?.bankName || null,
        status: bankAccount ? 'NORMAL' : 'MISSING_ACCOUNT'
      }
    })
  }
  const updated = await recalcTotals(id)
  await logAudit(req, { action: 'IMPORT', entity: 'payroll', entityId: id, summary: `导入工资表 ${decodeFileName(req.file.originalname)}，${parsed.rows.length} 人` })

  const missing = parsed.rows.filter((r) => !(r.bankAccount || byName.get(r.name)?.bankAccount)).map((r) => r.name)
  return ok(res, { payroll: updated, imported: parsed.rows.length, missingAccount: missing })
}))

// 手工增改单条工资明细
router.post('/:id/items', requirePermission('payroll.manage'), wrap(async (req, res) => {
  const payrollId = BigInt(req.params.id)
  const { name, gross = 0, deductSocial = 0, deductFund = 0, deductTax = 0, net, bankAccount, bankName, personId, remark } = req.body || {}
  if (!name) return badRequest(res, '请填写姓名')
  const computedNet = net != null ? net : round2(Number(gross) - Number(deductSocial) - Number(deductFund) - Number(deductTax))
  const item = await prisma.payrollItem.create({
    data: {
      payrollId, name, personId: personId ? BigInt(personId) : null,
      gross: new Prisma.Decimal(gross), deductSocial: new Prisma.Decimal(deductSocial),
      deductFund: new Prisma.Decimal(deductFund), deductTax: new Prisma.Decimal(deductTax),
      net: new Prisma.Decimal(computedNet), bankAccount: bankAccount || null, bankName: bankName || null,
      status: bankAccount ? 'NORMAL' : 'MISSING_ACCOUNT', remark
    }
  })
  await recalcTotals(payrollId)
  return ok(res, item)
}))

router.put('/items/:itemId', requirePermission('payroll.manage'), wrap(async (req, res) => {
  const itemId = BigInt(req.params.itemId)
  const before = await prisma.payrollItem.findUnique({ where: { id: itemId } })
  if (!before) return notFound(res)
  const b = req.body || {}
  const gross = b.gross ?? before.gross
  const social = b.deductSocial ?? before.deductSocial
  const fund = b.deductFund ?? before.deductFund
  const tax = b.deductTax ?? before.deductTax
  const net = b.net ?? round2(Number(gross) - Number(social) - Number(fund) - Number(tax))
  const bankAccount = b.bankAccount !== undefined ? b.bankAccount : before.bankAccount
  const item = await prisma.payrollItem.update({
    where: { id: itemId },
    data: {
      name: b.name ?? before.name,
      gross: new Prisma.Decimal(gross), deductSocial: new Prisma.Decimal(social),
      deductFund: new Prisma.Decimal(fund), deductTax: new Prisma.Decimal(tax),
      net: new Prisma.Decimal(net), bankAccount: bankAccount || null,
      bankName: b.bankName ?? before.bankName,
      status: bankAccount ? 'NORMAL' : 'MISSING_ACCOUNT', remark: b.remark ?? before.remark
    }
  })
  await recalcTotals(before.payrollId)
  return ok(res, item)
}))

router.delete('/items/:itemId', requirePermission('payroll.manage'), wrap(async (req, res) => {
  const itemId = BigInt(req.params.itemId)
  const before = await prisma.payrollItem.findUnique({ where: { id: itemId } })
  if (!before) return notFound(res)
  await prisma.payrollItem.delete({ where: { id: itemId } })
  await recalcTotals(before.payrollId)
  return ok(res, { id: String(itemId) })
}))

// ── 银行模板：按单文件 5 万拆批 ──
router.get('/:id/bank-batches', requirePermission('payroll.view'), wrap(async (req, res) => {
  const payroll = await prisma.payroll.findFirst({
    where: { id: BigInt(req.params.id), deletedAt: null },
    include: { items: { orderBy: { id: 'asc' } }, company: true }
  })
  if (!payroll) return notFound(res)
  const limit = Number(req.query.limit) || FILE_LIMIT
  const rows = payroll.items.map((i) => ({ name: i.name, amount: Number(i.net), bankAccount: i.bankAccount, remark: `${payroll.period}工资` }))
  const batches = splitByLimit(rows, limit)
  return ok(res, {
    limit,
    netTotal: Number(payroll.netTotal),
    batches: batchSummary(batches),
    missingAccount: payroll.items.filter((i) => !i.bankAccount).map((i) => i.name)
  })
}))

router.get('/:id/bank-template', requirePermission('payroll.view'), wrap(async (req, res) => {
  const payroll = await prisma.payroll.findFirst({
    where: { id: BigInt(req.params.id), deletedAt: null },
    include: { items: { orderBy: { id: 'asc' } }, company: true }
  })
  if (!payroll) return notFound(res)

  const limit = Number(req.query.limit) || FILE_LIMIT
  const rows = payroll.items.map((i) => ({ name: i.name, amount: Number(i.net), bankAccount: i.bankAccount, remark: `${payroll.period}工资` }))
  const batches = splitByLimit(rows, limit)
  const index = Number(req.query.batch || 1)
  if (index < 1 || index > batches.length) return badRequest(res, `批次号超出范围（共 ${batches.length} 批）`)

  const bookType = req.query.format === 'xlsx' ? 'xlsx' : 'xls'
  const buf = buildBankFile(batches[index - 1], { bookType })
  const suffix = batches.length > 1 ? `-${index}` : ''
  const name = encodeURIComponent(`中国农业-${payroll.company.code}-${payroll.period}工资支付${suffix}.${bookType}`)
  res.setHeader('Content-Type', 'application/vnd.ms-excel')
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${payroll.period}${suffix}.${bookType}"; filename*=UTF-8''${name}`)
  return res.send(buf)
}))

// ── 生成付款单（按批次逐笔生成，走正常审批流）──
router.post('/:id/generate-payments', requirePermission('payroll.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const payroll = await prisma.payroll.findFirst({
    where: { id, deletedAt: null }, include: { items: true, company: true }
  })
  if (!payroll) return notFound(res)
  if (!payroll.items.length) return badRequest(res, '该工资批次还没有明细，请先导入工资表')

  const existed = await prisma.payment.count({
    where: { sourceType: 'PAYROLL', sourceId: id, deletedAt: null, status: { not: 'CANCELLED' } }
  })
  if (existed) return badRequest(res, `该批次已生成 ${existed} 张付款单，请先取消后重新生成`)

  const { accountId, planDate, mode = 'BATCH' } = req.body || {}
  const created = []

  if (mode === 'PERSON') {
    // 一人一单，便于逐笔审批与对账
    for (const item of payroll.items) {
      created.push(await createWithCode('payment', 'PAY', { date: new Date() }, {
        data: {
          companyId: payroll.companyId, accountId: accountId ? BigInt(accountId) : null,
          payType: 'SALARY', payeeName: item.name, payeeAccountNo: item.bankAccount,
          payeeBankName: item.bankName, amount: item.net,
          purpose: `${payroll.period} 工资`, planDate: toDate(planDate) || payroll.payDate,
          sourceType: 'PAYROLL', sourceId: payroll.id, status: 'DRAFT'
        }
      }))
    }
  } else {
    // 按 5 万一个文件拆批，一批一单，与银行上传文件一一对应
    const rows = payroll.items.map((i) => ({ name: i.name, amount: Number(i.net), bankAccount: i.bankAccount }))
    const batches = splitByLimit(rows)
    for (let i = 0; i < batches.length; i++) {
      const total = batches[i].reduce((s, r) => s + Number(r.amount), 0)
      created.push(await createWithCode('payment', 'PAY', { date: new Date() }, {
        data: {
          companyId: payroll.companyId, accountId: accountId ? BigInt(accountId) : null,
          payType: 'SALARY',
          payeeName: `${payroll.period} 工资代发第 ${i + 1} 批（${batches[i].length} 人）`,
          amount: new Prisma.Decimal(round2(total)),
          purpose: `${payroll.company.code} ${payroll.period} 代发工资`,
          planDate: toDate(planDate) || payroll.payDate,
          sourceType: 'PAYROLL', sourceId: payroll.id, status: 'DRAFT',
          remark: batches[i].map((r) => r.name).join('、')
        }
      }))
    }
  }

  await prisma.payroll.update({ where: { id }, data: { status: 'CONFIRMED' } })
  await logAudit(req, { action: 'CREATE', entity: 'payroll', entityId: id, summary: `${payroll.code} 生成 ${created.length} 张付款单` })
  return ok(res, { count: created.length, payments: created })
}))

export default router
