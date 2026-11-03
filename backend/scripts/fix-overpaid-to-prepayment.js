// v1.4 历史超收修正：把「已收（= 收款明细合计）超过应收金额」的那部分转成预收款（老板拍板：超收转预收）
//
// 用法（在 backend/ 下）：
//   node scripts/fix-overpaid-to-prepayment.js            默认 dry-run：只打印要怎么改，不写库
//   node scripts/fix-overpaid-to-prepayment.js --apply    真正写库（每笔应收一个事务，写审计日志）
// 连接哪个库看 DATABASE_URL；本地 dev 库：set -a; source .env.local; set +a
//
// 范围 = ar-diff-report.js 差异清单的「三、超收」：received_amount 与 receipts 汇总一致、但汇总 > 应收金额的应收。
// 已收与明细对不上的（清单「一、差异明细」）**不处理**，打印出来，等逐条确认、先按流水重算之后再跑本脚本。
//
// 怎么改（以 AR 应收 5,000、明细 T1 99,999 + T2 3,000 + T3 2,000.01 为例，超收 99,999.01）：
//   从最晚的一条明细往前「削」超出的金额（后到的钱视为多付的）：
//   每削一条 → 原明细撤销（软删、active_flag=NULL，留历史），剩下的部分（> 0 时）新插一条同来源的明细；
//   削下来的金额 → 一条预收款（source=HISTORY_FIX，挂原流水、客户同应收），流水的可认领金额不变（明细 + 预收 = 原额）
//   然后按明细全量重算应收（lib/receipt.js recalcReceivable）与流水关联（recalcTxnLink）
// 幂等：改完后该应收不再超收，第二遍不会再动它。
import { Prisma } from '@prisma/client'
import prisma from '../src/lib/prisma.js'
import { logAudit } from '../src/lib/audit.js'
import { lockTransaction, lockReceivable, sumReceipts, recalcReceivable, recalcTxnLink, createPrepayment } from '../src/lib/receipt.js'

const APPLY = process.argv.includes('--apply')
const OPERATOR = 'system:v1.4-overpay-fix'
const fakeReq = { user: { name: OPERATOR }, headers: {}, socket: {} }
const D = (v) => new Prisma.Decimal(v ?? 0)
const money = (v) => D(v).toNumber().toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 从最晚的明细往前削 excess，返回 [{ receipt, take, keep }] */
function planShave(receipts, excess) {
  const sorted = [...receipts].sort((a, b) => (b.receiptDate - a.receiptDate) || (b.id > a.id ? 1 : -1))
  const out = []
  let left = D(excess)
  for (const r of sorted) {
    if (left.lte(0)) break
    const take = Prisma.Decimal.min(D(r.amount), left)
    out.push({ receipt: r, take, keep: D(r.amount).minus(take) })
    left = left.minus(take)
  }
  return out
}

async function findTargets() {
  const ars = await prisma.receivable.findMany({
    where: { deletedAt: null },
    include: { company: { select: { code: true } }, customer: { select: { name: true } } },
    orderBy: { id: 'asc' }
  })
  const targets = []
  const skipped = []
  for (const ar of ars) {
    const receipts = await prisma.receipt.findMany({
      where: { receivableId: ar.id, deletedAt: null },
      include: { transaction: { select: { id: true, code: true, txnDate: true, amount: true, deletedAt: true } } }
    })
    const total = receipts.reduce((s, r) => s.plus(r.amount), D(0))
    if (D(ar.amount).lte(0)) continue // 应收金额 ≤ 0 的在差异清单里单独处理
    if (!total.gt(ar.amount)) continue
    if (!total.eq(D(ar.receivedAmount))) {
      skipped.push({ ar, total, reason: `已收 ${money(ar.receivedAmount)} ≠ 明细合计 ${money(total)}，属于差异清单「一」，先确认并按流水重算后再处理` })
      continue
    }
    const deadTxn = receipts.find((r) => r.transaction.deletedAt)
    if (deadTxn) { skipped.push({ ar, total, reason: `明细指向已作废流水 ${deadTxn.transaction.code}，需人工处理` }); continue }
    const excess = total.minus(ar.amount)
    targets.push({ ar, total, excess, plan: planShave(receipts, excess) })
  }
  return { targets, skipped }
}

