// 录入助手：一句话 → 结构化草稿。模型绝不写库；用户在界面「确认提交」后，由 /drafts/:id/submit 代用户调各模块现有的 REST 接口
// （权限、数据范围、审计、余额重算照旧），并在那里做重复提交去重（见 lib/assistant-submit.js）
import express from 'express'
import dayjs from 'dayjs'
import prisma from '../../lib/prisma.js'
import { requirePermission, scopeWhere, inScope, maskAccountNo, can } from '../../lib/auth.js'
import { ok, badRequest, notFound, wrap } from '../../lib/response.js'
import { logAudit } from '../../lib/audit.js'
import { callSelf } from '../../lib/platform.js'
import { fmtDate } from '../../lib/period.js'
import { buildDraft, fieldLabels, DRAFT_TOOLS, DRAFT_KINDS } from '../../lib/assistant-drafts.js'
import { stubEnabled, stubLLM, callPlatformLLM, platformConfigured, LlmError } from '../../lib/assistant-llm.js'
import { saveDrafts, getDraft, draftView, submitDraft } from '../../lib/assistant-submit.js'

const router = express.Router()

const TIMEOUT_MS = 60_000
const MAX_ROUNDS = 6
const MAX_DRAFTS = 10 // 一次对话最多出几张草稿（每张都要落库）
// 页面只是上下文：告诉模型用户在看什么，不决定能做什么。旧字段 draftRoutes 只为兼容保留，不再是限制
const LEGACY_DRAFT_ROUTES = ['/accounts', '/receivables', '/invoices', '/transactions']
const PAGE_TITLES = {
  '/accounts': '账户管理', '/receivables': '应收与收款', '/invoices': '发票台账', '/transactions': '资金流水',
  '/dashboard': '管理驾驶舱', '/payables': '应付台账', '/payments': '付款管理', '/forecast': '资金预测', '/anomalies': '异常清单',
  '/companies': '公司管理', '/parties': '基础资料', '/loans': '借贷与往来', '/payrolls': '工资管理', '/reimbursements': '报销管理',
  '/close': '月结工作台', '/analytics': '经营分析'
}
const PIN_TYPES = ['company', 'customer', 'supplier', 'project', 'account', 'receivable', 'invoice', 'transaction']
const PIN_LABELS = { company: '公司', customer: '客户', supplier: '供应商', project: '项目', account: '账户', receivable: '应收款', invoice: '发票', transaction: '流水' }
const DRAFT_LABELS = { account: '账户', receivable: '应收款', invoice: '发票', transaction: '资金流水' }
// 哪些读工具的结果能证明「这个 id 是这种记录」（修改目标校验用）
const READ_ID_KIND = { list_accounts: 'account', get_account: 'account', get_receivable: 'receivable', get_invoice: 'invoice' }

// 平台返回 503（没配模型）后记一下，5 分钟内状态接口直接报不可用，免得每次都白跑一趟
let unavailable = null
const UNAVAILABLE_TTL = 5 * 60_000

const draftKindsFor = (user) => DRAFT_KINDS.filter((k) => can(user, `${k}.view`))

function availability() {
  if (stubEnabled()) return { available: true, stub: true }
  if (!platformConfigured()) return { available: false, reason: '未接入以虎 One（缺少 YH_CLIENT_ID / YH_CLIENT_SECRET），没有可用的大模型' }
  if (unavailable && Date.now() - unavailable.at < UNAVAILABLE_TTL) return { available: false, reason: unavailable.reason }
  return { available: true, stub: false }
}

router.get('/status', requirePermission('finance.view'), (req, res) => {
  ok(res, { ...availability(), draftKinds: draftKindsFor(req.user), draftRoutes: LEGACY_DRAFT_ROUTES })
})

