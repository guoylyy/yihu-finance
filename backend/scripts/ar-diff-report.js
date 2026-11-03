// v1.4 历史差异清单：应收的 received_amount（老字段，靠累加得来）与「按收款明细 receipts 重算」对不上的，逐条列出来给老板确认
//
// 用法（在 backend/ 下，先跑 backfill-receipts.js）：
//   node scripts/ar-diff-report.js                 写到 ../docs/v1.4-历史差异清单.md
//   node scripts/ar-diff-report.js --out <path>    写到指定文件
//   node scripts/ar-diff-report.js --stdout        只打印
//
// **只读**：不改任何数据。老板已拍板「以流水为准」，确认后再单独执行修正（届时走 lib/receipt.js 的 recalcReceivable + logAudit）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Prisma } from '@prisma/client'
import prisma from '../src/lib/prisma.js'
import { computeStatus, MANUAL_STATUSES } from '../src/lib/receipt.js'

const D = (v) => new Prisma.Decimal(v ?? 0)
const argv = process.argv.slice(2)
const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]) : path.resolve(here, '../../docs/v1.4-历史差异清单.md')
const STDOUT = argv.includes('--stdout')

const STATUS = { PENDING: '待收款', PARTIAL: '部分收款', RECEIVED: '已收款', WRITTEN_OFF: '坏账核销', CANCELLED: '已取消' }
const money = (v) => D(v).toNumber().toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—')
const nowSH = () => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
}).format(new Date())

