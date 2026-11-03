// 应收 / 收款：登记应收 → 登记回款（自动生成流水）→ 状态流转
// v1.4：已收金额 / 状态只由 lib/receipt.js 按收款明细（receipts）全量重算，本文件不再自己累加
import express from 'express'
import prisma from '../../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { crudRouter } from '../../lib/crud.js'
import { requirePermission, scopeWhere, inScope, can } from '../../lib/auth.js'
import { ok, badRequest, notFound, forbidden, wrap } from '../../lib/response.js'
import { nextCode, withCodes } from '../../lib/code.js'
import { toDate } from '../../lib/period.js'
import { recalcAccountBalance } from '../../lib/balance.js'
import { logAudit } from '../../lib/audit.js'
import { assertPeriodOpen } from '../../lib/close.js'
import {
  ReceiptError, parseAmount, lockReceivable, lockTransaction, assertConsistent, recalcReceivable,
  sumReceipts, SYSTEM_STATUSES, MANUAL_STATUSES, assertTxnClaimable, allocate
} from '../../lib/receipt.js'
import { invoiceSummary } from '../../lib/invoice-link.js'

const router = express.Router()

const INCLUDE = {
  company: { select: { id: true, code: true, name: true } },
  customer: { select: { id: true, name: true } },
  project: { select: { id: true, name: true } }
}

// 逾期应收（放在 /:id 之前）
router.get('/overdue', requirePermission('receivable.view'), wrap(async (req, res) => {
  const list = await prisma.receivable.findMany({
    where: {
      deletedAt: null, ...scopeWhere(req.user),
      status: { in: ['PENDING', 'PARTIAL'] },
      expectDate: { lt: new Date() }
    },
    include: INCLUDE, orderBy: { expectDate: 'asc' }
  })
  const total = list.reduce((s, r) => s + Number(r.amount) - Number(r.receivedAmount), 0)
  return ok(res, { list, total: Math.round(total * 100) / 100, count: list.length })
}))

const STATUS_LABEL = { PENDING: '待收款', PARTIAL: '部分收款', RECEIVED: '已收款', WRITTEN_OFF: '坏账核销', CANCELLED: '已取消' }
const EDIT_FIELDS = ['companyId', 'customerId', 'projectId', 'contractNo', 'title', 'amount', 'expectDate', 'confidence', 'remark']

// 编辑应收（替代 crud 的 PUT）：改金额要按收款明细重算已收与状态；状态只能手工改成 已取消 / 坏账核销 或从这两者改回
router.put('/:id', requirePermission('receivable.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const b = req.body || {}
  const data = {}
  for (const k of EDIT_FIELDS) {
    if (b[k] === undefined) continue
    let v = b[k] === '' ? null : b[k]
    if (v !== null && /Id$/.test(k)) v = BigInt(v)
    if (v !== null && k === 'expectDate') v = toDate(v)
    data[k] = v
  }
  if (data.companyId !== undefined && data.companyId !== null && !inScope(req.user, data.companyId)) {
    return forbidden(res, '无权把记录改到该公司下')
  }
  try {
    if (data.amount !== undefined) data.amount = parseAmount(data.amount, '应收金额')
    if (data.companyId === null) throw new ReceiptError('收款公司不能为空')
    if (data.title === null) throw new ReceiptError('款项说明不能为空')

    const { before, row } = await prisma.$transaction(async (tx) => {
      const before = await lockReceivable(tx, id)
      if (!before || !inScope(req.user, before.companyId)) return {}
      const { total } = await sumReceipts(tx, id)
      const hasMoney = total.gt(0) || new Prisma.Decimal(before.receivedAmount).gt(0)

      if (data.companyId !== undefined && String(data.companyId) !== String(before.companyId) && hasMoney) {
        throw new ReceiptError(`${before.code} 已有收款，不能改到别的公司`)
      }
      const amountChanged = data.amount !== undefined && !data.amount.eq(before.amount)
      if (amountChanged) {
        await assertConsistent(tx, before)
        if (data.amount.lt(total)) {
          throw new ReceiptError(`${before.code} 已收 ${total.toFixed(2)}，应收金额不能改到小于已收；如确需调减，请先撤销多余的收款`)
        }
      }

      // 状态：没传或与原值相同 = 不改；PENDING / PARTIAL / RECEIVED 由系统按收款算，手工只能设 已取消 / 坏账核销
      const want = b.status
      let opts = {}
      if (want !== undefined && want !== null && want !== '' && want !== before.status) {
        if (MANUAL_STATUSES.includes(want)) {
          if (want === 'CANCELLED' && total.gt(0)) throw new ReceiptError(`${before.code} 已收 ${total.toFixed(2)}，不能改成已取消；请先撤销收款，或改为坏账核销`)
          await assertConsistent(tx, before)
          opts = { status: want }
        } else if (SYSTEM_STATUSES.includes(want) && MANUAL_STATUSES.includes(before.status)) {
          await assertConsistent(tx, before)
          opts = { resetStatus: true } // 从终态改回：实际状态按收款算，不一定是传进来的值
        } else if (SYSTEM_STATUSES.includes(want)) {
          throw new ReceiptError(`应收状态「${STATUS_LABEL[want]}」由系统按收款明细自动计算，不能手工修改；只能手工改为「已取消」或「坏账核销」`)
        } else {
          throw new ReceiptError(`不认识的应收状态：${want}`)
        }
      }

      if (amountChanged || opts.status || opts.resetStatus) {
        await recalcReceivable(tx, id, { ...opts, data })
      } else {
        await tx.receivable.update({ where: { id }, data })
      }
      const row = await tx.receivable.findUnique({ where: { id }, include: INCLUDE })
      return { before, row }
    })
    if (!before) return notFound(res)
    await logAudit(req, { action: 'UPDATE', entity: 'receivable', entityId: id, summary: `修改应收 ${row.code}`, before, after: row })
    return ok(res, row)
  } catch (e) {
    if (e instanceof ReceiptError) return badRequest(res, e.message)
    throw e
  }
}))