// ---------- @ 引用：只认 type + id，服务端按当前用户的数据范围重新查库 ----------
// 返回 { list, rejected }：格式都不对的直接忽略；格式对、但查不到或越权的进 rejected（两者不区分，不暴露记录是否存在）
async function loadPinned(list, user) {
  const out = []
  const rejected = []
  for (const p of (Array.isArray(list) ? list : []).slice(0, 10)) {
    const type = String(p?.type || '')
    const id = String(p?.id ?? '')
    if (!PIN_TYPES.includes(type) || !/^[1-9]\d{0,17}$/.test(id)) continue
    const bid = BigInt(id)
    let summary = null
    let companyId = null
    if (type === 'company') {
      // scopeWhere(user, 'id') 也写 id 字段，必须放进 AND，否则会覆盖 id: bid
      const r = await prisma.company.findFirst({ where: { id: bid, deletedAt: null, AND: [scopeWhere(user, 'id')] } })
      if (r) { summary = `公司 id=${id}：${r.code}（${r.name}）`; companyId = id }
    } else if (type === 'customer') {
      const r = await prisma.customer.findFirst({ where: { id: bid, deletedAt: null } })
      if (r && (!r.companyId || inScope(user, r.companyId))) { summary = `客户 id=${id}：${r.name}${r.companyId ? `，归属公司 id=${r.companyId}` : ''}`; companyId = r.companyId }
    } else if (type === 'supplier') {
      const r = await prisma.supplier.findFirst({ where: { id: bid, deletedAt: null } })
      if (r && (!r.companyId || inScope(user, r.companyId))) { summary = `供应商 id=${id}：${r.name}${r.companyId ? `，归属公司 id=${r.companyId}` : ''}`; companyId = r.companyId }
    } else if (type === 'project') {
      const r = await prisma.project.findFirst({ where: { id: bid, deletedAt: null, ...scopeWhere(user) } })
      if (r) { summary = `项目 id=${id}：${r.name}${r.code ? `（${r.code}）` : ''}，公司 id=${r.companyId}`; companyId = r.companyId }
    } else if (type === 'account') {
      const r = await prisma.account.findFirst({ where: { id: bid, deletedAt: null, ...scopeWhere(user) }, include: { company: { select: { code: true } } } })
      if (r) { summary = `账户 id=${id}：${r.company.code} ${r.name}（${r.type}，${r.currency}，账号 ${maskAccountNo(r.accountNo, user) || '无'}），公司 id=${r.companyId}`; companyId = r.companyId }
    } else if (type === 'receivable') {
      const r = await prisma.receivable.findFirst({ where: { id: bid, deletedAt: null, ...scopeWhere(user) }, include: { customer: { select: { name: true } } } })
      if (r) { summary = `应收款 id=${id}：${r.code} ${r.title}，客户 ${r.customer?.name || '无'}，应收 ${r.amount}，已收 ${r.receivedAmount}，预计 ${fmtDate(r.expectDate) || '未定'}，状态 ${r.status}，公司 id=${r.companyId}`; companyId = r.companyId }
    } else if (type === 'invoice') {
      const r = await prisma.invoice.findFirst({ where: { id: bid, deletedAt: null, ...scopeWhere(user) } })
      if (r) { summary = `发票 id=${id}：${r.invoiceNo}（${r.type}），开票 ${fmtDate(r.issueDate) || '未填'}，价税合计 ${r.totalAmount}，开票方 ${r.sellerName || '—'}，受票方 ${r.buyerName || '—'}，公司 id=${r.companyId}`; companyId = r.companyId }
    } else if (type === 'transaction') {
      const r = await prisma.transaction.findFirst({ where: { id: bid, deletedAt: null, ...scopeWhere(user) } })
      if (r) { summary = `流水 id=${id}：${r.code} ${fmtDate(r.txnDate)} ${r.direction === 'IN' ? '收入' : '支出'} ${r.amount}，对方 ${r.counterparty || '—'}，账户 id=${r.accountId}，公司 id=${r.companyId}`; companyId = r.companyId }
    }
    if (!summary) rejected.push({ type, id })
    else if (!out.some((x) => x.type === type && x.id === id)) out.push({ type, id, summary, companyId: companyId != null ? String(companyId) : null })
  }
  return { list: out, rejected }
}

// 页面筛选的公司是优先级最低的隐式引用：范围外就当没选（筛选不是用户点名的）；和 @ 的记录归属公司不一致时让位给 @
async function loadFilterCompany(id, pinned, user) {
  if (id == null || id === '') return null
  const { list: [hit] } = await loadPinned([{ type: 'company', id }], user)
  if (!hit) return null
  const pinnedCompanies = pinned.map((p) => p.companyId).filter(Boolean)
  return pinnedCompanies.length && !pinnedCompanies.includes(hit.id) ? null : { ...hit, source: 'filter' }
}

