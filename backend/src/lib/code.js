// 业务编号生成：PREFIX-YYYYMM-0001（按前缀取当前最大序号 +1）
import prisma from './prisma.js'

const MODEL_BY_PREFIX = {
  TXN: 'transaction',
  AR: 'receivable',
  AP: 'payable',
  PAY: 'payment',
  PR: 'payroll',
  EXP: 'reimbursement',
  LN: 'loan'
}

export async function nextCode(prefix, { monthly = true, date = new Date(), width = 4 } = {}) {
  const model = MODEL_BY_PREFIX[prefix]
  if (!model) throw new Error(`未知的编号前缀：${prefix}`)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const head = monthly ? `${prefix}-${y}${m}-` : `${prefix}-${y}-`
  const last = await prisma[model].findFirst({
    where: { code: { startsWith: head } },
    orderBy: { code: 'desc' },
    select: { code: true }
  })
  const seq = last ? Number(last.code.slice(head.length)) + 1 : 1
  return head + String(seq).padStart(width, '0')
}