// 作废应收：还有有效收款明细的不能作废（否则流水挂着一笔不存在的应收）
router.delete('/:id', requirePermission('receivable.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const before = await prisma.receivable.findFirst({ where: { id, deletedAt: null } })
  if (!before || !inScope(req.user, before.companyId)) return notFound(res)
  const { total } = await sumReceipts(prisma, id)
  const legacy = await prisma.transaction.count({ where: { refType: 'RECEIVABLE', refId: id, deletedAt: null } })
  if (total.gt(0) || legacy > 0) return badRequest(res, `${before.code} 已有收款记录，不能作废；请先撤销收款`)
  await prisma.receivable.update({ where: { id }, data: { deletedAt: new Date() } })
  await logAudit(req, { action: 'DELETE', entity: 'receivable', entityId: id, summary: `作废应收 ${before.code}`, before })
  return ok(res, { id: String(id) })
}))

// ── 详情：在 crud 的详情上加「关联发票 + 开票汇总」（红字发票冲减已开票，不改应收金额本身）──
router.get('/:id(\\d+)', requirePermission('receivable.view'), wrap(async (req, res) => {
  const row = await prisma.receivable.findFirst({
    where: { id: BigInt(req.params.id), deletedAt: null },
    include: {
      ...INCLUDE,
      invoices: {
        where: { deletedAt: null }, orderBy: [{ issueDate: 'asc' }, { id: 'asc' }],
        select: { id: true, invoiceNo: true, type: true, issueDate: true, amount: true, taxAmount: true, totalAmount: true, status: true, buyerName: true }
      }
    }
  })
  if (!row || !inScope(req.user, row.companyId)) return notFound(res)
  return ok(res, { ...row, invoiceSummary: invoiceSummary(row.amount, row.invoices) })
}))

router.use(crudRouter({
  model: 'receivable', entity: 'receivable',
  perms: { view: 'receivable.view', manage: 'receivable.manage' },
  fields: ['companyId', 'customerId', 'projectId', 'contractNo', 'title', 'amount', 'expectDate', 'confidence', 'status', 'remark'],
  dateFields: ['expectDate'],
  searchFields: ['code', 'title', 'contractNo'],
  filters: { status: 'status', customer_id: 'customerId' },
  dateRangeField: 'expectDate',
  include: INCLUDE,
  required: ['companyId', 'title', 'amount'],
  hooks: {
    // PUT / DELETE 由上面手写的路由接管，这里只剩新增
    beforeCreate: async (data) => {
      try {
        data.amount = parseAmount(data.amount, '应收金额')
      } catch (e) {
        return { error: e.message }
      }
      // 新应收还没有任何收款，系统状态只能是 PENDING；人工终态允许直接建
      if (!MANUAL_STATUSES.includes(data.status)) data.status = 'PENDING'
      data.code = await nextCode('AR', { monthly: false })
      return { data }
    }
  }
}))