// ---------- 工具 ----------
const kw = { keyword: { type: 'string', description: '名称关键字，模糊匹配；不传则列出前 20 条' } }
const byId = (label) => ({ type: 'object', properties: { id: { type: 'string', description: `${label} id` } }, required: ['id'] })

const READ_TOOLS = [
  {
    name: 'list_companies', description: '按名称模糊查公司，返回 id + 简称 + 全称',
    parameters: { type: 'object', properties: kw },
    run: async (t, a) => (await callSelf(t, '/api/fin/companies', { keyword: a.keyword, page_size: 20 })).list.map((c) => ({ id: c.id, code: c.code, name: c.name }))
  },
  {
    name: 'list_customers', description: '按名称模糊查客户，返回 id + 名称',
    parameters: { type: 'object', properties: kw },
    run: async (t, a) => (await callSelf(t, '/api/fin/customers', { keyword: a.keyword, page_size: 20 })).list.map((c) => ({ id: c.id, name: c.name, companyId: c.companyId }))
  },
  {
    name: 'list_projects', description: '按名称模糊查项目，返回 id + 名称',
    parameters: { type: 'object', properties: { ...kw, company_id: { type: 'string', description: '只看某家公司' } } },
    run: async (t, a) => (await callSelf(t, '/api/fin/projects', { keyword: a.keyword, company_id: a.company_id, page_size: 20 })).list.map((p) => ({ id: p.id, name: p.name, code: p.code, companyId: p.companyId }))
  },
  {
    name: 'list_accounts', description: '按名称模糊查资金账户，返回 id + 名称 + 所属公司（不含账号）',
    parameters: { type: 'object', properties: { ...kw, company_id: { type: 'string', description: '只看某家公司' } } },
    run: async (t, a) => (await callSelf(t, '/api/fin/accounts', { keyword: a.keyword, company_id: a.company_id, page_size: 50 })).list.map((x) => ({ id: x.id, name: x.name, type: x.type, currency: x.currency, companyId: x.companyId, company: x.company?.code }))
  },
  {
    name: 'get_receivable', description: '按 id 取应收款详情', parameters: byId('应收款'),
    run: async (t, a, user) => scoped(await callSelf(t, `/api/fin/receivables/${idOf(a)}`), user)
  },
  {
    name: 'get_invoice', description: '按 id 取发票详情', parameters: byId('发票'),
    run: async (t, a, user) => scoped(await callSelf(t, `/api/fin/invoices/${idOf(a)}`), user)
  },
  {
    name: 'get_account', description: '按 id 取账户详情（账号按权限脱敏）', parameters: byId('账户'),
    run: async (t, a, user) => { const r = scoped(await callSelf(t, `/api/fin/accounts/${idOf(a)}`), user); return { ...r, accountNo: maskAccountNo(r.accountNo, user) } }
  }
]

function idOf(a) {
  const id = String(a?.id ?? '')
  if (!/^[1-9]\d{0,17}$/.test(id)) throw new Error('id 必须是正整数')
  return id
}
// 详情接口本身不按公司范围过滤，这里补一道
function scoped(row, user) {
  if (row?.companyId && !inScope(user, row.companyId)) throw new Error('无权访问该记录')
  return row
}

const toOpenAI = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } })

const KNOWN_TOOLS = new Set([...READ_TOOLS.map((t) => t.name), ...DRAFT_KINDS.map((k) => `draft_${k}`)])

function toolsFor(kinds) {
  const list = READ_TOOLS.map((t) => toOpenAI(t.name, t.description, t.parameters))
  for (const k of kinds) list.push(toOpenAI(`draft_${k}`, DRAFT_TOOLS[k].description, { type: 'object', properties: DRAFT_TOOLS[k].properties }))
  return list
}

function pageLine(route) {
  const known = PAGE_TITLES[route]
  // route 是前端传的，未登记的不原样进提示词
  if (!known) return '用户当前在系统的其他页面。'
  return `用户当前在「${known}」页面（${route}），可能正在看这个页面上的某一条记录。`
}