async function applyOne({ ar }) {
  return prisma.$transaction(async (tx) => {
    // 重新读一遍（dry-run 到 apply 之间可能有人动过），按「先流水（id 升序）、后应收」加锁
    const rs0 = await tx.receipt.findMany({ where: { receivableId: ar.id, deletedAt: null }, select: { transactionId: true } })
    const txnIds = [...new Set(rs0.map((r) => r.transactionId))].sort((a, b) => (a < b ? -1 : 1))
    const txns = {}
    for (const id of txnIds) txns[String(id)] = await lockTransaction(tx, id)
    const cur = await lockReceivable(tx, ar.id)
    const { total } = await sumReceipts(tx, ar.id)
    if (!total.gt(cur.amount) || !total.eq(D(cur.receivedAmount))) return null // 已不满足条件：跳过
    const excess = total.minus(cur.amount)
    const receipts = await tx.receipt.findMany({ where: { receivableId: ar.id, deletedAt: null } })
    const plan = planShave(receipts, excess)
    const now = new Date()
    const prepays = []
    for (const { receipt: r, take, keep } of plan) {
      await tx.receipt.update({ where: { id: r.id }, data: { deletedAt: now, activeFlag: null, revokedBy: OPERATOR } })
      if (keep.gt(0)) {
        await tx.receipt.create({
          data: {
            companyId: r.companyId, receivableId: r.receivableId, transactionId: r.transactionId, amount: keep, receiptDate: r.receiptDate,
            source: r.source, txnStatusBefore: null, createdBy: OPERATOR,
            remark: `v1.4 超收修正：由收款明细 #${r.id}（${money(r.amount)}）拆出，${money(take)} 转预收`
          }
        })
      }
      const txn = txns[String(r.transactionId)]
      prepays.push(await createPrepayment(tx, {
        companyId: cur.companyId, customerId: cur.customerId, amount: take, txn, receivableId: cur.id, source: 'HISTORY_FIX', createdBy: OPERATOR,
        remark: `v1.4 历史超收修正：应收 ${cur.code} 金额 ${money(cur.amount)}、已收 ${money(total)}，流水 ${txn.code} 中 ${money(take)} 转预收`
      }))
    }
    const after = await recalcReceivable(tx, cur.id)
    for (const id of txnIds) await recalcTxnLink(tx, id)
    return { before: cur, after, prepays, excess }
  }, { timeout: 30000 })
}

async function main() {
  const db = (await prisma.$queryRawUnsafe('SELECT DATABASE() AS db'))[0].db
  const { targets, skipped } = await findTargets()
  console.log(`[overpay-fix] 库 ${db}｜${APPLY ? '--apply 写库' : 'dry-run（不写库，加 --apply 才执行）'}｜待修正 ${targets.length} 笔，跳过 ${skipped.length} 笔`)
  for (const t of targets) {
    console.log(`\n  ${t.ar.code}（${t.ar.company.code} ${[t.ar.customer?.name, t.ar.title].filter(Boolean).join(' ')}）应收 ${money(t.ar.amount)}，已收 ${money(t.total)}，超收 ${money(t.excess)}`)
    for (const p of t.plan) {
      console.log(`    明细 #${p.receipt.id} 流水 ${p.receipt.transaction.code}（${p.receipt.source}） ${money(p.receipt.amount)} → 留在应收 ${money(p.keep)}，转预收 ${money(p.take)}`)
    }
  }
  for (const s of skipped) console.log(`  跳过 ${s.ar.code}：${s.reason}`)
  if (!APPLY) return

  let done = 0
  for (const t of targets) {
    const r = await applyOne(t)
    if (!r) { console.log(`  ${t.ar.code}：状态已变化，跳过`); continue }
    done++
    await logAudit(fakeReq, {
      action: 'UPDATE', entity: 'receivable', entityId: r.before.id,
      summary: `v1.4 历史超收修正：${r.before.code} 超收 ${money(r.excess)} 转预收 ${r.prepays.map((p) => `${p.code} ${money(p.amount)}`).join('、')}`,
      before: r.before, after: r.after
    })
    for (const p of r.prepays) {
      await logAudit(fakeReq, { action: 'CREATE', entity: 'prepayment', entityId: p.id, summary: `v1.4 历史超收修正生成预收 ${p.code} ${money(p.amount)}（${r.before.code}）`, after: p })
    }
    console.log(`  ✔ ${r.before.code}：已收 ${money(r.before.receivedAmount)} → ${money(r.after.receivedAmount)}（${r.after.status}），生成预收 ${r.prepays.map((p) => `${p.code} ${money(p.amount)}`).join('、')}`)
  }
  console.log(`[overpay-fix] 完成 ${done} 笔`)
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
