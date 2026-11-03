// v1.4 预收款：客户打来的钱里暂时没有应收可冲的部分
// 来源：认领流水 / 登记回款时超过应收剩余的部分自动转入（OVERPAY）、手工登记（MANUAL）、历史超收修正脚本（HISTORY_FIX）
// 权限沿用应收：查看 receivable.view，登记 / 作废 receivable.manage（挂流水的另需 transaction.manage）
import express from 'express'
import prisma from '../../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { requirePermission, scopeWhere, inScope, can } from '../../lib/auth.js'
import { ok, badRequest, notFound, forbidden, wrap } from '../../lib/response.js'
import { toDate } from '../../lib/period.js'
import { recalcAccountBalance } from '../../lib/balance.js'
import { logAudit } from '../../lib/audit.js'
import { assertPeriodOpen } from '../../lib/close.js'
import {
  ReceiptError, parseAmount, lockTransaction, assertTxnClaimable, createPrepayment, recalcTxnLink
} from '../../lib/receipt.js'

const router = express.Router()
const D = (v) => new Prisma.Decimal(v ?? 0)

const INCLUDE = {
  company: { select: { id: true, code: true, name: true } },
  customer: { select: { id: true, name: true } },
  account: { select: { id: true, name: true } },
  transaction: { select: { id: true, code: true, txnDate: true, amount: true } },
  receivable: { select: { id: true, code: true, title: true } }
}
const withBalance = (p) => ({ ...p, balance: D(p.amount).minus(p.usedAmount).toFixed(2) })

// 列表 + 按客户汇总余额（byCustomer 用同一组筛选条件，不分页）
router.get('/', requirePermission('receivable.view'), wrap(async (req, res) => {
  const q = req.query
  const take = Math.min(Number(q.page_size) || 20, 500)
  const page = Math.max(1, Number(q.page) || 1)
  const where = { deletedAt: null, AND: [scopeWhere(req.user)] } // 范围放 AND，company_id 不能覆盖它
  if (q.company_id) where.companyId = BigInt(q.company_id)
  if (q.customer_id) where.customerId = BigInt(q.customer_id)
  if (q.status) where.status = q.status
  if (q.source) where.source = q.source
  if (q.transaction_id) where.transactionId = BigInt(q.transaction_id)
  if (q.receivable_id) where.receivableId = BigInt(q.receivable_id)
  if (q.keyword) where.OR = [{ code: { contains: q.keyword } }, { remark: { contains: q.keyword } }]

  const [list, total, groups] = await Promise.all([
    prisma.prepayment.findMany({ where, include: INCLUDE, orderBy: [{ prepayDate: 'desc' }, { id: 'desc' }], skip: (page - 1) * take, take }),
    prisma.prepayment.count({ where }),
    prisma.prepayment.groupBy({ by: ['companyId', 'customerId'], where, _sum: { amount: true, usedAmount: true }, _count: true })
  ])
  const custIds = groups.map((g) => g.customerId).filter(Boolean)
  const custs = custIds.length ? await prisma.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, name: true } }) : []
  const byCustomer = groups.map((g) => {
    const amount = D(g._sum.amount)
    const used = D(g._sum.usedAmount)
    return {
      companyId: String(g.companyId), customerId: g.customerId ? String(g.customerId) : null,
      customerName: custs.find((c) => c.id === g.customerId)?.name || '（未指定客户）',
      count: g._count, amount: amount.toFixed(2), usedAmount: used.toFixed(2), balance: amount.minus(used).toFixed(2)
    }
  }).sort((a, b) => D(b.balance).comparedTo(D(a.balance)))
  const balance = byCustomer.reduce((s, x) => s.plus(x.balance), D(0))
  return ok(res, { list: list.map(withBalance), total, page, pageSize: take, byCustomer, balanceTotal: balance.toFixed(2) })
}))

router.get('/:id(\\d+)', requirePermission('receivable.view'), wrap(async (req, res) => {
  const row = await prisma.prepayment.findFirst({ where: { id: BigInt(req.params.id), deletedAt: null }, include: INCLUDE })
  if (!row || !inScope(req.user, row.companyId)) return notFound(res)
  return ok(res, withBalance(row))
}))

