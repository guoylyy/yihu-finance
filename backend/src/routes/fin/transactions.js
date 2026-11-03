// 资金流水：系统的核心事实表
import express from 'express'
import multer from 'multer'
import prisma from '../../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { requirePermission, scopeWhere, inScope, can } from '../../lib/auth.js'
import { ok, badRequest, notFound, forbidden, wrap, readableError } from '../../lib/response.js'
import { toDate } from '../../lib/period.js'
import { createWithCode } from '../../lib/code.js'
import { recalcAccountBalance } from '../../lib/balance.js'
import { logAudit } from '../../lib/audit.js'
import { assertPeriodOpen } from '../../lib/close.js'
import { parseBankFile, dedupHash, guessBizType, toXlsxBuffer } from '../../lib/excel.js'
import { decodeFileName } from '../../lib/file.js'
import {
  ReceiptError, assertTxnChangeAllowed, CLAIM_REF_TYPES, parseAmount, lockTransaction, lockReceivable, assertTxnClaimable, allocate
} from '../../lib/receipt.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

const INCLUDE = {
  company: { select: { id: true, code: true, name: true } },
  account: { select: { id: true, name: true, currency: true } },
  category: { select: { id: true, name: true, kind: true } },
  project: { select: { id: true, name: true } }
}

function buildWhere(req) {
  const q = req.query
  const where = { deletedAt: null, AND: [scopeWhere(req.user)] } // 范围放 AND，下面的 company_id 不能覆盖它
  if (q.company_id) where.companyId = BigInt(q.company_id)
  if (q.account_id) where.accountId = BigInt(q.account_id)
  if (q.project_id) where.projectId = BigInt(q.project_id)
  if (q.category_id) where.categoryId = BigInt(q.category_id)
  if (q.direction) where.direction = q.direction
  if (q.biz_type) where.bizType = q.biz_type
  if (q.status) where.status = q.status
  if (q.date_from || q.date_to) {
    where.txnDate = {}
    if (q.date_from) where.txnDate.gte = toDate(q.date_from)
    if (q.date_to) where.txnDate.lte = toDate(q.date_to)
  }
  if (q.amount_min || q.amount_max) {
    where.amount = {}
    if (q.amount_min) where.amount.gte = new Prisma.Decimal(q.amount_min)
    if (q.amount_max) where.amount.lte = new Prisma.Decimal(q.amount_max)
  }
  if (q.keyword) {
    where.OR = [
      { code: { contains: q.keyword } },
      { counterparty: { contains: q.keyword } },
      { remark: { contains: q.keyword } }
    ]
  }
  return where
}

// v1.4：给列表每行补「已认领 / 剩余可认领 / 能否认领」，流水页据此显示「认领到应收」
// 能认领的口径与 GET /receivables/:id/receipt-candidates 一致：收入、非内部转账、没挂付款单 / 借款还款、
// refType 为空或属于应收 / 预收认领；v1.4 前没回填的历史回款流水（RECEIVABLE 但没有任何认领明细）视为已认领满
async function withClaimInfo(list) {
  const ins = list.filter((t) => t.direction === 'IN')
  if (!ins.length) return list
  const ids = ins.map((t) => t.id)
  const [rs, ps, pays, loans] = await Promise.all([
    prisma.receipt.groupBy({ by: ['transactionId'], where: { transactionId: { in: ids }, deletedAt: null }, _sum: { amount: true } }),
    prisma.prepayment.groupBy({ by: ['transactionId'], where: { transactionId: { in: ids }, deletedAt: null }, _sum: { amount: true } }),
    prisma.payment.findMany({ where: { transactionId: { in: ids }, deletedAt: null }, select: { transactionId: true } }),
    prisma.loanRepayment.findMany({ where: { transactionId: { in: ids } }, select: { transactionId: true } })
  ])
  const taken = new Set([...pays, ...loans].map((x) => String(x.transactionId)))
  return list.map((t) => {
    if (t.direction !== 'IN') return t
    const r = rs.find((x) => x.transactionId === t.id)?._sum.amount
    const p = ps.find((x) => x.transactionId === t.id)?._sum.amount
    const legacy = t.refType === 'RECEIVABLE' && !r && !p
    const claimed = legacy ? new Prisma.Decimal(t.amount) : new Prisma.Decimal(r || 0).plus(p || 0)
    const remaining = new Prisma.Decimal(t.amount).minus(claimed)
    const claimable = !t.transferPairId && !taken.has(String(t.id)) && (t.refType == null || CLAIM_REF_TYPES.includes(t.refType)) && remaining.gt(0)
    return { ...t, claimedAmount: claimed.toFixed(2), remainingAmount: remaining.toFixed(2), claimable }
  })
}

