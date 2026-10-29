// 录入助手 E2E 的公共部分：参数、HTTP、检查项登记与汇总、测试数据（建 / 清）、行数快照
import assert from 'node:assert/strict'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

export { assert }
export const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const ROOT_DIR = path.resolve(BACKEND_DIR, '..')

export const DRAFT_KINDS = ['account', 'receivable', 'invoice', 'transaction']
// 录入助手允许模型调用的工具（只读 + 草稿）；审计里出现别的名字只能是模型乱叫、被服务端拒掉的
export const ALLOWED_TOOLS = ['list_companies', 'list_customers', 'list_projects', 'list_accounts', 'get_receivable', 'get_invoice', 'get_account',
  ...DRAFT_KINDS.map((k) => `draft_${k}`)]
const MONEY_KEYS = ['amount', 'taxAmount', 'totalAmount', 'initialBalance']
const DATE_KEYS = ['expectDate', 'issueDate', 'txnDate', 'initialDate']

export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string', default: process.env.E2E_BASE_URL || 'http://127.0.0.1:3010' },
      token: { type: 'string', default: process.env.E2E_TOKEN },
      user: { type: 'string', default: process.env.E2E_ADMIN_USER || 'admin' },
      pass: { type: 'string', default: process.env.E2E_ADMIN_PASS || 'admin123' },
      live: { type: 'boolean', default: false },
      'read-only': { type: 'boolean', default: false },
      only: { type: 'string' },
      ui: { type: 'string' },
      chrome: { type: 'string', default: process.env.E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      report: { type: 'string', default: path.join(ROOT_DIR, 'docs/测试报告-录入助手.md') },
      'keep-audit': { type: 'boolean', default: false },
      'skip-slow': { type: 'boolean', default: false },
      'cleanup-stale': { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  })
  return {
    base: values.base.replace(/\/$/, ''),
    token: values.token,
    user: values.user,
    pass: values.pass,
    live: values.live,
    readOnly: values['read-only'],
    only: values.only ? values.only.toUpperCase().split(',').map((s) => s.trim()) : null,
    ui: (values.ui || values.base).replace(/\/$/, ''),
    chrome: values.chrome,
    report: values.report === 'none' ? null : values.report,
    keepAudit: values['keep-audit'],
    skipSlow: values['skip-slow'],
    cleanupStale: values['cleanup-stale'],
    verbose: values.verbose,
    help: values.help
  }
}

// ---------- HTTP ----------
export function makeHttp(base) {
  async function http(method, url, token, body) {
    const t0 = performance.now()
    const r = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000)
    })
    const text = await r.text()
    let json = {}
    try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 300) } }
    return { status: r.status, json, ms: performance.now() - t0 }
  }
  const data = async (method, url, token, body) => {
    const r = await http(method, url, token, body)
    if (r.json.code !== 0) throw new Error(`${method} ${url} → HTTP ${r.status} code ${r.json.code}：${r.json.message || r.json.raw}`)
    return r.json.data
  }
  const login = async (username, password) => {
    const r = await http('POST', '/api/auth/login', null, { username, password })
    if (r.json.code !== 0) throw new Error(`登录 ${username} 失败：${r.json.message || r.json.raw || `HTTP ${r.status}`}`)
    return r.json.data
  }
  const chat = (token, text, context = { route: '/receivables', pinned: [] }) =>
    http('POST', '/api/fin/assistant/chat', token, { messages: [{ role: 'user', content: text }], context })
  return { http, data, login, chat }
}

export const ctx = (route, pinned = [], filters) => ({ route, pinned, ...(filters ? { filters } : {}) })
export const pin = (type, id) => ({ type, id: String(id) })

// ---------- 结构断言（stub / live 都适用，不看措辞） ----------
/** 校验一次 chat 的返回结构，以及草稿里只会出现值域内的数据 */
export function assertChatShape(r) {
  assert.equal(r.status, 200, `HTTP ${r.status}`)
  assert.equal(r.json.code, 0, r.json.message)
  const d = r.json.data
  assert.equal(typeof d.reply, 'string')
  assert.ok(Array.isArray(d.drafts), 'drafts 不是数组')
  assert.ok(Array.isArray(d.warnings), 'warnings 不是数组')
  for (const x of d.drafts) assertDraftShape(x)
  return d
}

