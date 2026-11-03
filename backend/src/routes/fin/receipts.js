// v1.4 收款认领明细（receipts）：查询 / 撤销认领
// 新增认领走 POST /receivables/:id/receipt（应收侧）或 POST /transactions/:id/reconcile（流水侧拆分），核心都在 lib/receipt.js
import express from 'express'
import prisma from '../../lib/prisma.js'
import { requirePermission, scopeWhere, inScope, can } from '../../lib/auth.js'
import { ok, badRequest, notFound, forbidden, wrap } from '../../lib/response.js'
import { recalcAccountBalance } from '../../lib/balance.js'
import { logAudit } from '../../lib/audit.js'
import { assertPeriodOpen } from '../../lib/close.js'
import { ReceiptError, lockTransaction, lockReceivable, revokeReceipt } from '../../lib/receipt.js'

const router = express.Router()

const INCLUDE = {
  receivable: { select: { id: true, code: true, title: true, amount: true, receivedAmount: true, status: true } },
  transaction: { select: { id: true, code: true, txnDate: true, amount: true, counterparty: true, accountId: true, status: true, deletedAt: true } }
}

// 列表：?receivable_id= / transaction_id= / company_id=，include_revoked=1 连已撤销的一起返回
router.get('/', requirePermission('receivable.view'), wrap(async (req, res) => {
  const q = req.query
  const take = Math.min(Number(q.page_size) || 50, 500)
  const page = Math.max(1, Number(q.page) || 1)
  const where = { AND: [scopeWhere(req.user)], ...(q.include_revoked === '1' ? {} : { deletedAt: null }) }
  if (q.company_id) where.companyId = BigInt(q.company_id)
  if (q.receivable_id) where.receivableId = BigInt(q.receivable_id)
  if (q.transaction_id) where.transactionId = BigInt(q.transaction_id)
  if (q.source) where.source = q.source
  const [list, total] = await Promise.all([
    prisma.receipt.findMany({ where, include: INCLUDE, orderBy: [{ receiptDate: 'desc' }, { id: 'desc' }], skip: (page - 1) * take, take }),
    prisma.receipt.count({ where })
  ])
  return ok(res, { list, total, page, pageSize: take })
}))

// 撤销认领：软删 + activeFlag=NULL，应收按剩余明细重算，流水关联/状态恢复
//  - LINK：只解除关联，流水保留，最后一笔撤掉时流水状态恢复成认领前的
//  - AUTO / BACKFILL（登记回款时系统新建的流水）：流水上没有别的认领时一并作废；?keep_transaction=1 保留流水
//  - 同一次认领超收转出的预收款一并撤销（已被使用的不让撤）
router.delete('/:id(\\d+)', requirePermission('receivable.manage'), wrap(async (req, res) => {
  if (!can(req.user, 'transaction.manage')) return forbidden(res, '撤销认领会改动流水的关联与状态，需要「transaction.manage」权限')
  const id = BigInt(req.params.id)
  const keepTransaction = ['1', 'true'].includes(String(req.query.keep_transaction ?? req.body?.keepTransaction ?? ''))
  const r0 = await prisma.receipt.findFirst({ where: { id, deletedAt: null }, include: INCLUDE })
  if (!r0 || !inScope(req.user, r0.companyId)) return notFound(res, '认领记录不存在或已撤销')
  const locked = await assertPeriodOpen(r0.companyId, r0.transaction.txnDate)
  if (locked) return badRequest(res, `流水 ${r0.transaction.code} 所在${locked}`)

  let out
  try {
    out = await prisma.$transaction(async (tx) => {
      await lockTransaction(tx, r0.transactionId) // 先流水、后应收
      await lockReceivable(tx, r0.receivableId)
      const receipt = await tx.receipt.findFirst({ where: { id, deletedAt: null } })
      if (!receipt) throw new ReceiptError('这条认领已被撤销')
      const r = await revokeReceipt(tx, receipt, { revokedBy: req.user?.username || req.user?.name || null, keepTransaction })
      const [after, receivable, transaction] = await Promise.all([
        tx.receipt.findUnique({ where: { id } }),
        tx.receivable.findUnique({ where: { id: receipt.receivableId } }),
        tx.transaction.findUnique({ where: { id: receipt.transactionId } })
      ])
      return { ...r, after, receivable, transaction }
    }, { timeout: 15000 })
  } catch (e) {
    if (e instanceof ReceiptError) return badRequest(res, e.message)
    throw e
  }
  await recalcAccountBalance(out.transaction.accountId)
  const amt = Number(r0.amount).toFixed(2)
  await logAudit(req, {
    action: 'DELETE', entity: 'receipt', entityId: id,
    summary: `撤销认领 ${r0.receivable.code} ← ${r0.transaction.code} ¥${amt}（${r0.source}）` +
      (out.voidedTransaction ? `，流水 ${r0.transaction.code} 一并作废` : '') +
      (out.prepayments.length ? `，连带撤销预收 ${out.prepayments.map((p) => p.code).join('、')}` : ''),
    before: r0, after: { receipt: out.after, receivable: out.receivable, transaction: out.transaction }
  })
  return ok(res, {
    receipt: out.after, receivable: out.receivable, transaction: out.transaction,
    voidedTransaction: out.voidedTransaction, revokedPrepayments: out.prepayments
  })
}))

export default router
