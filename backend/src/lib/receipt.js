// v1.4 收款认领（Receipt）核心
// 硬规则：receivables.received_amount 只有本文件的 recalcReceivable() 能写，而且永远「按 receipts 全量重算」，不做加减。
// 以前是在回款接口里读-改-写累加，只要有一条路径漏了（作废流水、手改应收……）就永久失真，见 04-踩过的坑。
import { Prisma } from '@prisma/client'
import { nextCode } from './code.js'

const D = (v) => new Prisma.Decimal(v ?? 0)

/** 系统算出来的状态；人工终态不被收款自动改写 */
export const SYSTEM_STATUSES = ['PENDING', 'PARTIAL', 'RECEIVED']
export const MANUAL_STATUSES = ['CANCELLED', 'WRITTEN_OFF']
/** 流水 refType 里表示「被应收认领」的值，只能由 Receipt 维护，接口不接受手工写入 */
export const RECEIVABLE_REF_TYPES = ['RECEIVABLE', 'RECEIVABLE_MULTI']
/** 流水被「认领」（应收或预收占用）时的 refType；同样只能由 receipts / prepayments 维护 */
export const CLAIM_REF_TYPES = [...RECEIVABLE_REF_TYPES, 'PREPAYMENT']

/** 业务校验失败：路由层统一翻成 badRequest（code 9002） */
export class ReceiptError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReceiptError'
  }
}

/** 金额：数字或数字字符串，> 0，最多两位小数。返回 Decimal，不合法抛 ReceiptError */
export function parseAmount(v, label = '金额') {
  const s = String(v ?? '').trim()
  if (!s) throw new ReceiptError(`请填写${label}`)
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) throw new ReceiptError(`${label}格式不对`)
  const d = D(s)
  if (d.lte(0)) throw new ReceiptError(`${label}必须大于 0`)
  if (d.decimalPlaces() > 2) throw new ReceiptError(`${label}最多两位小数`)
  return d
}

export function computeStatus(amount, received) {
  const r = D(received)
  if (r.lte(0)) return 'PENDING'
  return r.gte(D(amount)) ? 'RECEIVED' : 'PARTIAL'
}

/** 应收的有效认领合计 */
export async function sumReceipts(tx, receivableId) {
  const agg = await tx.receipt.aggregate({
    where: { receivableId: BigInt(receivableId), deletedAt: null },
    _sum: { amount: true }, _max: { receiptDate: true }
  })
  return { total: D(agg._sum.amount), lastDate: agg._max.receiptDate ?? null }
}

/** 流水的有效认领合计 */
export async function sumTxnReceipts(tx, transactionId) {
  const agg = await tx.receipt.aggregate({
    where: { transactionId: BigInt(transactionId), deletedAt: null }, _sum: { amount: true }
  })
  return D(agg._sum.amount)
}

/** 流水上转成预收款的合计（未作废的） */
export async function sumTxnPrepayments(tx, transactionId) {
  const agg = await tx.prepayment.aggregate({
    where: { transactionId: BigInt(transactionId), deletedAt: null }, _sum: { amount: true }
  })
  return D(agg._sum.amount)
}

/** 流水已被占用的金额 = 认领到应收 + 转成预收 */
export async function sumTxnClaimed(tx, transactionId) {
  const [r, p] = await Promise.all([sumTxnReceipts(tx, transactionId), sumTxnPrepayments(tx, transactionId)])
  return r.plus(p)
}