function systemPrompt({ route, kinds, pinned, filterCompany }) {
  const lines = [
    '你是「集团财务系统」的录入助手。你只能读数据和生成草稿，不能直接写库、不能付款、不能审批；草稿由用户在界面上核对后自己提交。',
    `今天是 ${dayjs().format('YYYY-MM-DD')}（东八区）。${pageLine(route)}`,
    `你能生成这几类草稿：${kinds.map((k) => DRAFT_LABELS[k]).join('、')}。做什么由用户的话决定，页面只说明用户在看什么：` +
      '例如在账户页面说「记一笔收款」，那是资金流水草稿，按用户说的做。',
    '',
    '规则：',
    '1. 金额一律用字符串给出，单位元，最多两位小数（如 "128000.00"），不要带千分位和货币符号；「5 万」即 "50000.00"；应收、流水金额必须大于 0。',
    '2. 日期一律 YYYY-MM-DD。「月底」指当月最后一天，「下月底」指下个月最后一天，以今天为基准换算。',
    '3. 公司、客户、项目、账户要用 id。不知道 id 时先调 list_* 查；查到多个就让用户选，不要自己猜。',
    '4. 确定公司、客户、账户等信息时按这个优先级：用户明确说的 > 用户 @ 引用的 > 当前页面的筛选条件 > 都不确定就问。不要拿页面去猜。',
    '5. 用户没说的必填信息（如金额、所属公司、款项说明）不要编造：不传该字段，草稿工具会返回 missing，你据此向用户反问。',
    '6. 一句话说了几件事，就一次调用多个草稿工具，每件事一张草稿；同一类型的多笔（如「两笔收款，1000 和 2000」）也要分开调用。多张草稿都传 draft_no（1、2、3…）。',
    '7. 用户说某笔发票或应收的钱收到了，是回款：调 draft_transaction，direction=IN，把 invoice_id 或 receivable_id 传上，这样提交时才会冲减应收。不要只记一笔普通流水。',
    '8. 草稿工具的 id 参数只用于修改同一类型的已有记录。记一笔新流水时，@ 的账户 id 要传给 account_id，不能传给 id。',
    '9. 草稿工具返回 missing 或 warnings 时，用一两句话告诉用户还缺什么、哪里不对；草稿齐全时简短说明「已填好，请核对」。',
    '10. 回答简短，用中文，不要复述整张表单。'
  ]
  if (pinned.length) {
    lines.push('', '用户 @ 引用的记录（已由服务端按 id 重新查库，可信）：')
    for (const p of pinned) lines.push(`- ${p.summary}`)
    lines.push('用户说「这个/这笔/他」时通常指这些记录；也可能让你用它们做别的类型的事。要修改某条记录时才把它的 id 传给同类型草稿工具的 id 参数。')
  }
  if (filterCompany) lines.push('', `当前页面的筛选条件（用户没说公司、也没有 @ 时作为默认）：${filterCompany.summary}`)
  return lines.join('\n')
}

// 只保留 user / assistant 的纯文本，截断长度；前端传来的 system / tool 一律丢弃
function sanitizeMessages(list) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
}