// ── 收款构成：这笔应收由哪些流水认领而来（含已撤销的，前端置灰）──
router.get('/:id(\\d+)/receipts', requirePermission('receivable.view'), wrap(async (req, res) => {
  const ar = await prisma.receivable.findFirst({ where: { id: BigInt(req.params.id), deletedAt: null } })
  if (!ar || !inScope(req.user, ar.companyId)) return notFound(res)
  const list = await prisma.receipt.findMany({
    where: { receivableId: ar.id, ...(req.query.include_revoked === '1' ? {} : { deletedAt: null }) },
    include: { transaction: { select: { id: true, code: true, txnDate: true, amount: true, counterparty: true, accountId: true, account: { select: { name: true } }, deletedAt: true } } },
    orderBy: [{ receiptDate: 'asc' }, { id: 'asc' }]
  })
  const prepayments = await prisma.prepayment.findMany({ where: { receivableId: ar.id, deletedAt: null }, orderBy: { id: 'asc' } })
  const total = list.filter((r) => !r.deletedAt).reduce((s, r) => s.plus(r.amount), new Prisma.Decimal(0))
  return ok(res, { list, prepayments, total: total.toFixed(2), receivedAmount: ar.receivedAmount, consistent: total.eq(ar.receivedAmount) })
}))