// ── 列表（带合计）──
router.get('/', requirePermission('transaction.view'), wrap(async (req, res) => {
  const { page = 1, page_size = 20 } = req.query
  const take = Math.min(Number(page_size) || 20, 500)
  const where = buildWhere(req)

  const [list, total, sums] = await Promise.all([
    prisma.transaction.findMany({
      where, include: INCLUDE,
      orderBy: [{ txnDate: 'desc' }, { id: 'desc' }],
      skip: (Number(page) - 1) * take, take
    }),
    prisma.transaction.count({ where }),
    prisma.transaction.groupBy({ by: ['direction'], where, _sum: { amount: true }, _count: true })
  ])
  const sum = (d) => Number(sums.find((s) => s.direction === d)?._sum.amount || 0)
  return ok(res, {
    list: await withClaimInfo(list), total, page: Number(page), pageSize: take,
    incomeTotal: sum('IN'), expenseTotal: sum('OUT'),
    netTotal: Math.round((sum('IN') - sum('OUT')) * 100) / 100
  })
}))

router.get('/export', requirePermission('transaction.view'), wrap(async (req, res) => {
  const rows = await prisma.transaction.findMany({
    where: buildWhere(req), include: INCLUDE, orderBy: [{ txnDate: 'asc' }, { id: 'asc' }], take: 20000
  })
  const data = rows.map((t) => ({
    业务编号: t.code, 公司: t.company.code, 账户: t.account.name,
    交易日期: t.txnDate.toISOString().slice(0, 10),
    收支: t.direction === 'IN' ? '收入' : '支出',
    金额: Number(t.amount), 币种: t.currency,
    对方名称: t.counterparty || '', 业务类型: t.bizType,
    分类: t.category?.name || '', 项目: t.project?.name || '',
    状态: t.status, 备注: t.remark || ''
  }))
  const buf = toXlsxBuffer(data, '流水')
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="transactions-${Date.now()}.xlsx"`)
  return res.send(buf)
}))

router.get('/:id', requirePermission('transaction.view'), wrap(async (req, res) => {
  const row = await prisma.transaction.findFirst({
    where: { id: BigInt(req.params.id), deletedAt: null }, include: INCLUDE
  })
  if (!row || !inScope(req.user, row.companyId)) return notFound(res)
  return ok(res, row)
}))

const WRITE_FIELDS = ['companyId', 'accountId', 'direction', 'amount', 'currency', 'counterparty',
  'counterpartyAccount', 'bizType', 'categoryId', 'projectId', 'invoiceId', 'refType', 'refId', 'status', 'remark']

function pickTxn(body) {
  const data = {}
  for (const k of WRITE_FIELDS) {
    if (body[k] === undefined) continue
    let v = body[k] === '' ? null : body[k]
    if (v !== null && /Id$/.test(k)) v = BigInt(v)
    if (v !== null && k === 'amount') v = new Prisma.Decimal(v)
    data[k] = v
  }
  if (body.txnDate) data.txnDate = toDate(body.txnDate)
  // 「被应收 / 预收认领」的关联只能由 receipts / prepayments 维护，接口里手工传的一律忽略，防止伪造「已收款」
  if (CLAIM_REF_TYPES.includes(data.refType)) { delete data.refType; delete data.refId }
  return data
}

// 写入前的校验：方向、金额（正数、到分）、数据范围、账户必须属于该公司
async function checkTxn(req, { companyId, accountId, direction, amount, invoiceId }) {
  if (direction !== undefined && !['IN', 'OUT'].includes(direction)) return '收支方向只能是 IN 或 OUT'
  if (amount !== undefined && !/^\d+(\.\d{1,2})?$/.test(String(amount).trim())) return '金额格式不对（正数，最多两位小数）'
  if (amount !== undefined && !new Prisma.Decimal(String(amount).trim()).gt(0)) return '金额必须大于 0'
  if (!inScope(req.user, companyId)) return { forbidden: '无权在该公司下记流水' }
  const account = await prisma.account.findFirst({ where: { id: BigInt(accountId), deletedAt: null }, select: { companyId: true } })
  if (!account) return '账户不存在'
  if (String(account.companyId) !== String(companyId)) return '账户不属于该公司'
  if (invoiceId) {
    const invoice = await prisma.invoice.findFirst({ where: { id: BigInt(invoiceId), deletedAt: null }, select: { companyId: true } })
    if (!invoice || String(invoice.companyId) !== String(companyId)) return '发票不属于该公司'
  }
  return null
}
const sendErr = (res, err) => (err.forbidden ? forbidden(res, err.forbidden) : badRequest(res, err))

router.post('/', requirePermission('transaction.manage'), wrap(async (req, res) => {
  const { companyId, accountId, txnDate, direction, amount, invoiceId } = req.body || {}
  if (!companyId || !accountId || !txnDate || !direction || !amount) {
    return badRequest(res, '公司、账户、日期、收支方向和金额为必填')
  }
  const err = await checkTxn(req, { companyId, accountId, direction, amount, invoiceId })
  if (err) return sendErr(res, err)
  const locked = await assertPeriodOpen(companyId, txnDate)
  if (locked) return badRequest(res, locked)

  const data = pickTxn(req.body)
  // 没选业务类型时按收支方向兜底（与导入一致），以前会直接撞 Prisma 必填校验
  if (!data.bizType) data.bizType = direction === 'IN' ? 'OTHER_IN' : 'OTHER_OUT'
  const row = await createWithCode('transaction', 'TXN', { date: toDate(txnDate) }, { data, include: INCLUDE })
  await recalcAccountBalance(row.accountId)
  await logAudit(req, { action: 'CREATE', entity: 'transaction', entityId: row.id, summary: `新增流水 ${row.code} ${row.direction} ${row.amount}`, after: row })
  return ok(res, row)
}))

router.put('/:id', requirePermission('transaction.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const before = await prisma.transaction.findFirst({ where: { id, deletedAt: null } })
  if (!before || !inScope(req.user, before.companyId)) return notFound(res)
  const locked = await assertPeriodOpen(before.companyId, before.txnDate)
  if (locked) return badRequest(res, locked)
  const b = req.body || {}
  const err = await checkTxn(req, {
    companyId: b.companyId ?? before.companyId, accountId: b.accountId ?? before.accountId,
    direction: b.direction, amount: b.amount
  })
  if (err) return sendErr(res, err)

  const data = pickTxn(req.body)
  // 已认领到应收的流水：refType/refId 保持原样（由 receipts 维护），前端整行回传的值不覆盖
  if (CLAIM_REF_TYPES.includes(before.refType)) { delete data.refType; delete data.refId }
  let row
  try {
    row = await prisma.$transaction(async (tx) => {
      // 锁住这笔流水再检查已认领金额，避免和认领并发时检查过期
      await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${id} FOR UPDATE`
      await assertTxnChangeAllowed(tx, before, { amount: data.amount, direction: data.direction, companyId: data.companyId })
      return tx.transaction.update({ where: { id }, data, include: INCLUDE })
    })
  } catch (e) {
    if (e instanceof ReceiptError) return badRequest(res, e.message)
    throw e
  }
  await recalcAccountBalance(row.accountId)
  if (String(before.accountId) !== String(row.accountId)) await recalcAccountBalance(before.accountId)
  await logAudit(req, { action: 'UPDATE', entity: 'transaction', entityId: id, summary: `修改流水 ${row.code}`, before, after: row })
  return ok(res, row)
}))