router.post('/chat', requirePermission('finance.view'), wrap(async (req, res) => {
  const { messages: raw, context = {} } = req.body || {}
  const messages = sanitizeMessages(raw)
  if (!messages.length || messages[messages.length - 1].role !== 'user') return badRequest(res, '请输入要说的话')

  const route = typeof context.route === 'string' ? context.route.slice(0, 100) : ''
  const { list: pinned, rejected: rejectedPins } = await loadPinned(context.pinned, req.user)
  // 页面筛选里选了公司的，当作一条隐式的公司引用（同样按 id 重新查库、校验数据范围）
  const filterCompany = rejectedPins.length ? null : await loadFilterCompany(context.filters?.company_id, pinned, req.user)
  const refs = filterCompany ? [...pinned, filterCompany] : pinned
  const kinds = draftKindsFor(req.user)
  const avail = availability()
  const stub = stubEnabled()

  const drafts = []
  const warnings = []
  const toolNames = []
  let rejectedTools = 0
  let reply = ''

  const audit = (extra = {}) => logAudit(req, {
    action: 'assistant.chat', entity: 'assistant',
    summary: `录入助手｜页面 ${route || '-'}｜${drafts.length ? `草稿 ${drafts.map((d) => d.kind).join('、')}` : '无草稿'}${refs.length ? `｜引用 ${refs.map((p) => `${p.type}:${p.id}`).join('、')}` : ''}`,
    // 只记元信息：不记对话原文、不记草稿里的金额
    after: { route, drafted: drafts.length > 0, kinds: drafts.map((d) => d.kind), pinned: refs.map((p) => `${p.type}:${p.id}`), tools: toolNames, ...(rejectedTools ? { rejectedTools } : {}), stub, ...extra }
  })

  // @ 的记录查不到或越权：直接拒绝。不能丢掉引用继续——「这个账户」会落到别的引用上，或者生成一张缺引用的草稿
  if (rejectedPins.length) {
    await audit({ rejectedPins: rejectedPins.length })
    return notFound(res, `引用的记录不存在或无权访问：${rejectedPins.map((p) => `${PIN_LABELS[p.type]} #${p.id}`).join('、')}，请移除这条引用后重试`)
  }

  if (!avail.available) {
    await audit({ unavailable: true })
    return ok(res, { available: false, reason: avail.reason, reply: '', drafts: [], warnings: [] })
  }

  const token = req.headers.authorization.slice(7)
  const tools = toolsFor(kinds)
  const convo = [{ role: 'system', content: systemPrompt({ route, kinds, pinned, filterCompany }) }, ...messages]
  const ctx = { pinned: refs }
  const deadline = Date.now() + TIMEOUT_MS

  // 草稿的出处：第几轮、模型给的编号。同一轮并行调用的是几件不同的事，只有后面的轮次才可能是在补全前面的草稿
  const draftMeta = new Map()
  const seenIds = { account: new Set(), receivable: new Set(), invoice: new Set() }
  const userText = messages.map((m) => m.content).join('\n')

  // 修改目标必须来自 @、对话原文或读工具：模型把 @ 的账户 id 填进流水草稿的 id 时，同一个数字可能正好是另一条流水，会改到不相干的记录
  function editTargetKnown(kind, id) {
    const s = String(id)
    return pinned.some((p) => p.type === kind && p.id === s) || seenIds[kind]?.has(s) ||
      new RegExp(`(?<!\\d)${s}(?!\\d)`).test(userText)
  }

  // 同一张草稿只留最后一版。update 按修改目标认；create 没有 id，按 draft_no 认，
  // 模型没给编号时，后面轮次的草稿若和之前某张不矛盾（已填字段都一致），视为补全
  function findSameDraft(d, no, round) {
    if (d.mode === 'update') return drafts.findIndex((x) => x.kind === d.kind && x.mode === 'update' && x.id === d.id)
    const peers = drafts.map((x, i) => ({ x, i, meta: draftMeta.get(x) })).filter((p) => p.x.kind === d.kind && p.x.mode === 'create')
    if (no != null) return peers.find((p) => p.meta.no === no)?.i ?? -1
    return peers.find(({ x, meta }) => meta.no == null && meta.round < round &&
      Object.entries(x.payload).every(([k, v]) => d.payload[k] === undefined || d.payload[k] === v))?.i ?? -1
  }

  async function runTool(name, args, round) {
    // 审计只记白名单内的工具名：模型给的名字是任意字符串，不能原样进审计，只记个数
    if (KNOWN_TOOLS.has(name)) toolNames.push(name)
    else rejectedTools++
    if (name.startsWith('draft_')) {
      const kind = name.slice(6)
      if (!kinds.includes(kind)) return { error: `没有生成${DRAFT_LABELS[kind] || ''}草稿的权限` }
      const staleId = args?.id != null && args.id !== '' && !editTargetKnown(kind, args.id) ? args.id : null
      const d = await buildDraft(kind, staleId ? { ...args, id: undefined } : args, req.user)
      if (staleId) d.warnings.push(`修改目标 #${String(staleId).slice(0, 20)} 不是用户说的或 @ 的${DRAFT_LABELS[kind]}，已按新增处理`)
      const no = Number.isInteger(args?.draft_no) ? args.draft_no : null
      const i = findSameDraft(d, no, round)
      if (i < 0 && drafts.length >= MAX_DRAFTS) return { error: `一次最多生成 ${MAX_DRAFTS} 张草稿，其余请分开说` }
      if (i >= 0) drafts.splice(i, 1)
      drafts.push(d)
      draftMeta.set(d, { no, round })
      const labels = fieldLabels(kind)
      return { draft: true, ok: !d.missing.length, mode: d.mode, payload: d.payload, missing: d.missing, missingLabels: d.missing.map((k) => labels[k] || k), warnings: d.warnings, candidates: d.candidates }
    }
    const tool = READ_TOOLS.find((t) => t.name === name)
    if (!tool) return { error: `没有工具 ${name}` }
    try {
      const out = await tool.run(token, args || {}, req.user)
      const seen = seenIds[READ_ID_KIND[name]]
      if (seen) for (const r of Array.isArray(out) ? out : [out]) if (r?.id != null) seen.add(String(r.id))
      return out
    } catch (e) {
      return { error: e.message }
    }
  }

  let upstreamError = null
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new LlmError('请求大模型超时（60 秒）', 0)
      const msg = stub ? stubLLM({ messages: convo, ctx }) : await callPlatformLLM({ messages: convo, tools, timeoutMs: remaining })
      convo.push(msg)
      if (!msg.tool_calls?.length) { reply = msg.content || ''; break }
      for (const tc of msg.tool_calls) {
        let args = {}
        try { args = JSON.parse(tc.function?.arguments || '{}') } catch { args = {} }
        const out = await runTool(String(tc.function?.name || ''), args, round)
        convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 12000) })
      }
      if (round === MAX_ROUNDS - 1) reply = '（工具调用轮数过多，先停在这里，请看草稿或换个说法）'
    }
  } catch (e) {
    if (e instanceof LlmError && e.status === 503) {
      unavailable = { at: Date.now(), reason: '平台还没有配置大模型（HTTP 503），录入助手暂不可用' }
      await audit({ unavailable: true })
      return ok(res, { available: false, reason: unavailable.reason, reply: '', drafts: [], warnings: [] })
    }
    upstreamError = String(e.message || e).slice(0, 300)
    warnings.push(upstreamError)
    reply = reply || '助手这次没能完成，已把错误放在下方提示里；已生成的草稿仍可使用。'
    if (!(e instanceof LlmError)) console.error('[assistant.chat]', e)
  }
  if (!upstreamError) unavailable = null

  // 草稿落库拿 draftId：提交状态持久化、重复提交去重都按它来
  await saveDrafts(drafts, req.user)
  await audit(upstreamError ? { error: true } : {})
  return ok(res, { available: true, stub, reply, drafts, warnings })
}))