export function assertDraftShape(x) {
  assert.ok(DRAFT_KINDS.includes(x.kind), `未知草稿类型 ${x.kind}`)
  assert.ok(['create', 'update'].includes(x.mode), `未知 mode ${x.mode}`)
  if (x.mode === 'update') assert.match(String(x.id), /^[1-9]\d*$/)
  else assert.equal(x.id, null)
  for (const k of ['missing', 'warnings']) assert.ok(Array.isArray(x[k]), `${k} 不是数组`)
  for (const k of MONEY_KEYS) if (x.payload[k] != null) assert.match(x.payload[k], /^-?\d{1,16}\.\d{2}$/, `${k}=${x.payload[k]} 不是两位小数金额`)
  for (const k of DATE_KEYS) if (x.payload[k] != null) assert.match(x.payload[k], /^\d{4}-\d{2}-\d{2}$/, `${k}=${x.payload[k]} 不是 YYYY-MM-DD`)
  for (const k of Object.keys(x.payload)) if (/Id$/.test(k)) assert.match(String(x.payload[k]), /^[1-9]\d*$/, `${k} 不是正整数 id`)
}

/** 草稿里引用到的公司 / 账户 / 客户都必须在 allowed 集合里（越权数据不得出现在草稿中） */
export function assertDraftIdsWithin(drafts, allowed) {
  for (const d of drafts) {
    for (const [k, set] of Object.entries(allowed)) {
      if (d.payload[k] != null) assert.ok(set.has(String(d.payload[k])), `草稿 ${d.kind}.${k}=${d.payload[k]} 不在当前用户可见范围`)
    }
  }
}

// 金额字符串 → 分（BigInt），避免浮点
export function cents(v) {
  const s = String(v)
  const neg = s.startsWith('-')
  const [i, f = ''] = s.replace('-', '').split('.')
  const c = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2))
  return neg ? -c : c
}

export const pct = (arr, p) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}

export const randomPass = () => crypto.randomBytes(12).toString('base64url')

// ---------- 检查项登记 ----------
export function makeRunner(opts, env) {
  const results = []
  const notes = []
  const perf = {}
  let current = ''
  const log = (...a) => { if (opts.verbose) console.log('   ', ...a) }

  /**
   * @param group  A~J / S（冒烟）
   * @param needs  需要的条件：write（写库模式）/ stub / live / db（能直连数据库）/ spawn（能起子进程后端）/ browser
   */
  async function check(group, name, fn, { needs = [] } = {}) {
    if (opts.only && !opts.only.includes(group)) return
    if (group !== current) { current = group; console.log(`\n[${group}] ${env.groupTitle[group] || ''}`) }
    const unmet = needs.filter((n) => !env.has(n))
    if (unmet.length) {
      results.push({ group, name, status: 'SKIP', detail: `需要 ${unmet.join(' / ')}` })
      console.log(`  - ${name}（跳过：需要 ${unmet.join(' / ')}）`)
      return
    }
    const t0 = performance.now()
    try {
      const detail = await fn()
      results.push({ group, name, status: 'PASS', detail: typeof detail === 'string' ? detail : '', ms: performance.now() - t0 })
      console.log(`  ✔ ${name}${typeof detail === 'string' && detail ? `  — ${detail}` : ''}`)
    } catch (e) {
      results.push({ group, name, status: 'FAIL', detail: e.message.split('\n')[0].slice(0, 300), ms: performance.now() - t0 })
      console.log(`  ✘ ${name}\n      ${e.message.split('\n').slice(0, 6).join('\n      ')}`)
    }
  }
  return { check, results, notes, perf, log }
}

// ---------- 数据库直连（仅写库模式：建数前后行数快照、硬删除测试数据） ----------
// 按外键依赖排好的删除顺序：先删引用别人的
const PURGE_ORDER = ['transaction', 'importBatch', 'attachment', 'invoice', 'receivable', 'payable', 'payment', 'payroll', 'reimbursement',
  'loan', 'forecastItem', 'closePeriod', 'project', 'customer', 'supplier', 'person', 'account']