// ── 认领流水：候选 ──
// 同公司、收入、未作废；排除已挂付款单 / 借款还款 / 其他单据的、内部转账、v1.4 前没回填的历史回款流水；
// 默认只返回还有剩余可认领的（includeUsed=1 时认领满的也返回，前端置灰）。排序：剩余金额与目标金额（amount，没传就用应收剩余）越接近越靠前 → 对方名称命中客户 → 日期新
router.get('/:id(\\d+)/receipt-candidates', requirePermission('receivable.manage'), wrap(async (req, res) => {
  const q = req.query
  const ar = await prisma.receivable.findFirst({ where: { id: BigInt(req.params.id), deletedAt: null }, include: { customer: { select: { name: true } } } })
  if (!ar || !inScope(req.user, ar.companyId)) return notFound(res)

  const dec = (v, label) => {
    if (v === undefined || v === '') return null
    if (!/^\d+(\.\d{1,2})?$/.test(String(v).trim())) throw new ReceiptError(`${label}格式不对`)
    return new Prisma.Decimal(String(v).trim())
  }
  let amount, amountMin, amountMax, page, take
  try {
    amount = dec(q.amount, '金额')
    amountMin = dec(q.amount_min, '最小金额')
    amountMax = dec(q.amount_max, '最大金额')
    page = Math.max(1, Number(q.page) || 1)
    take = Math.min(Math.max(1, Number(q.page_size || q.pageSize) || 20), 100)
  } catch (e) {
    return badRequest(res, e.message)
  }
  const from = toDate(q.from || q.date_from)
  const to = toDate(q.to || q.date_to)
  const keyword = String(q.keyword || '').trim()
  const includeUsed = ['1', 'true'].includes(String(q.includeUsed ?? q.include_used ?? ''))
  const remainingAR = new Prisma.Decimal(ar.amount).minus(ar.receivedAmount)
  const target = amount ?? remainingAR
  const customerName = ar.customer?.name || ''

  const S = Prisma.sql
  const remainingExpr = S`(CASE WHEN t.ref_type = 'RECEIVABLE' AND r.s IS NULL AND p.s IS NULL THEN 0
                               ELSE t.amount - IFNULL(r.s, 0) - IFNULL(p.s, 0) END)`
  const conds = [
    S`t.company_id = ${ar.companyId}`, S`t.deleted_at IS NULL`, S`t.direction = 'IN'`, S`t.amount > 0`, S`t.transfer_pair_id IS NULL`,
    S`(t.ref_type IS NULL OR t.ref_type IN ('RECEIVABLE', 'RECEIVABLE_MULTI', 'PREPAYMENT'))`,
    S`NOT EXISTS (SELECT 1 FROM payments py WHERE py.transaction_id = t.id AND py.deleted_at IS NULL)`,
    S`NOT EXISTS (SELECT 1 FROM loan_repayments lr WHERE lr.transaction_id = t.id)`
  ]
  if (from) conds.push(S`t.txn_date >= ${from}`)
  if (to) conds.push(S`t.txn_date <= ${to}`)
  // amount 只决定排序；按流水金额筛选用 amount_min / amount_max（方案 §3.1）
  if (amountMin) conds.push(S`t.amount >= ${amountMin}`)
  if (amountMax) conds.push(S`t.amount <= ${amountMax}`)
  if (q.account_id || q.accountId) conds.push(S`t.account_id = ${BigInt(q.account_id || q.accountId)}`)
  if (keyword) {
    const kw = `%${keyword}%`
    conds.push(S`(t.code LIKE ${kw} OR t.counterparty LIKE ${kw} OR t.remark LIKE ${kw})`)
  }
  if (!includeUsed) conds.push(S`${remainingExpr} > 0`)
  const FROM = S`FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN (SELECT transaction_id, SUM(amount) s FROM receipts WHERE deleted_at IS NULL GROUP BY transaction_id) r ON r.transaction_id = t.id
    LEFT JOIN (SELECT transaction_id, SUM(amount) s FROM prepayments WHERE deleted_at IS NULL AND transaction_id IS NOT NULL GROUP BY transaction_id) p ON p.transaction_id = t.id
    WHERE ${Prisma.join(conds, ' AND ')}`
  const hitExpr = customerName ? S`(CASE WHEN t.counterparty LIKE ${`%${customerName}%`} THEN 0 ELSE 1 END)` : S`1`

  const [rows, [{ n }]] = await Promise.all([
    prisma.$queryRaw`SELECT t.id, t.code, t.txn_date AS txnDate, t.account_id AS accountId, a.name AS accountName, t.direction, t.amount,
        t.counterparty, t.biz_type AS bizType, t.status, t.remark, t.ref_type AS refType,
        ${remainingExpr} AS remaining
      ${FROM}
      ORDER BY ABS(${remainingExpr} - ${target}) ASC, ${hitExpr} ASC, t.txn_date DESC, t.id DESC
      LIMIT ${take} OFFSET ${(page - 1) * take}`,
    prisma.$queryRaw`SELECT COUNT(*) AS n ${FROM}`
  ])

  const ids = rows.map((r) => r.id)
  const [allocs, prepays] = ids.length ? await Promise.all([
    prisma.receipt.findMany({ where: { transactionId: { in: ids }, deletedAt: null }, select: { id: true, transactionId: true, receivableId: true, amount: true, receivable: { select: { code: true } } } }),
    prisma.prepayment.findMany({ where: { transactionId: { in: ids }, deletedAt: null }, select: { id: true, code: true, transactionId: true, amount: true } })
  ]) : [[], []]
  const list = rows.map((t) => {
    const remaining = new Prisma.Decimal(t.remaining)
    const mine = allocs.filter((x) => x.transactionId === t.id)
    return {
      id: String(t.id), code: t.code, txnDate: t.txnDate.toISOString().slice(0, 10),
      accountId: String(t.accountId), accountName: t.accountName, direction: t.direction,
      amount: new Prisma.Decimal(t.amount).toFixed(2), counterparty: t.counterparty, bizType: t.bizType, status: t.status, remark: t.remark,
      claimedAmount: new Prisma.Decimal(t.amount).minus(remaining).toFixed(2), remainingAmount: remaining.toFixed(2),
      allocations: mine.map((x) => ({ receiptId: String(x.id), receivableId: String(x.receivableId), receivableCode: x.receivable.code, amount: new Prisma.Decimal(x.amount).toFixed(2) })),
      prepayments: prepays.filter((x) => x.transactionId === t.id).map((x) => ({ id: String(x.id), code: x.code, amount: new Prisma.Decimal(x.amount).toFixed(2) })),
      match: {
        amountEqualsTarget: remaining.eq(target),
        counterpartyHit: !!customerName && !!t.counterparty && (t.counterparty.includes(customerName) || customerName.includes(t.counterparty)),
        alreadyClaimedThis: mine.some((x) => x.receivableId === ar.id)
      }
    }
  })
  return ok(res, {
    list, total: Number(n), page, pageSize: take,
    receivable: { id: String(ar.id), code: ar.code, amount: new Prisma.Decimal(ar.amount).toFixed(2), receivedAmount: new Prisma.Decimal(ar.receivedAmount).toFixed(2), remainingAmount: remainingAR.toFixed(2) }
  })
}))