// 登记预收：{ companyId, customerId?, amount, prepayDate?, accountId?, transactionId?, remark? }
// 挂流水的：公司 / 账户 / 日期取流水的；金额不能超过流水剩余可认领；流水所在月份不能已关账
router.post('/', requirePermission('receivable.manage'), wrap(async (req, res) => {
  const b = req.body || {}
  const idOk = (v) => v === undefined || v === null || v === '' || /^[1-9]\d{0,18}$/.test(String(v))
  if (![b.companyId, b.customerId, b.accountId, b.transactionId].every(idOk)) return badRequest(res, 'id 参数不合法')
  let amt
  try {
    amt = parseAmount(b.amount, '预收金额')
  } catch (e) {
    return badRequest(res, e.message)
  }
  const hasTxn = !!b.transactionId
  if (hasTxn && !can(req.user, 'transaction.manage')) return forbidden(res, '挂流水会改动流水的关联与状态，需要「transaction.manage」权限')

  let txn0 = null
  if (hasTxn) {
    txn0 = await prisma.transaction.findFirst({ where: { id: BigInt(b.transactionId), deletedAt: null } })
    if (!txn0 || !inScope(req.user, txn0.companyId)) return notFound(res, '流水不存在或已作废')
    if (b.companyId && String(b.companyId) !== String(txn0.companyId)) return badRequest(res, `流水 ${txn0.code} 不属于所选公司`)
    const locked = await assertPeriodOpen(txn0.companyId, txn0.txnDate)
    if (locked) return badRequest(res, `流水 ${txn0.code} 所在${locked}`)
  }
  const companyId = txn0 ? txn0.companyId : (b.companyId ? BigInt(b.companyId) : null)
  if (!companyId) return badRequest(res, '请选择公司')
  if (!inScope(req.user, companyId)) return forbidden(res, '无权在该公司下登记预收')
  const prepayDate = txn0 ? txn0.txnDate : toDate(b.prepayDate)
  if (!prepayDate) return badRequest(res, '请填写预收日期（或选择一笔流水）')
  if (b.customerId) {
    const c = await prisma.customer.findFirst({ where: { id: BigInt(b.customerId), deletedAt: null } })
    if (!c) return notFound(res, '客户不存在')
    if (c.companyId && String(c.companyId) !== String(companyId)) return badRequest(res, '客户不属于该公司')
  }
  if (!txn0 && b.accountId) {
    const a = await prisma.account.findFirst({ where: { id: BigInt(b.accountId), deletedAt: null } })
    if (!a || String(a.companyId) !== String(companyId)) return badRequest(res, '收款账户不属于该公司')
  }

  let row
  try {
    row = await prisma.$transaction(async (tx) => {
      let txn = null
      let statusBefore = null
      if (txn0) {
        txn = await lockTransaction(tx, txn0.id)
        if (!txn) throw new ReceiptError('流水不存在或已作废')
        const { claimed, remaining } = await assertTxnClaimable(tx, txn)
        if (amt.gt(remaining)) throw new ReceiptError(`流水 ${txn.code} 只剩 ${remaining.toFixed(2)} 可认领，预收 ${amt.toFixed(2)} 超出了`)
        if (claimed.eq(0)) statusBefore = txn.status
      }
      const p = await createPrepayment(tx, {
        companyId, customerId: b.customerId || null, amount: amt, txn, accountId: b.accountId || null, prepayDate,
        source: 'MANUAL', remark: b.remark || null, createdBy: req.user?.username || req.user?.name || null, txnStatusBefore: statusBefore
      })
      if (txn) await recalcTxnLink(tx, txn.id)
      return tx.prepayment.findUnique({ where: { id: p.id }, include: INCLUDE })
    }, { timeout: 15000 })
  } catch (e) {
    if (e instanceof ReceiptError) return badRequest(res, e.message)
    throw e
  }
  if (row.accountId && txn0) await recalcAccountBalance(row.accountId)
  await logAudit(req, { action: 'CREATE', entity: 'prepayment', entityId: row.id, summary: `登记预收 ${row.code} ${amt.toFixed(2)}${txn0 ? `（流水 ${txn0.code}）` : ''}`, after: row })
  return ok(res, withBalance(row))
}))

// 作废预收（软删）：已被使用的不能作废；挂了流水的，流水剩余可认领随之恢复
router.delete('/:id(\\d+)', requirePermission('receivable.manage'), wrap(async (req, res) => {
  const id = BigInt(req.params.id)
  const before = await prisma.prepayment.findFirst({ where: { id, deletedAt: null }, include: INCLUDE })
  if (!before || !inScope(req.user, before.companyId)) return notFound(res)
  if (D(before.usedAmount).gt(0)) return badRequest(res, `预收 ${before.code} 已使用 ${D(before.usedAmount).toFixed(2)}，不能作废`)
  if (before.transactionId) {
    if (!can(req.user, 'transaction.manage')) return forbidden(res, '作废挂流水的预收会改动流水关联，需要「transaction.manage」权限')
    const locked = await assertPeriodOpen(before.companyId, before.transaction.txnDate)
    if (locked) return badRequest(res, `流水 ${before.transaction.code} 所在${locked}`)
  }
  await prisma.$transaction(async (tx) => {
    if (before.transactionId) await lockTransaction(tx, before.transactionId)
    await tx.prepayment.update({ where: { id }, data: { deletedAt: new Date() } })
    if (before.transactionId) await recalcTxnLink(tx, before.transactionId)
  })
  if (before.accountId && before.transactionId) await recalcAccountBalance(before.accountId)
  await logAudit(req, { action: 'DELETE', entity: 'prepayment', entityId: id, summary: `作废预收 ${before.code} ${D(before.amount).toFixed(2)}`, before })
  return ok(res, { id: String(id) })
}))

export default router