export const COUNT_TABLES = ['user', 'auditLog', 'company', 'account', 'person', 'customer', 'supplier', 'project', 'category', 'transaction',
  'importBatch', 'receivable', 'payable', 'payment', 'payroll', 'payrollItem', 'reimbursement', 'invoice', 'loan', 'loanRepayment',
  'attachment', 'closePeriod', 'forecastItem']

export async function openDb() {
  const dotenv = await import('dotenv')
  dotenv.config({ path: path.join(BACKEND_DIR, '.env'), quiet: true })
  if (!process.env.DATABASE_URL) return { db: null, reason: '没有 DATABASE_URL（backend/.env 或环境变量）' }
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient({ log: ['error'] })
  try {
    await db.$queryRawUnsafe('SELECT 1')
    return { db, url: process.env.DATABASE_URL }
  } catch (e) {
    await db.$disconnect().catch(() => {})
    return { db: null, reason: `连不上数据库：${e.message.split('\n').filter(Boolean).pop()}` }
  }
}

export async function countRows(db) {
  const out = {}
  for (const t of COUNT_TABLES) out[t] = await db[t].count()
  return out
}

/** 测试数据是否还有残留（按 id 与前缀两种口径都查） */
export async function residual(db, { companyIds, userIds, prefix }) {
  const cids = companyIds.map(BigInt)
  const uids = userIds.map(BigInt)
  const out = {}
  for (const m of PURGE_ORDER) out[m] = await db[m].count({ where: { companyId: { in: cids } } })
  out.customerByName = await db.customer.count({ where: { name: { startsWith: prefix } } })
  out.company = await db.company.count({ where: { OR: [{ id: { in: cids } }, { code: { startsWith: prefix } }] } })
  out.user = await db.user.count({ where: { OR: [{ id: { in: uids } }, { username: { startsWith: prefix.toLowerCase() } }] } })
  out.auditLog = await db.auditLog.count({ where: auditWhere(companyIds, userIds) })
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v > 0))
}

// 测试产生的审计行：测试用户自己的操作 + 引导管理员建 / 删测试公司与测试用户的那几行
function auditWhere(companyIds, userIds) {
  const uids = userIds.map(String)
  return {
    OR: [
      { userId: { in: userIds.map(BigInt) } },
      { entity: 'user', entityId: { in: uids } },
      { entity: 'company', entityId: { in: companyIds.map(String) } }
    ]
  }
}

/** 硬删除：只按测试自己建的公司 id / 用户 id 删，绝不按时间段或模糊条件删别的数据 */
export async function purge(db, { companyIds, userIds, keepAudit }) {
  const cids = companyIds.map(BigInt)
  const removed = {}
  if (cids.length) {
    for (const m of PURGE_ORDER) {
      const r = await db[m].deleteMany({ where: { companyId: { in: cids } } })
      if (r.count) removed[m] = r.count
    }
    const r = await db.company.deleteMany({ where: { id: { in: cids } } })
    if (r.count) removed.company = r.count
  }
  if (!keepAudit && (userIds.length || cids.length)) {
    const r = await db.auditLog.deleteMany({ where: auditWhere(companyIds, userIds) })
    if (r.count) removed.auditLog = r.count
  }
  if (userIds.length) {
    const r = await db.user.deleteMany({ where: { id: { in: userIds.map(BigInt) } } })
    if (r.count) removed.user = r.count
  }
  return removed
}

/** 上次跑崩了留下的测试数据：公司简称 / 用户名形如 E2E-xxxxxx-… 的 */
export async function findStale(db) {
  const re = /^E2E-[0-9a-z]{6,}-/i
  const companies = (await db.company.findMany({ where: { code: { startsWith: 'E2E-' } }, select: { id: true, code: true } })).filter((c) => re.test(c.code))
  const users = (await db.user.findMany({ where: { username: { startsWith: 'e2e-' } }, select: { id: true, username: true } })).filter((u) => re.test(u.username))
  return { companyIds: companies.map((c) => String(c.id)), userIds: users.map((u) => String(u.id)), companies, users }
}