const operator = (req) => req.user?.username || req.user?.name || null

// 认领已有流水（POST /:id/receipt 带 transactionId 时走这里）：不新建流水，写 Receipt(LINK)
async function claimExisting(req, res, id) {
  const { transactionId, amount, remark } = req.body || {}
  if (!/^[1-9]\d{0,18}$/.test(String(transactionId))) return badRequest(res, '流水 id 不合法')
  if (!can(req.user, 'transaction.manage')) return forbidden(res, '认领流水会改动流水的关联与状态，需要「transaction.manage」权限')
  let amt
  try {
    amt = parseAmount(amount, '认领金额')
  } catch (e) {
    return badRequest(res, e.message)
  }
  const txnId = BigInt(transactionId)
  const [ar0, txn0] = await Promise.all([
    prisma.receivable.findFirst({ where: { id, deletedAt: null } }),
    prisma.transaction.findFirst({ where: { id: txnId, deletedAt: null } })
  ])
  if (!ar0 || !inScope(req.user, ar0.companyId)) return notFound(res)
  if (!txn0 || !inScope(req.user, txn0.companyId)) return notFound(res, '流水不存在或已作废')
  if (String(txn0.companyId) !== String(ar0.companyId)) return badRequest(res, `流水 ${txn0.code} 不属于该应收所在公司，不能认领`)
  // 认领会改流水的关联与状态：按流水日期校验关账（与改流水同口径）
  const locked = await assertPeriodOpen(txn0.companyId, txn0.txnDate)
  if (locked) return badRequest(res, `流水 ${txn0.code} 所在${locked}`)

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      const txn = await lockTransaction(tx, txnId) // 固定顺序：先流水、后应收
      if (!txn) throw new ReceiptError('流水不存在或已作废')
      const ar = await lockReceivable(tx, id)
      if (!ar) throw new ReceiptError('应收不存在或已作废')
      const { claimed, remaining } = await assertTxnClaimable(tx, txn)
      const r = await allocate(tx, { txn, ar, amount: amt, claimable: remaining, claimedBefore: claimed, source: 'LINK', remark: remark || null, createdBy: operator(req) })
      const [updated, transaction] = await Promise.all([
        tx.receivable.findUnique({ where: { id }, include: INCLUDE }),
        tx.transaction.findUnique({ where: { id: txnId } })
      ])
      return { ...r, before: ar, updated, transaction, txnRemaining: remaining.minus(amt) }
    }, { timeout: 15000 })
  } catch (e) {
    if (e instanceof ReceiptError) return badRequest(res, e.message)
    throw e
  }
  await recalcAccountBalance(result.transaction.accountId) // 认领不改金额，余额不变；按约定写流水后重算一次兜底
  await logAudit(req, {
    action: 'UPDATE', entity: 'receivable', entityId: id,
    summary: `${ar0.code} 认领流水 ${txn0.code} ${result.receiptAmount.toFixed(2)}` + (result.prepayment ? `，超出 ${result.excess.toFixed(2)} 转预收 ${result.prepayment.code}` : ''),
    before: result.before, after: { receivable: result.updated, receipt: result.receipt }
  })
  if (result.prepayment) {
    await logAudit(req, { action: 'CREATE', entity: 'prepayment', entityId: result.prepayment.id, summary: `认领超收自动转预收 ${result.prepayment.code} ${result.excess.toFixed(2)}（${ar0.code} ← ${txn0.code}）`, after: result.prepayment })
  }
  return ok(res, {
    receivable: result.updated, transaction: result.transaction, receipt: result.receipt,
    prepayment: result.prepayment, overpaidAmount: result.excess.toFixed(2), txnRemainingAmount: result.txnRemaining.toFixed(2)
  })
}