/** 行锁（须在 prisma.$transaction 内调用）。固定顺序：先流水、后应收，防死锁 */
export async function lockTransaction(tx, id) {
  await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${BigInt(id)} FOR UPDATE`
  return tx.transaction.findFirst({ where: { id: BigInt(id), deletedAt: null } })
}
export async function lockReceivable(tx, id) {
  await tx.$queryRaw`SELECT id FROM receivables WHERE id = ${BigInt(id)} FOR UPDATE`
  return tx.receivable.findFirst({ where: { id: BigInt(id), deletedAt: null } })
}

/**
 * 历史差异保护：received_amount 和 receipts 汇总对不上的应收（v1.4 回填前的老数据 / 差异清单未确认的），
 * 一律不让再动——否则这次重算会把差异「悄悄」改掉，首页待收金额跳变却没人确认过。
 */
export async function assertConsistent(tx, ar) {
  const { total } = await sumReceipts(tx, ar.id)
  if (!total.eq(D(ar.receivedAmount))) {
    throw new ReceiptError(
      `${ar.code} 的已收金额（${D(ar.receivedAmount).toFixed(2)}）与收款明细合计（${total.toFixed(2)}）不一致，` +
      '属于 v1.4 历史差异清单里待确认的数据，确认处理前不能登记回款或修改金额')
  }
  return total
}

/**
 * 唯一可写 received_amount 的入口：按有效 receipts 全量重算 已收 / 状态 / 实收日期。
 * @param opts.status  调用方想要的人工状态（只接受 CANCELLED / WRITTEN_OFF）；
 *                     opts.resetStatus=true 表示从人工终态改回，状态交给系统算
 */
export async function recalcReceivable(tx, receivableId, { status: manual, resetStatus = false, data = {} } = {}) {
  const id = BigInt(receivableId)
  const ar = await tx.receivable.findUnique({ where: { id } })
  if (!ar) return null
  const amount = data.amount !== undefined ? D(data.amount) : D(ar.amount)
  const { total, lastDate } = await sumReceipts(tx, id)
  let status
  if (manual && MANUAL_STATUSES.includes(manual)) status = manual
  else if (!resetStatus && MANUAL_STATUSES.includes(ar.status)) status = ar.status
  else status = computeStatus(amount, total)
  return tx.receivable.update({
    where: { id },
    data: { ...data, receivedAmount: total, status, actualDate: lastDate }
  })
}

/** 本次金额不能超过应收剩余。v1.4 切片 2 起登记回款/认领不再用它（超收转预收，见 allocate），留给需要硬拦的场景 */
export function assertWithinRemaining(ar, received, amt) {
  const remaining = D(ar.amount).minus(D(received))
  if (D(amt).gt(remaining)) {
    throw new ReceiptError(`本次收款 ${D(amt).toFixed(2)} 超过应收剩余 ${remaining.toFixed(2)}（${ar.code}），不允许超收；` +
      '如客户确实多付，请先核对并修改应收金额')
  }
}

/**
 * 流水改动前的检查（修「作废/改小流水不回退应收已收」）：
 *  - 已被认领的流水不能作废、不能改公司/方向，金额不能改到小于已认领合计
 *  - v1.4 回填前的历史回款流水（ref_type=RECEIVABLE 但还没有 receipt）按「全额已认领」处理
 * @param change { delete?: true, amount?, direction?, companyId? }
 */
export async function assertTxnChangeAllowed(tx, txn, change) {
  const allocated = await sumTxnClaimed(tx, txn.id)
  const legacy = allocated.eq(0) && RECEIVABLE_REF_TYPES.includes(txn.refType)
  if (allocated.eq(0) && !legacy) return
  const [linked, prepays] = await Promise.all([
    tx.receipt.findMany({ where: { transactionId: txn.id, deletedAt: null }, select: { receivable: { select: { code: true } } } }),
    tx.prepayment.findMany({ where: { transactionId: txn.id, deletedAt: null }, select: { code: true } })
  ])
  const codes = [...linked.map((r) => r.receivable.code), ...prepays.map((p) => `预收 ${p.code}`)]
  if (legacy && !codes.length) {
    const ar = txn.refId ? await tx.receivable.findUnique({ where: { id: txn.refId }, select: { code: true } }) : null
    if (ar) codes.push(ar.code)
  }
  const where = codes.length ? `已认领到 ${codes.join('、')}` : '是应收回款流水'
  const used = legacy ? D(txn.amount) : allocated
  if (change.delete) throw new ReceiptError(`流水 ${txn.code} ${where}，不能直接作废；请先撤销认领（应收已收金额会随之重算）`)
  if (change.direction !== undefined && change.direction !== txn.direction) {
    throw new ReceiptError(`流水 ${txn.code} ${where}，不能修改收支方向，请先撤销认领`)
  }
  if (change.companyId !== undefined && String(change.companyId) !== String(txn.companyId)) {
    throw new ReceiptError(`流水 ${txn.code} ${where}，不能改到别的公司，请先撤销认领`)
  }
  if (legacy && change.amount !== undefined && !D(change.amount).eq(D(txn.amount))) {
    throw new ReceiptError(`流水 ${txn.code} 是 v1.4 回填前的历史回款流水，回填收款明细之前不能修改金额`)
  }
  if (change.amount !== undefined && D(change.amount).lt(used)) {
    throw new ReceiptError(`流水 ${txn.code} ${where}，已认领 ${used.toFixed(2)}，金额不能改到小于这个数；请先撤销认领`)
  }
}

// ───────────────────────── v1.4 切片 2：认领 / 撤销 / 预收 ─────────────────────────

const REF_LABEL = { PAYMENT: '付款单', LOAN: '借款', PAYROLL: '工资', REIMBURSEMENT: '报销' }

export function prepaymentStatus(amount, used) {
  const u = D(used)
  if (u.lte(0)) return 'OPEN'
  return u.gte(D(amount)) ? 'USED' : 'PARTIAL'
}

/**
 * 这笔流水能不能被认领、还剩多少可认领（须已锁流水）。不能认领的直接抛 ReceiptError。
 * 排除：非收入、内部转账、已挂付款单 / 借款还款 / 其他单据、v1.4 回填前还没回填的历史回款流水（视为已全额认领）
 */
export async function assertTxnClaimable(tx, txn) {
  if (txn.direction !== 'IN') throw new ReceiptError(`流水 ${txn.code} 是支出，不能认领到应收`)
  if (D(txn.amount).lte(0)) throw new ReceiptError(`流水 ${txn.code} 金额不大于 0，不能认领`)
  if (txn.transferPairId) throw new ReceiptError(`流水 ${txn.code} 是内部转账，不能认领到应收`)
  if (txn.refType && !CLAIM_REF_TYPES.includes(txn.refType)) {
    throw new ReceiptError(`流水 ${txn.code} 已关联${REF_LABEL[txn.refType] || `其他单据（${txn.refType}）`}，不能再认领到应收`)
  }
  const [pay, loan] = await Promise.all([
    tx.payment.count({ where: { transactionId: txn.id, deletedAt: null } }),
    tx.loanRepayment.count({ where: { transactionId: txn.id } })
  ])
  if (pay) throw new ReceiptError(`流水 ${txn.code} 已关联付款单，不能再认领到应收`)
  if (loan) throw new ReceiptError(`流水 ${txn.code} 已关联借款还款，不能再认领到应收`)
  const claimed = await sumTxnClaimed(tx, txn.id)
  if (claimed.eq(0) && RECEIVABLE_REF_TYPES.includes(txn.refType)) {
    throw new ReceiptError(`流水 ${txn.code} 是 v1.4 之前的历史回款流水，还没回填收款明细，暂不能认领`)
  }
  return { claimed, remaining: D(txn.amount).minus(claimed) }
}

/**
 * 按有效的 receipts / prepayments 重算流水的 refType / refId / status（只动被「认领」占用过的流水）
 *  - 认领到 1 笔应收 → RECEIVABLE / 应收 id；≥2 笔 → RECEIVABLE_MULTI / NULL；只有预收 → PREPAYMENT / 预收 id（多笔时 NULL）
 *  - 有任何占用 → status=RECONCILED（与回款、付款关联同口径）
 *  - 全部撤销 → refType/refId 清空，status 恢复为最近一次「从无到有」时记下的 txnStatusBefore
 */
export async function recalcTxnLink(tx, transactionId) {
  const id = BigInt(transactionId)
  const txn = await tx.transaction.findUnique({ where: { id } })
  if (!txn) return null
  const [receipts, prepays] = await Promise.all([
    tx.receipt.findMany({ where: { transactionId: id, deletedAt: null }, select: { receivableId: true } }),
    tx.prepayment.findMany({ where: { transactionId: id, deletedAt: null }, select: { id: true } })
  ])
  const arIds = [...new Set(receipts.map((r) => String(r.receivableId)))]
  let data
  if (arIds.length === 1) data = { refType: 'RECEIVABLE', refId: BigInt(arIds[0]), status: 'RECONCILED' }
  else if (arIds.length > 1) data = { refType: 'RECEIVABLE_MULTI', refId: null, status: 'RECONCILED' }
  else if (prepays.length) data = { refType: 'PREPAYMENT', refId: prepays.length === 1 ? prepays[0].id : null, status: 'RECONCILED' }
  else {
    if (!CLAIM_REF_TYPES.includes(txn.refType)) return txn
    const [r, p] = await Promise.all([
      tx.receipt.findFirst({ where: { transactionId: id, txnStatusBefore: { not: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      tx.prepayment.findFirst({ where: { transactionId: id, txnStatusBefore: { not: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    ])
    const last = [r, p].filter(Boolean).sort((a, b) => b.createdAt - a.createdAt)[0]
    data = { refType: null, refId: null, status: last?.txnStatusBefore || txn.status }
  }
  if (data.refType === txn.refType && String(data.refId) === String(txn.refId) && data.status === txn.status) return txn
  return tx.transaction.update({ where: { id }, data })
}

/**
 * 新建预收款（须在事务内；挂流水的须已锁流水并确认金额 ≤ 流水剩余）
 * 编号走 code_sequences（独立连接取号，事务回滚只会空掉一个号）
 */
export async function createPrepayment(tx, { companyId, customerId = null, amount, txn = null, accountId = null, prepayDate = null,
  receivableId = null, receiptId = null, source = 'MANUAL', remark = null, createdBy = null, txnStatusBefore = null }) {
  const date = txn ? txn.txnDate : prepayDate
  const code = await nextCode('PRE', { date: date || new Date() })
  return tx.prepayment.create({
    data: {
      code, companyId: BigInt(companyId), customerId: customerId ? BigInt(customerId) : null,
      amount: D(amount), usedAmount: D(0), prepayDate: date,
      accountId: txn ? txn.accountId : (accountId ? BigInt(accountId) : null),
      transactionId: txn ? txn.id : null,
      receivableId: receivableId ? BigInt(receivableId) : null, receiptId: receiptId ? BigInt(receiptId) : null,
      source, status: 'OPEN', txnStatusBefore, remark, createdBy
    }
  })
}

/**
 * 认领核心（应收页「认领流水」、流水页「拆分认领」、登记回款新建流水 三个入口共用）。
 * 前提：已在事务内按「先流水、后应收」锁好两行。
 * 超收：本次金额 > 应收剩余时不报错，应收按剩余结清，超出部分自动转一条预收款（老板拍板：超收转预收）
 * @param claimable 流水本次最多可占用的金额（调用方用 assertTxnClaimable 算；AUTO 新建流水就是流水金额）
 * @returns { receipt, prepayment|null, receiptAmount, excess }
 */
export async function allocate(tx, { txn, ar, amount, claimable, claimedBefore = D(0), source = 'LINK', remark = null, createdBy = null }) {
  const amt = D(amount)
  if (String(txn.companyId) !== String(ar.companyId)) throw new ReceiptError(`流水 ${txn.code} 不属于应收 ${ar.code} 所在公司，不能认领`)
  if (!SYSTEM_STATUSES.includes(ar.status) || ar.status === 'RECEIVED') {
    throw new ReceiptError(`${ar.code} 状态是「${{ RECEIVED: '已收款', CANCELLED: '已取消', WRITTEN_OFF: '坏账核销' }[ar.status] || ar.status}」，不能再认领收款`)
  }
  const received = await assertConsistent(tx, ar)
  const arRemaining = D(ar.amount).minus(received)
  if (arRemaining.lte(0)) throw new ReceiptError(`${ar.code} 已收清，不能再认领收款`)
  if (amt.gt(D(claimable))) {
    throw new ReceiptError(`流水 ${txn.code} 只剩 ${D(claimable).toFixed(2)} 可认领，本次 ${amt.toFixed(2)} 超出了`)
  }
  const dup = await tx.receipt.findFirst({ where: { receivableId: ar.id, transactionId: txn.id, deletedAt: null } })
  if (dup) throw new ReceiptError(`流水 ${txn.code} 已认领过 ${ar.code}（${D(dup.amount).toFixed(2)}），如需调整请先撤销那条认领`)

  const receiptAmount = Prisma.Decimal.min(amt, arRemaining)
  const excess = amt.minus(receiptAmount)
  // 流水从「没被占用」变成「被占用」时记下原状态，最后一笔撤销时恢复
  const statusBefore = source === 'LINK' && D(claimedBefore).eq(0) ? txn.status : null
  const receipt = await tx.receipt.create({
    data: {
      companyId: ar.companyId, receivableId: ar.id, transactionId: txn.id, amount: receiptAmount, receiptDate: txn.txnDate,
      source, txnStatusBefore: statusBefore, remark, createdBy
    }
  })
  let prepayment = null
  if (excess.gt(0)) {
    prepayment = await createPrepayment(tx, {
      companyId: ar.companyId, customerId: ar.customerId, amount: excess, txn,
      receivableId: ar.id, receiptId: receipt.id, source: 'OVERPAY', createdBy,
      remark: `认领超收自动转预收：流水 ${txn.code} 认领 ${amt.toFixed(2)} 到应收 ${ar.code}（剩余 ${arRemaining.toFixed(2)}），超出 ${excess.toFixed(2)}`
    })
  }
  await recalcReceivable(tx, ar.id)
  await recalcTxnLink(tx, txn.id)
  return { receipt, prepayment, receiptAmount, excess }
}

/**
 * 撤销一行认领（软删 + activeFlag=NULL），连带撤销同一次认领产生的 OVERPAY 预收款（已被使用的不能撤）。
 *  - LINK：只解除关联，流水保留，refType/status 按剩余占用重算（全撤完恢复原状态）
 *  - AUTO / BACKFILL：这笔流水当初就是为这次回款建的；流水上没有别的占用时一并作废（keepTransaction=true 保留）
 * 前提：已在事务内按「先流水、后应收」锁好两行。
 * @returns { voidedTransaction: boolean, prepayments: 撤销的预收 }
 */
export async function revokeReceipt(tx, receipt, { revokedBy = null, keepTransaction = false } = {}) {
  const ar = await tx.receivable.findUnique({ where: { id: receipt.receivableId } })
  await assertConsistent(tx, ar)
  const prepays = await tx.prepayment.findMany({ where: { receiptId: receipt.id, deletedAt: null } })
  const usedOne = prepays.find((p) => D(p.usedAmount).gt(0))
  if (usedOne) throw new ReceiptError(`这次认领超出部分转成的预收款 ${usedOne.code} 已被使用 ${D(usedOne.usedAmount).toFixed(2)}，不能撤销`)
  const now = new Date()
  await tx.receipt.update({ where: { id: receipt.id }, data: { deletedAt: now, activeFlag: null, revokedBy } })
  if (prepays.length) {
    await tx.prepayment.updateMany({ where: { id: { in: prepays.map((p) => p.id) } }, data: { deletedAt: now } })
  }
  await recalcReceivable(tx, receipt.receivableId)

  let voidedTransaction = false
  if (['AUTO', 'BACKFILL'].includes(receipt.source) && !keepTransaction) {
    const left = await sumTxnClaimed(tx, receipt.transactionId)
    if (left.eq(0)) {
      await tx.transaction.update({ where: { id: receipt.transactionId }, data: { deletedAt: now } }) // ref 保留，作废后仍能追溯是哪笔应收的回款
      voidedTransaction = true
    }
  }
  if (!voidedTransaction) await recalcTxnLink(tx, receipt.transactionId)
  return { voidedTransaction, prepayments: prepays }
}