router.delete('/:id', requirePermission('transaction.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const before = await prisma.transaction.findFirst({ where: { id, deletedAt: null } })
  if (!before || !inScope(req.user, before.companyId)) return notFound(res)
  const locked = await assertPeriodOpen(before.companyId, before.txnDate)
  if (locked) return badRequest(res, locked)

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${id} FOR UPDATE`
      // 已认领到应收的流水不能直接作废：以前作废了应收已收不回退（v1.4 修，见 04-踩过的坑）
      await assertTxnChangeAllowed(tx, before, { delete: true })
      await tx.transaction.update({ where: { id }, data: { deletedAt: new Date() } })
    })
  } catch (e) {
    if (e instanceof ReceiptError) return badRequest(res, e.message)
    throw e
  }
  await recalcAccountBalance(before.accountId)
  await logAudit(req, { action: 'DELETE', entity: 'transaction', entityId: id, summary: `作废流水 ${before.code}`, before })
  return ok(res, { id: String(id) })
}))

// ── 批量分类 / 批量核对 ──
router.post('/batch', requirePermission('transaction.manage'), wrap(async (req, res) => {
  const { ids = [], bizType, categoryId, projectId, status } = req.body || {}
  if (!ids.length) return badRequest(res, '请选择要处理的流水')
  const data = {}
  if (bizType) data.bizType = bizType
  if (categoryId !== undefined) data.categoryId = categoryId ? BigInt(categoryId) : null
  if (projectId !== undefined) data.projectId = projectId ? BigInt(projectId) : null
  if (status) data.status = status
  if (!Object.keys(data).length) return badRequest(res, '没有需要更新的字段')

  // 数据范围：选中的流水只要有一笔不存在或不在可见公司内，整批拒绝（不悄悄只改其中一部分）
  let idList
  try {
    idList = [...new Set(ids.map((x) => BigInt(x)))]
  } catch {
    return badRequest(res, '流水 id 不合法')
  }
  const rows = await prisma.transaction.findMany({
    where: { id: { in: idList }, deletedAt: null }, select: { id: true, companyId: true }
  })
  const visible = rows.filter((r) => inScope(req.user, r.companyId))
  if (visible.length < idList.length) {
    const outOfScope = rows.length - visible.length
    if (outOfScope) return forbidden(res, `选中的流水里有 ${outOfScope} 笔不在您的数据范围内，未做任何修改`)
    return notFound(res, `选中的流水里有 ${idList.length - rows.length} 笔不存在或已作废，未做任何修改`)
  }

  const result = await prisma.transaction.updateMany({
    where: { id: { in: idList }, deletedAt: null, AND: [scopeWhere(req.user)] }, data
  })
  await logAudit(req, { action: 'UPDATE', entity: 'transaction', summary: `批量更新 ${result.count} 笔流水`, after: data })
  return ok(res, { count: result.count })
}))

// ── 银行流水导入：先预览（含查重），确认后再落库 ──
router.post('/import/preview', requirePermission('transaction.import'), upload.single('file'), wrap(async (req, res) => {
  const { accountId } = req.body || {}
  if (!req.file) return badRequest(res, '请上传流水文件（CSV / XLS / XLSX）')
  if (!accountId) return badRequest(res, '请选择导入到哪个账户')

  const account = await prisma.account.findFirst({ where: { id: BigInt(accountId), deletedAt: null } })
  if (!account || !inScope(req.user, account.companyId)) return notFound(res, '账户不存在')

  // 表头认不出来时，前端会让用户手工指定列，再带着 mapping 重新解析
  let mapping = null
  if (req.body.mapping) {
    try {
      mapping = JSON.parse(req.body.mapping)
    } catch {
      return badRequest(res, '列映射参数格式不对')
    }
  }

  let parsed
  try {
    parsed = parseBankFile(req.file.buffer, decodeFileName(req.file.originalname), mapping)
  } catch (e) {
    return badRequest(res, e.message)
  }

  const hashes = parsed.rows.map((r) => dedupHash(accountId, r))
  const existed = await prisma.transaction.findMany({
    where: { dedupHash: { in: hashes }, deletedAt: null }, select: { dedupHash: true, code: true }
  })
  const existedMap = new Map(existed.map((e) => [e.dedupHash, e.code]))

  // 同账户、同一天、同方向同金额但文字对不上的，多半是手工先记过一笔（比如登记回款时写的对方名称
  // 与银行流水里的不一样）。这种不算精确重复，但要标出来让人确认，否则会记两遍。
  const dates = [...new Set(parsed.rows.map((r) => toDate(r.txnDate)))]
  const sameDay = await prisma.transaction.findMany({
    where: { accountId: account.id, deletedAt: null, txnDate: { in: dates } },
    select: { code: true, txnDate: true, amount: true, direction: true, counterparty: true }
  })
  const similarKey = (d, dir, amt) => `${d}|${dir}|${Number(amt).toFixed(2)}`
  const similarMap = new Map(
    sameDay.map((t) => [similarKey(t.txnDate.toISOString().slice(0, 10), t.direction, t.amount), t])
  )

  // 认识员工姓名后，「对方户名 = 某个员工」就能准确判成工资/劳务费
  const persons = await prisma.person.findMany({
    where: { deletedAt: null, OR: [{ companyId: account.companyId }, { companyId: null }] },
    select: { name: true, type: true }
  })
  const ctx = {
    employees: persons.filter((p) => p.type === 'EMPLOYEE').map((p) => p.name),
    contractors: persons.filter((p) => p.type !== 'EMPLOYEE').map((p) => p.name)
  }

  // 金额能对上待付/已付的付款单，说明这笔流水就是那张单子付出去的
  const payments = await prisma.payment.findMany({
    where: {
      companyId: account.companyId, deletedAt: null,
      status: { in: ['APPROVED', 'PAID', 'RECONCILED'] }
    },
    select: { code: true, amount: true, payType: true, payeeName: true }
  })
  const PAY_BIZ = {
    SALARY: ['SALARY', '工资'], LABOR: ['LABOR', '劳务费'], REIMBURSE: ['REIMBURSE', '报销'],
    SUPPLIER: ['PURCHASE', '采购付款'], SERVICE: ['SERVICE', '服务费'], TAX: ['TAX', '税费'],
    INTERCOMPANY: ['INTERCOMPANY', '公司间往来']
  }

  const rows = parsed.rows.map((r, i) => {
    let guess = guessBizType(r, ctx)
    const hash = hashes[i]
    const exact = existedMap.get(hash)
    const near = exact ? null : similarMap.get(similarKey(r.txnDate, r.direction, r.amount))
    // 同名同额才算真像，只是金额撞车就别乱报
    const nearIsSame = near && (!r.counterparty || !near.counterparty ||
      near.counterparty.includes(r.counterparty) || r.counterparty.includes(near.counterparty) ||
      Math.abs(Number(near.amount) - r.amount) < 0.01)

    // 金额相同的付款单可能有好几张（比如两个人都发 5000），优先认收款方名字对得上的那张
    const amountHits = r.direction === 'OUT'
      ? payments.filter((p) => Math.abs(Number(p.amount) - r.amount) < 0.01)
      : []
    const byName = r.counterparty
      ? amountHits.find((p) => p.payeeName && (p.payeeName.includes(r.counterparty) || r.counterparty.includes(p.payeeName)))
      : null
    const hitPayment = byName || (amountHits.length === 1 ? amountHits[0] : null)
    if (hitPayment && PAY_BIZ[hitPayment.payType]) {
      const [bizType, categoryName] = PAY_BIZ[hitPayment.payType]
      guess = { bizType, categoryName }
    }

    return {
      ...r, ...guess, dedupHash: hash,
      duplicate: !!exact,
      duplicateOf: exact || null,
      similar: !!near,
      similarOf: near ? `${near.code}（${near.counterparty || '无对方名称'}）` : null,
      matchedPayment: hitPayment ? `${hitPayment.code} ${hitPayment.payeeName}` : null,
      remark: r.summary || null
    }
  })

  return ok(res, {
    fileName: decodeFileName(req.file.originalname),
    accountId: String(account.id),
    companyId: String(account.companyId),
    headerMode: parsed.headerMode,   // HEADER 认出表头 / INFERRED 按数据猜的 / MANUAL 用户指定
    headerRow: parsed.headerRow,
    columns: parsed.columns,
    columnCount: parsed.columnCount,
    sample: parsed.sample,
    total: rows.length,
    duplicateCount: rows.filter((r) => r.duplicate).length,
    similarCount: rows.filter((r) => r.similar).length,
    rows
  })
}))

router.post('/import/commit', requirePermission('transaction.import'), wrap(async (req, res) => {
  const { accountId, fileName = '手工导入', rows = [], skipDuplicate = true } = req.body || {}
  if (!accountId || !rows.length) return badRequest(res, '没有可导入的数据')

  const account = await prisma.account.findFirst({ where: { id: BigInt(accountId), deletedAt: null } })
  if (!account || !inScope(req.user, account.companyId)) return notFound(res, '账户不存在')

  const categories = await prisma.category.findMany({ where: { deletedAt: null } })
  const catByName = new Map(categories.map((c) => [`${c.kind}:${c.name}`, c.id]))

  const batch = await prisma.importBatch.create({
    data: {
      companyId: account.companyId, accountId: account.id, fileName,
      rowCount: rows.length, createdBy: req.user?.name || null
    }
  })

  let success = 0
  let skip = 0
  const errors = []
  for (const r of rows) {
    if (skipDuplicate && r.duplicate) { skip++; continue }
    try {
      const date = toDate(r.txnDate)
      const locked = await assertPeriodOpen(account.companyId, date)
      if (locked) { skip++; errors.push(`${r.txnDate} ${locked}`); continue }
      const kind = r.direction === 'IN' ? 'IN' : 'OUT'
      await createWithCode('transaction', 'TXN', { date }, {
        data: {
          companyId: account.companyId,
          accountId: account.id,
          txnDate: date,
          direction: r.direction,
          amount: new Prisma.Decimal(r.amount),
          currency: account.currency,
          counterparty: r.counterparty || null,
          counterpartyAccount: r.counterpartyAccount || null,
          bizType: r.bizType || (kind === 'IN' ? 'OTHER_IN' : 'OTHER_OUT'),
          categoryId: r.categoryName ? catByName.get(`${kind}:${r.categoryName}`) || null : null,
          status: 'UNRECONCILED',
          importBatchId: batch.id,
          dedupHash: r.dedupHash || dedupHash(accountId, r),
          remark: r.remark || r.summary || null
        }
      })
      success++
    } catch (e) {
      skip++
      errors.push(`${r.txnDate} ${r.amount}：${readableError(e).message}`)
    }
  }

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { successCount: success, skipCount: skip, remark: errors.slice(0, 20).join('\n') || null }
  })
  await recalcAccountBalance(account.id)
  await logAudit(req, { action: 'IMPORT', entity: 'transaction', entityId: batch.id, summary: `导入 ${fileName}：成功 ${success} 跳过 ${skip}` })

  return ok(res, { batchId: String(batch.id), success, skip, errors: errors.slice(0, 20) })
}))

router.get('/import/batches', requirePermission('transaction.view'), wrap(async (req, res) => {
  const list = await prisma.importBatch.findMany({
    where: { AND: [scopeWhere(req.user)], ...(req.query.company_id ? { companyId: BigInt(req.query.company_id) } : {}) },
    orderBy: { id: 'desc' }, take: 50
  })
  return ok(res, { list })
}))

// ── v1.4 认领明细：这笔流水认领到了哪些应收 / 转了哪些预收 ──
router.get('/:id(\\d+)/receipts', requirePermission('transaction.view'), wrap(async (req, res) => {
  const txn = await prisma.transaction.findFirst({ where: { id: BigInt(req.params.id), deletedAt: null } })
  if (!txn || !inScope(req.user, txn.companyId)) return notFound(res)
  const [list, prepayments] = await Promise.all([
    prisma.receipt.findMany({
      where: { transactionId: txn.id, ...(req.query.include_revoked === '1' ? {} : { deletedAt: null }) },
      include: { receivable: { select: { id: true, code: true, title: true, amount: true, receivedAmount: true, status: true } } },
      orderBy: { id: 'asc' }
    }),
    prisma.prepayment.findMany({ where: { transactionId: txn.id, deletedAt: null }, orderBy: { id: 'asc' } })
  ])
  const claimed = [...list.filter((r) => !r.deletedAt), ...prepayments].reduce((s, r) => s.plus(r.amount), new Prisma.Decimal(0))
  return ok(res, { list, prepayments, claimedAmount: claimed.toFixed(2), remainingAmount: new Prisma.Decimal(txn.amount).minus(claimed).toFixed(2) })
}))

// ── v1.4 从流水侧拆分认领：一笔流水一次分给多笔应收 ──
// body { items: [{ receivableId, amount }] }；整组一个事务，任一笔不通过全部回滚
// 每笔超过应收剩余的部分同样自动转预收；本次合计不能超过流水剩余可认领
router.post('/:id(\\d+)/reconcile', requirePermission('transaction.manage'), wrap(async (req, res) => {
  if (!can(req.user, 'receivable.manage')) return forbidden(res, '认领到应收会改动应收已收，需要「receivable.manage」权限')
  const id = BigInt(req.params.id)
  const raw = req.body?.items ?? req.body?.allocations
  if (!Array.isArray(raw) || !raw.length) return badRequest(res, '请至少选择一笔应收并填写认领金额')
  if (raw.length > 50) return badRequest(res, '一次最多拆给 50 笔应收')
  const items = []
  try {
    for (const [i, it] of raw.entries()) {
      if (!/^[1-9]\d{0,18}$/.test(String(it?.receivableId ?? ''))) throw new ReceiptError(`第 ${i + 1} 行应收 id 不合法`)
      items.push({ idx: i, receivableId: BigInt(it.receivableId), amount: parseAmount(it.amount, `第 ${i + 1} 行认领金额`), remark: it.remark || null })
    }
  } catch (e) {
    return badRequest(res, e.message)
  }
  const ids = items.map((x) => String(x.receivableId))
  if (new Set(ids).size !== ids.length) return badRequest(res, '同一笔应收在本次拆分里出现了两次，请合并成一行')

  const txn0 = await prisma.transaction.findFirst({ where: { id, deletedAt: null } })
  if (!txn0 || !inScope(req.user, txn0.companyId)) return notFound(res, '流水不存在或已作废')
  const ars0 = await prisma.receivable.findMany({ where: { id: { in: items.map((x) => x.receivableId) }, deletedAt: null } })
  for (const it of items) {
    const ar = ars0.find((a) => a.id === it.receivableId)
    if (!ar || !inScope(req.user, ar.companyId)) return notFound(res, `第 ${it.idx + 1} 行的应收不存在或已作废`)
    if (String(ar.companyId) !== String(txn0.companyId)) return badRequest(res, `应收 ${ar.code} 不属于流水 ${txn0.code} 所在公司，不能认领`)
  }
  const locked = await assertPeriodOpen(txn0.companyId, txn0.txnDate)
  if (locked) return badRequest(res, `流水 ${txn0.code} 所在${locked}`)
  const total = items.reduce((s, x) => s.plus(x.amount), new Prisma.Decimal(0))
  const by = req.user?.username || req.user?.name || null

  let out
  try {
    out = await prisma.$transaction(async (tx) => {
      const txn = await lockTransaction(tx, id) // 先流水
      if (!txn) throw new ReceiptError('流水不存在或已作废')
      let { claimed, remaining } = await assertTxnClaimable(tx, txn)
      if (total.gt(remaining)) throw new ReceiptError(`流水 ${txn.code} 只剩 ${remaining.toFixed(2)} 可认领，本次合计 ${total.toFixed(2)} 超出了`)
      const startRemaining = remaining
      const results = []
      // 再按应收 id 升序逐个上锁，和别的入口加锁顺序一致，防死锁
      for (const it of [...items].sort((a, b) => (a.receivableId < b.receivableId ? -1 : 1))) {
        const ar = await lockReceivable(tx, it.receivableId)
        if (!ar) throw new ReceiptError(`第 ${it.idx + 1} 行的应收不存在或已作废`)
        const r = await allocate(tx, { txn, ar, amount: it.amount, claimable: remaining, claimedBefore: claimed, source: 'LINK', remark: it.remark, createdBy: by })
        claimed = claimed.plus(it.amount)
        remaining = remaining.minus(it.amount)
        const after = await tx.receivable.findUnique({ where: { id: ar.id }, select: { id: true, code: true, amount: true, receivedAmount: true, status: true } })
        results.push({ idx: it.idx, before: ar, receivable: after, amount: it.amount.toFixed(2), receiptAmount: r.receiptAmount.toFixed(2), receipt: r.receipt, prepayment: r.prepayment, overpaidAmount: r.excess.toFixed(2) })
      }
      const transaction = await tx.transaction.findUnique({ where: { id }, include: INCLUDE })
      return { transaction, results: results.sort((a, b) => a.idx - b.idx), startRemaining, remaining }
    }, { timeout: 20000 })
  } catch (e) {
    if (e instanceof ReceiptError) return badRequest(res, e.message)
    throw e
  }
  await recalcAccountBalance(out.transaction.accountId) // 认领不改金额；按约定写流水后兜底重算
  for (const r of out.results) {
    await logAudit(req, {
      action: 'UPDATE', entity: 'receivable', entityId: r.receivable.id,
      summary: `${r.receivable.code} 认领流水 ${txn0.code} ${r.receiptAmount}（流水侧拆分）` + (r.prepayment ? `，超出 ${r.overpaidAmount} 转预收 ${r.prepayment.code}` : ''),
      before: r.before, after: { receivable: r.receivable, receipt: r.receipt }
    })
    if (r.prepayment) await logAudit(req, { action: 'CREATE', entity: 'prepayment', entityId: r.prepayment.id, summary: `认领超收自动转预收 ${r.prepayment.code} ${r.overpaidAmount}（${r.receivable.code} ← ${txn0.code}）`, after: r.prepayment })
  }
  return ok(res, {
    transaction: out.transaction,
    results: out.results.map(({ idx, before, ...r }) => r),
    allocatedAmount: total.toFixed(2),
    remainingAmount: out.remaining.toFixed(2)
  })
}))

export default router