// 登记回款：
//  - 带 transactionId → 认领已有流水（不新建流水，写 Receipt LINK）
//  - 不带 → 老行为：新建一笔收入流水 + Receipt(AUTO)
//  两条路都是：超过应收剩余的部分自动转预收（返回 prepayment），应收按剩余结清
router.post('/:id(\\d+)/receipt', requirePermission('receivable.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const { accountId, amount, receiptDate, remark, transactionId } = req.body || {}
  if (transactionId !== undefined && transactionId !== null && transactionId !== '') return claimExisting(req, res, id)

  if (!accountId || amount === undefined || amount === null || amount === '') return badRequest(res, '请填写收款账户和金额')
  let amt
  try {
    amt = parseAmount(amount, '收款金额')
  } catch (e) {
    return badRequest(res, e.message)
  }

  // 数据范围：应收和收款账户都要在可见公司内；账户还必须属于应收所在公司（与新增流水同口径，否则流水挂 A 公司、钱进了 B 的账户）
  const ar0 = await prisma.receivable.findFirst({ where: { id, deletedAt: null } })
  if (!ar0 || !inScope(req.user, ar0.companyId)) return notFound(res)

  const account = await prisma.account.findFirst({ where: { id: BigInt(accountId), deletedAt: null } })
  if (!account) return notFound(res, '收款账户不存在')
  if (!inScope(req.user, account.companyId)) return forbidden(res, '无权使用该收款账户')
  if (String(account.companyId) !== String(ar0.companyId)) return badRequest(res, '收款账户不属于该应收所在公司')

  const date = toDate(receiptDate) || toDate(new Date())
  const locked = await assertPeriodOpen(ar0.companyId, date)
  if (locked) return badRequest(res, locked)
  const customer = ar0.customerId ? await prisma.customer.findUnique({ where: { id: ar0.customerId } }) : null

  let result
  try {
    // 取号在事务外（code_sequences 自己有锁）；撞号时 withCodes 会换号把整个事务重跑
    result = await withCodes('TXN', { date }, ([code]) => prisma.$transaction(async (tx) => {
      const ar = await lockReceivable(tx, id) // 行锁：并发两次回款在这里排队，第二次看到的是第一次提交后的已收
      if (!ar) throw new ReceiptError('应收不存在或已作废')
      if (!['PENDING', 'PARTIAL'].includes(ar.status)) {
        throw new ReceiptError(`${ar.code} 状态是「${STATUS_LABEL[ar.status] || ar.status}」，不能再登记回款`)
      }
      await assertConsistent(tx, ar)

      const txn = await tx.transaction.create({
        data: {
          code, companyId: ar.companyId, accountId: account.id, txnDate: date,
          direction: 'IN', amount: amt, currency: account.currency,
          counterparty: customer?.name || ar.title,
          bizType: 'SALES_RECEIPT', projectId: ar.projectId,
          refType: 'RECEIVABLE', refId: ar.id,
          status: 'RECONCILED',
          remark: remark || `${ar.code} 回款`
        }
      })
      const r = await allocate(tx, { txn, ar, amount: amt, claimable: amt, source: 'AUTO', remark: remark || null, createdBy: operator(req) })
      const [updated, transaction] = await Promise.all([
        tx.receivable.findUnique({ where: { id }, include: INCLUDE }),
        tx.transaction.findUnique({ where: { id: txn.id } })
      ])
      return { ...r, before: ar, updated, txn: transaction }
    }, { timeout: 15000 }))
  } catch (e) {
    if (e instanceof ReceiptError) return badRequest(res, e.message)
    throw e
  }

  await recalcAccountBalance(account.id)
  await logAudit(req, {
    action: 'UPDATE', entity: 'receivable', entityId: id,
    summary: `${ar0.code} 登记回款 ${amt.toFixed(2)}（${result.txn.code}）` + (result.prepayment ? `，超出 ${result.excess.toFixed(2)} 转预收 ${result.prepayment.code}` : ''),
    before: result.before, after: result.updated
  })
  if (result.prepayment) {
    await logAudit(req, { action: 'CREATE', entity: 'prepayment', entityId: result.prepayment.id, summary: `登记回款超收自动转预收 ${result.prepayment.code} ${result.excess.toFixed(2)}（${ar0.code} ← ${result.txn.code}）`, after: result.prepayment })
  }
  return ok(res, { receivable: result.updated, transaction: result.txn, receipt: result.receipt, prepayment: result.prepayment, overpaidAmount: result.excess.toFixed(2) })
}))

export default router
