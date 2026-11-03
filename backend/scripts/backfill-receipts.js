// v1.4 历史回填：把 v1.4 之前「登记回款」生成的流水（transactions.ref_type='RECEIVABLE'）补成收款明细 receipts（source=BACKFILL）
//
// 用法（在 backend/ 下）：
//   node scripts/backfill-receipts.js --dry-run   只统计，不写库
//   node scripts/backfill-receipts.js             回填
// 连接哪个库看 DATABASE_URL；本地 dev 库：set -a; source .env.local; set +a
//
// 幂等：同一 (流水, 应收) 只要 receipts 里有过任何一行（包括已撤销的），就不再插——跑两遍第二遍插入 0 行；
//       已撤销的回填行也不会被「复活」。
// 只补 receipts，**不改** receivables.received_amount / status：两边对不上的交给 ar-diff-report.js 出清单，老板确认后再处理。
import prisma from '../src/lib/prisma.js'

const DRY = process.argv.includes('--dry-run')

const ELIGIBLE = `
  FROM transactions t
  JOIN receivables r ON r.id = t.ref_id AND r.deleted_at IS NULL AND r.company_id = t.company_id
  WHERE t.ref_type = 'RECEIVABLE' AND t.deleted_at IS NULL AND t.direction = 'IN' AND t.amount > 0
    AND NOT EXISTS (SELECT 1 FROM receipts x WHERE x.transaction_id = t.id AND x.receivable_id = t.ref_id)`

async function main() {
  const db = (await prisma.$queryRawUnsafe('SELECT DATABASE() AS db'))[0].db
  const [{ n: pending }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n ${ELIGIBLE}`)
  console.log(`[backfill] 库 ${db}，待回填 ${Number(pending)} 笔${DRY ? '（--dry-run，不写库）' : ''}`)

  let inserted = 0
  if (!DRY) {
    inserted = await prisma.$executeRawUnsafe(`
      INSERT INTO receipts (company_id, receivable_id, transaction_id, amount, receipt_date, source,
                            txn_status_before, active_flag, remark, created_by, created_at, updated_at)
      SELECT t.company_id, t.ref_id, t.id, t.amount, t.txn_date, 'BACKFILL',
             NULL, 1, CONCAT('v1.4 回填自流水 ', t.code), 'system:v1.4-backfill', NOW(3), NOW(3)
      ${ELIGIBLE}`)
    console.log(`[backfill] 插入 receipts ${inserted} 行`)
  }

  // 回填不了的历史回款流水：逐条人工看（不会被自动处理）
  const skipped = await prisma.$queryRawUnsafe(`
    SELECT t.id, t.code, t.amount, t.direction, t.ref_id AS refId,
      CASE WHEN t.amount <= 0 THEN '金额≤0' WHEN t.direction <> 'IN' THEN '方向不是 IN'
           WHEN r.id IS NULL THEN '应收不存在' WHEN r.deleted_at IS NOT NULL THEN '应收已作废'
           WHEN r.company_id <> t.company_id THEN '跨公司' ELSE '?' END AS reason
    FROM transactions t LEFT JOIN receivables r ON r.id = t.ref_id
    WHERE t.ref_type = 'RECEIVABLE' AND t.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM receipts x WHERE x.transaction_id = t.id)
    ORDER BY t.id`)
  if (skipped.length) {
    console.log(`[backfill] 无法回填 ${skipped.length} 笔（见差异清单「无法回填的流水」）：`)
    for (const s of skipped) console.log(`  ${s.code}  ${s.direction} ${s.amount}  ref ${s.refId}  ${s.reason}`)
  }
  return inserted
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