async function main() {
  const db = (await prisma.$queryRawUnsafe('SELECT DATABASE() AS db'))[0].db

  // 回填是否已跑：还有可回填却没回填的流水，差异清单会把它们全算成差额，先提示
  const [{ n: notBackfilled }] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS n FROM transactions t
    JOIN receivables r ON r.id = t.ref_id AND r.deleted_at IS NULL AND r.company_id = t.company_id
    WHERE t.ref_type = 'RECEIVABLE' AND t.deleted_at IS NULL AND t.direction = 'IN' AND t.amount > 0
      AND NOT EXISTS (SELECT 1 FROM receipts x WHERE x.transaction_id = t.id AND x.receivable_id = t.ref_id)`)

  const ars = await prisma.receivable.findMany({
    where: { deletedAt: null },
    include: { company: { select: { code: true } }, customer: { select: { name: true } } },
    orderBy: { id: 'asc' }
  })
  const receipts = await prisma.receipt.findMany({ where: { deletedAt: null }, select: { receivableId: true, transactionId: true, amount: true } })
  // 涉及的流水：明细里引用的 + 老字段 ref 指向它的（含已作废的，作废未回退正是最典型的差异来源）
  const txns = await prisma.transaction.findMany({
    where: { OR: [{ refType: 'RECEIVABLE', refId: { in: ars.map((a) => a.id) } }, { id: { in: receipts.map((r) => r.transactionId) } }] },
    select: { id: true, code: true, txnDate: true, direction: true, amount: true, refId: true, deletedAt: true }
  })

  const rows = []
  const overpaid = [] // 已收和流水一致、但超过应收金额的（v1.4 起禁止超收，历史上收多了的要人工决定：调应收金额 / 退款 / 转预收）
  for (const ar of ars) {
    const mine = receipts.filter((r) => r.receivableId === ar.id)
    const total = mine.reduce((s, r) => s.plus(r.amount), D(0))
    const diff = D(ar.receivedAmount).minus(total)
    const newStatus = MANUAL_STATUSES.includes(ar.status) ? ar.status : computeStatus(ar.amount, total)
    const badAmount = D(ar.amount).lte(0)
    if (diff.eq(0) && newStatus === ar.status && !badAmount) {
      if (total.gt(ar.amount)) overpaid.push({ ar, total, txns: txns.filter((t) => String(t.refId) === String(ar.id) && !t.deletedAt) })
      continue
    }

    const allocated = new Set(mine.map((r) => String(r.transactionId)))
    const related = txns.filter((t) => String(t.refId) === String(ar.id) || allocated.has(String(t.id)))
    const reasons = []
    const deleted = related.filter((t) => t.deletedAt)
    const negative = related.filter((t) => !t.deletedAt && D(t.amount).lte(0))
    const unlinked = related.filter((t) => !t.deletedAt && D(t.amount).gt(0) && !allocated.has(String(t.id)))
    if (deleted.length) reasons.push(`流水已作废但已收没回退：${deleted.map((t) => `${t.code} ¥${money(t.amount)}`).join('、')}`)
    if (negative.length) reasons.push(`负数回款流水：${negative.map((t) => `${t.code} ¥${money(t.amount)}`).join('、')}`)
    if (unlinked.length) reasons.push(`流水未回填为收款明细：${unlinked.map((t) => t.code).join('、')}`)
    if (!badAmount && total.gt(ar.amount)) reasons.push(`按流水重算后仍超收 ¥${money(total.minus(ar.amount))}（流水 ¥${money(total)} > 应收 ¥${money(ar.amount)}）`)
    else if (!badAmount && D(ar.receivedAmount).gt(ar.amount)) reasons.push(`原已收超过应收 ¥${money(D(ar.receivedAmount).minus(ar.amount))}`)
    if (badAmount) reasons.push('应收金额 ≤ 0（v1.4 起禁止），请改成正确金额或作废')
    else if (diff.eq(0)) reasons.push(`金额一致，但状态应为「${STATUS[newStatus]}」（可能被手工改过）`)
    if (!reasons.length) reasons.push(related.length ? '找不到对应流水的已收（可能被手工改过或直接改库）' : '没有任何回款流水，已收却不为 0')

    rows.push({ ar, total, diff, newStatus, related, reasons })
  }
  rows.sort((a, b) => b.diff.abs().comparedTo(a.diff.abs()))

  const [skipped] = [await prisma.$queryRawUnsafe(`
    SELECT t.code, t.amount, t.direction, r.code AS arCode,
      CASE WHEN t.amount <= 0 THEN '金额≤0' WHEN t.direction <> 'IN' THEN '方向不是 IN'
           WHEN r.id IS NULL THEN '应收不存在' WHEN r.deleted_at IS NOT NULL THEN '应收已作废'
           WHEN r.company_id <> t.company_id THEN '跨公司' ELSE '?' END AS reason
    FROM transactions t LEFT JOIN receivables r ON r.id = t.ref_id
    WHERE t.ref_type = 'RECEIVABLE' AND t.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM receipts x WHERE x.transaction_id = t.id)
    ORDER BY t.id`)]

  const sumDiff = rows.reduce((s, r) => s.plus(r.diff), D(0))
  const L = []
  L.push('# v1.4 历史差异清单：应收「已收金额」与实际回款流水对不上的')
  const delta = sumDiff.gt(0) ? `修正后已收合计减少 ¥${money(sumDiff)}（待收相应增加）` : sumDiff.lt(0) ? `修正后已收合计增加 ¥${money(sumDiff.neg())}` : '已收合计不变'
  L.push(`> 生成 ${nowSH()}（北京时间）｜库 \`${db}\`｜**差异 ${rows.length} 条**，${delta}｜另有超收 ${overpaid.length} 条｜口径：以流水为准（老板已拍板）`)
  L.push('> 本清单只读，脚本没有改任何数据。逐条确认后再执行修正（按收款明细重算已收与状态，每笔写审计日志）。')
  L.push('')
  if (Number(notBackfilled) > 0) {
    L.push(`> ⚠️ 还有 ${Number(notBackfilled)} 笔历史回款流水没回填，请先跑 \`node scripts/backfill-receipts.js\` 再出清单，否则差额偏大。`, '')
  }
  L.push('列说明：**原已收** = 系统里现在显示的已收（`received_amount`）；**按流水重算** = 还有效的回款流水合计；**差额** = 原已收 − 按流水重算（正数 = 系统多记了已收，修正后待收会变多）。', '')
  L.push('## 一、差异明细', '')
  if (!rows.length) L.push('（无差异）', '')
  else {
    L.push('| # | 应收编号 | 公司 | 客户 / 说明 | 应收金额 | 原已收 | 按流水重算 | 差额 | 状态（现 → 应为） | 涉及流水 | 原因 |')
    L.push('|---:|---|---|---|---:|---:|---:|---:|---|---|---|')
    rows.forEach((r, i) => {
      const t = r.related.map((x) => `${x.code}（${day(x.txnDate)} ¥${money(x.amount)}${x.deletedAt ? '，已作废' : ''}）`).join('<br>') || '—'
      const st = r.newStatus === r.ar.status ? STATUS[r.ar.status] : `${STATUS[r.ar.status]} → **${STATUS[r.newStatus]}**`
      L.push(`| ${i + 1} | ${r.ar.code} | ${r.ar.company.code} | ${[r.ar.customer?.name, r.ar.title].filter(Boolean).join(' ')} | ${money(r.ar.amount)} | ${money(r.ar.receivedAmount)} | ${money(r.total)} | **${money(r.diff)}** | ${st} | ${t} | ${r.reasons.join('；')} |`)
    })
    L.push('')
  }
  L.push('## 二、无法回填的历史回款流水（不会被自动处理，需人工判断）', '')
  if (!skipped.length) L.push('（无）', '')
  else {
    L.push('| 流水编号 | 方向 | 金额 | 指向应收 | 原因 |', '|---|---|---:|---|---|')
    for (const s of skipped) L.push(`| ${s.code} | ${s.direction} | ${money(s.amount)} | ${s.arCode || '—'} | ${s.reason} |`)
    L.push('')
  }
  L.push('## 三、超收：已收与流水一致，但超过应收金额（老板已定：超收转预收）', '')
  if (!overpaid.length) L.push('（无）', '')
  else {
    L.push('| 应收编号 | 公司 | 客户 / 说明 | 应收金额 | 已收（=流水） | 超收 | 涉及流水 |', '|---|---|---|---:|---:|---:|---|')
    for (const o of overpaid) {
      L.push(`| ${o.ar.code} | ${o.ar.company.code} | ${[o.ar.customer?.name, o.ar.title].filter(Boolean).join(' ')} | ${money(o.ar.amount)} | ${money(o.total)} | **${money(o.total.minus(o.ar.amount))}** | ${o.txns.map((t) => `${t.code} ¥${money(t.amount)}`).join('<br>')} |`)
    }
    L.push('', '处理：确认后跑 `node scripts/fix-overpaid-to-prepayment.js`（默认只预览）→ `--apply`，超出部分转成预收款（挂原流水），每笔写审计日志。', '')
  }
  const md = L.join('\n')

  if (STDOUT) console.log(md)
  else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, md)
    console.log(`[ar-diff] 库 ${db}：差异 ${rows.length} 条，超收 ${overpaid.length} 条，无法回填流水 ${skipped.length} 笔 → ${OUT}`)
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
