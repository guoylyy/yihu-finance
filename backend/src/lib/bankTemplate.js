// 银行代发工资模板：单文件总额 ≤ 5 万拆批（需求 §5.5 / §5.6）
// 版式对齐现有农行模板：标题行 + 表头「编号/收款方账号/收款方户名/金额/备注（附言）」
import { aoaToBuffer } from './excel.js'
import { round2 } from './money.js'

export const FILE_LIMIT = 50000

/**
 * 按单文件限额把工资明细拆成多批
 * 贪心装箱：按原顺序累加，超限就开新批；单人超限自成一批并标记 overLimit
 */
export function splitByLimit(items, limit = FILE_LIMIT) {
  const batches = []
  let cur = []
  let sum = 0
  for (const it of items) {
    const amt = round2(Number(it.amount || 0))
    if (amt <= 0) continue
    if (amt > limit) {
      if (cur.length) { batches.push(cur); cur = []; sum = 0 }
      batches.push([{ ...it, amount: amt, overLimit: true }])
      continue
    }
    if (sum + amt > limit) {
      batches.push(cur)
      cur = []
      sum = 0
    }
    cur.push({ ...it, amount: amt })
    sum = round2(sum + amt)
  }
  if (cur.length) batches.push(cur)
  return batches
}

export function batchSummary(batches) {
  return batches.map((rows, i) => ({
    index: i + 1,
    count: rows.length,
    total: round2(rows.reduce((s, r) => s + Number(r.amount), 0)),
    overLimit: rows.some((r) => r.overLimit),
    missingAccount: rows.filter((r) => !r.bankAccount).map((r) => r.name),
    names: rows.map((r) => r.name)
  }))
}

/** 生成一个批次的银行上传文件 */
export function buildBankFile(rows, { title = '中国农业银行代发工资（农行）上传文件', bookType = 'xls' } = {}) {
  const aoa = [
    [title],
    ['编号', '收款方账号', '收款方户名', '金额', '备注（附言）']
  ]
  rows.forEach((r, i) => {
    aoa.push([i + 1, r.bankAccount || '', r.name, round2(Number(r.amount)), r.remark || ''])
  })
  const cols = [{ wch: 6 }, { wch: 24 }, { wch: 14 }, { wch: 12 }, { wch: 20 }]
  return aoaToBuffer(aoa, '页一【代发工资（农行）文件】', bookType, cols)
}
