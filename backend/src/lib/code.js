// 业务编号生成：PREFIX-YYYYMM-0001 / PREFIX-YYYY-0001
// 序号由 code_sequences 表发放：INSERT … ON DUPLICATE KEY UPDATE 在事务里拿行锁，并发请求排队取号，不会撞号。
// 旧做法「查当前最大号 +1」在并发下会两个请求拿到同一个号，第二个 create 撞 P2002（transactions_code_key）。
import prisma from './prisma.js'

const MODEL_BY_PREFIX = {
  TXN: 'transaction',
  AR: 'receivable',
  AP: 'payable',
  PAY: 'payment',
  PR: 'payroll',
  EXP: 'reimbursement',
  LN: 'loan',
  PRE: 'prepayment'
}

const MAX_RETRY = 3

// 编号里的年月一律按北京时间（Asia/Shanghai）算，不跟服务器时区走。
// 以前用 getFullYear()/getMonth()（本地时区）：业务日期是 UTC 零点（toDate），
// 在 UTC-8 的机器上 2026-11-01 会编成 TXN-202610-xxxx；容器若是 UTC，11-01 08:00 前新建的应收也会差一年/一月。
const SHANGHAI_YM = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' })

export function shanghaiYearMonth(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const parts = Object.fromEntries(SHANGHAI_YM.formatToParts(d).map((p) => [p.type, p.value]))
  return { y: parts.year, m: parts.month }
}

function headOf(prefix, { monthly = true, date = new Date() } = {}) {
  if (!MODEL_BY_PREFIX[prefix]) throw new Error(`未知的编号前缀：${prefix}`)
  const { y, m } = shanghaiYearMonth(date)
  return monthly ? `${prefix}-${y}${m}-` : `${prefix}-${y}-`
}

// 业务表里这个前缀已用到的最大序号。序列表是后加的、或有人绕过序列写过编号时，用它把序列抬上来
async function usedMax(prefix, head) {
  const last = await prisma[MODEL_BY_PREFIX[prefix]].findFirst({
    where: { code: { startsWith: head } },
    orderBy: { code: 'desc' },
    select: { code: true }
  })
  const n = last ? Number(last.code.slice(head.length)) : 0
  return Number.isFinite(n) ? n : 0
}

/** 一次取 count 个连续编号（转账一次要两个） */
export async function nextCodes(prefix, { monthly = true, date = new Date(), width = 4, count = 1 } = {}) {
  const head = headOf(prefix, { monthly, date })
  const seed = await usedMax(prefix, head)
  const last = await prisma.$transaction(async (tx) => {
    // 行锁持有到事务提交：同一前缀的并发取号在这里串行
    await tx.$executeRaw`
      INSERT INTO code_sequences (seq_key, seq_value, updated_at) VALUES (${head}, ${seed + count}, NOW(3))
      ON DUPLICATE KEY UPDATE seq_value = GREATEST(seq_value, ${seed}) + ${count}, updated_at = NOW(3)`
    const [row] = await tx.$queryRaw`SELECT seq_value AS v FROM code_sequences WHERE seq_key = ${head}`
    return Number(row.v)
  })
  return Array.from({ length: count }, (_, i) => head + String(last - count + 1 + i).padStart(width, '0'))
}

export async function nextCode(prefix, opts = {}) {
  return (await nextCodes(prefix, { ...opts, count: 1 }))[0]
}

export function isCodeConflict(e) {
  if (e?.code !== 'P2002') return false
  const target = e.meta?.target
  return (Array.isArray(target) ? target.join(',') : String(target || '')).includes('code')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 取号 + 写入；万一仍撞号（例如有旧进程按老办法在写）自动重新取号重试，最多 3 次，指数退避
 * @param run (codes: string[]) => Promise<any>
 */
export async function withCodes(prefix, opts, run) {
  for (let attempt = 0; ; attempt++) {
    const codes = await nextCodes(prefix, opts)
    try {
      return await run(codes)
    } catch (e) {
      if (!isCodeConflict(e)) throw e
      if (attempt >= MAX_RETRY) {
        console.error(`[code] ${prefix} 连续 ${attempt + 1} 次撞号`, e.message)
        throw new Error('业务编号分配冲突，请稍后重试')
      }
      await sleep(30 * 2 ** attempt + Math.floor(Math.random() * 20))
    }
  }
}

/** 最常见的用法：prisma[model].create(args)，data.code 自动填 */
export function createWithCode(model, prefix, opts, args) {
  return withCodes(prefix, opts, ([code]) => prisma[model].create({ ...args, data: { ...args.data, code } }))
}