// ---------- 草稿：查状态 / 确认提交 ----------
// 抽屉重开时按 id 批量拉回提交状态：GET /drafts?ids=1,2,3（只返回自己的草稿）
router.get('/drafts', requirePermission('finance.view'), wrap(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter((x) => /^[1-9]\d{0,17}$/.test(x)).slice(0, 100)
  if (!ids.length) return ok(res, { list: [] })
  const rows = await prisma.assistantDraft.findMany({ where: { id: { in: ids.map(BigInt) }, userId: BigInt(req.user.id) } })
  return ok(res, { list: rows.map(draftView) })
}))

router.get('/drafts/:id', requirePermission('finance.view'), wrap(async (req, res) => {
  const d = await getDraft(req.params.id, req.user)
  if (!d) return notFound(res, '草稿不存在或已过期')
  return ok(res, draftView(d))
}))

// body: { payload? } —— 用户在草稿卡上改过（选了候选）就带上；不带用落库时的 payload。类型 / 修改目标只认落库的
router.post('/drafts/:id/submit', requirePermission('finance.view'), wrap(async (req, res) => {
  const r = await submitDraft({ id: req.params.id, user: req.user, token: req.headers.authorization.slice(7), payload: req.body?.payload })
  if (r.json) return res.status(r.status || 200).json(r.json)
  const d = r.data
  await logAudit(req, {
    action: 'assistant.submit', entity: 'assistant', entityId: d.draftId,
    summary: `录入助手提交｜${d.kind}${d.mode === 'update' ? ` 修改 #${d.targetId}` : ''}｜${d.code || d.id || '-'}${d.duplicate ? '｜重复提交，返回第一次结果' : ''}`,
    after: { draftId: d.draftId, kind: d.kind, mode: d.mode, resultId: d.id, duplicate: d.duplicate, originalDraftId: d.originalDraftId }
  })
  return ok(res, d)
}))

export default router
