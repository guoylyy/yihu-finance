// 录入助手调用的大模型：平台大模型（以虎 One）或 stub（FIN_LLM_STUB=1，本地 / CI 用，不发任何外部请求）
// 两者都返回 OpenAI chat.completions 的 message：{ role: 'assistant', content, tool_calls }
import dayjs from 'dayjs'
import { dec } from './money.js'

export const stubEnabled = () => process.env.FIN_LLM_STUB === '1'

export class LlmError extends Error {
  constructor(message, status) { super(message); this.status = status }
}

/** 平台没配凭证时直接判定不可用，不去请求 */
export function platformConfigured() {
  return !!(process.env.YH_CLIENT_ID && process.env.YH_CLIENT_SECRET)
}

export async function callPlatformLLM({ messages, tools, timeoutMs }) {
  const base = (process.env.YH_API_URL || 'http://localhost:3105').replace(/\/$/, '')
  const basic = Buffer.from(`${process.env.YH_CLIENT_ID}:${process.env.YH_CLIENT_SECRET}`).toString('base64')
  const body = { messages, temperature: 0.2 }
  if (process.env.FIN_LLM_MODEL) body.model = process.env.FIN_LLM_MODEL
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto' }
  let r
  try {
    r = await fetch(`${base}/api/open/llm/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${basic}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(timeoutMs, 1000))
    })
  } catch (e) {
    throw new LlmError(e.name === 'TimeoutError' ? '请求大模型超时（60 秒）' : `连不上平台大模型：${e.message}`, 0)
  }
  const text = await r.text()
  if (!r.ok) {
    let msg = text
    try { const j = JSON.parse(text); msg = j.message || j.error?.message || j.error || text } catch { /* 非 JSON 就用原文 */ }
    throw new LlmError(`平台大模型返回 HTTP ${r.status}：${String(msg).slice(0, 200)}`, r.status)
  }
  let j
  try { j = JSON.parse(text) } catch { throw new LlmError('平台大模型返回的不是 JSON', r.status) }
  // 兼容平台用 { code, data } 再包一层的情况
  const payload = j.choices ? j : j.data
  const msg = payload?.choices?.[0]?.message
  if (!msg) throw new LlmError(`平台大模型返回格式不对：${text.slice(0, 200)}`, r.status)
  return { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined }
}

// ---------------------------------------------------------------------------
// stub：按最后一条用户消息的关键词（不看当前页面）返回确定的工具调用序列；
// 工具执行、草稿校验走的是和真实模型完全相同的路径，所以能端到端测校验逻辑
// ---------------------------------------------------------------------------
let seq = 0
const call = (name, args) => ({ id: `stub_${++seq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })

function pick(text, re) { return text.match(re)?.[1] }

function parseDate(text) {
  const d = pick(text, /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/)
  if (d) return d
  if (/下个?月底/.test(text)) return dayjs().add(1, 'month').endOf('month').format('YYYY-MM-DD')
  if (/月底|月末/.test(text)) return dayjs().endOf('month').format('YYYY-MM-DD')
  if (/今天|今日/.test(text)) return dayjs().format('YYYY-MM-DD')
  if (/昨天/.test(text)) return dayjs().subtract(1, 'day').format('YYYY-MM-DD')
  return undefined
}

const pinnedId = (ctx, type) => ctx.pinned.find((p) => p.type === type)?.id
// 没点名公司时，取 @ 的记录归属的公司（「给这个账户记一笔收款，再开一张发票」）
const pinnedCompany = (ctx) => pinnedId(ctx, 'company') || ctx.pinned.find((p) => p.companyId)?.companyId

// ---------- 意图：只看用户的话，不看当前页面 ----------
const RECEIPT_RE = /回款|(?:钱|款)[^，。；;]{0,4}(?:收到|到账|到了)/
const EDITABLE = ['account', 'receivable', 'invoice', 'transaction']

// 顺序有讲究：「应收款」含「收款」，所以应收在流水前；「给这个账户记一笔收款」是流水，所以裸的「账户」排最后
function detectKind(text) {
  if (RECEIPT_RE.test(text)) return 'receipt'
  if (/开户(?!行)|(?:新增|新开|新建|建|开).{0,4}账户/.test(text)) return 'account'
  if (/应收|欠款/.test(text)) return 'receivable'
  if (/发票|开票/.test(text)) return 'invoice'
  if (/收款|付款|支出|流水|转账|收入|收到|付了|转入|转出/.test(text)) return 'transaction'
  if (/合同/.test(text)) return 'receivable'
  if (/账户/.test(text) && /录|填|登记|新增|建/.test(text)) return 'account'
  return null
}

const CONNECT = '(?:再|然后|接着|另外)[给帮]?(?:开|记|录|建|登|新|补)'
const CLAUSE_SPLIT = new RegExp(`(?<=[，。；;\\n])|(?<=,)(?!\\d)|(?=${CONNECT})`)
const NEW_ACT = new RegExp(`^${CONNECT}|(?:记|录|开|建|新增|登记|补)[^，。；;]{0,6}?(?:[一两二三四五六七八九十\\d]+\\s*[笔张个]|发票|应收|账户|流水)`)
// 「客户 12」「摘要 发票工本费」这种字段子句属于上一件事，里面的词不算新意图
const FIELD_HEAD = /^(?:摘要|对方|备注|款项说明|标题|客户|公司|账户|开户行|开票方|发票号|合同号?|税额|金额|不含税|期初|业务类型|类型|叫)/

/** 按标点和「再 / 然后」切分，返回 [{ kind, text }]：带动作的子句开始一件新事，其余并到当前这件 */
function splitIntents(text) {
  const out = []
  for (const clause of text.split(CLAUSE_SPLIT)) {
    const c = clause.trim()
    if (!c) continue
    const cur = out[out.length - 1]
    const kind = FIELD_HEAD.test(c) ? null : detectKind(c)
    if (!cur) out.push({ kind, text: clause })
    else if (kind && cur.kind && NEW_ACT.test(c)) out.push({ kind, text: clause })
    else { cur.text += clause; cur.kind ||= kind }
  }
  return out.filter((x) => x.kind)
}

// ---------- 金额 ----------
const AMOUNT_RE = /金额\s*(?:改成|改为|调整为|是|为|[:：])?\s*([^\s，。；;、]+(?:\s*万)?)/
const NUM = '\\d[\\d,]*(?:\\.\\d+)?(?:\\s*万)?'
// 先去掉日期和带标签的编号（发票号、客户 id……），剩下的数字才可能是金额
const NOT_MONEY = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|(?:发票号(?:码)?|合同号?|客户|公司|账户|税额|不含税(?:金额)?|期初|余额)\s*[:：]?\s*[0-9A-Za-z-]+|#\s*\d+|\d\s*笔/g
const AMOUNT_AFTER = new RegExp(`(?:收款|付款|支出|收入|转账|转入|转出|付了|收到|应收|欠款|发票|开票|笔)[^\\d\\s，,。；;]{0,2}\\s*(${NUM})(?![\\d月]|\\s*月)`)
const AMOUNT_BEFORE = new RegExp(`(${NUM})\\s*[元块]?\\s*的?\\s*(?:发票|收款|付款|应收|支出|款|流水)`)
const AMOUNT_ALL = new RegExp(`(?<![\\d.])(${NUM})(?![\\d月]|\\s*月)`, 'g')
const COUNT = { 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 2: 2, 3: 3, 4: 4, 5: 5 }

// 「5 万」换成元；其余保留原文交给草稿校验（-5 / abc 这类非法值应被校验挡下来，而不是在这里被「修正」）
function yuan(raw) {
  const m = raw?.match(/^([\d,]+(?:\.\d+)?)\s*万$/)
  return m ? dec(m[1].replace(/,/g, '')).times(10000).toFixed(2) : raw
}

function pickAmount(text) {
  const plain = text.replace(NOT_MONEY, ' ')
  return yuan(pick(text, AMOUNT_RE) || pick(plain, AMOUNT_AFTER) || pick(plain, AMOUNT_BEFORE))
}

/** 「记两笔收款，1000 和 2000」→ 两个金额；「都是 1000」→ 同一金额两次；其余只有一个 */
function amountsOf(text) {
  const n = COUNT[pick(text, /([两二三四五2-5])\s*笔/)]
  if (!n) return [pickAmount(text)]
  const list = [...text.replace(NOT_MONEY, ' ').matchAll(AMOUNT_ALL)].map((m) => yuan(m[1]))
  if (list.length === 1 && /都|各/.test(text)) return Array(n).fill(list[0])
  return list.length ? list.slice(0, n) : [undefined]
}

// 修改已有记录时金额落在哪个字段
const EDIT_AMOUNT_KEY = { account: 'initialBalance', receivable: 'amount', invoice: 'totalAmount', transaction: 'amount' }

// 「把金额改成 2000」：类型看话里说的，没说就看 @ 了哪种记录；要改的记录取「#id」或 @ 引用，只传说到的字段
function stubEdit(text, ctx) {
  const said = detectKind(text)
  const kind = EDITABLE.includes(said) ? said : EDITABLE.find((k) => pinnedId(ctx, k))
  const id = pick(text, /#\s*(\d+)/) || pinnedId(ctx, kind)
  if (!kind || !id) return []
  const amount = yuan(pick(text, AMOUNT_RE))
  return [call(`draft_${kind}`, { id, ...(amount ? { [EDIT_AMOUNT_KEY[kind]]: amount } : {}) })]
}

/** 一件事 → 工具调用。seg 是这件事自己的子句（金额、日期从这里取）；full 是整句（客户、公司、账户这类引用多件事共用） */
function planOne(kind, seg, full, amount, ctx) {
  const date = parseDate(seg)
  const companyId = pick(full, /公司\s*[:：]?\s*(\d+)/)
  const calls = []
  if (kind === 'receivable') {
    const args = { amount, expectDate: date }
    const cid = pick(full, /客户\s*[:：]?\s*(\d+)/) || pinnedId(ctx, 'customer')
    const cname = !cid && pick(full, /客户\s*[:：]?\s*([^\s\d，,。；;][^\s，,。；;]*?)(?=(?:建|录|记|开|登记)一|[\s，,。；;]|$)/)
    if (cid) args.customer_id = cid
    if (cname) { args.customer_name = cname; calls.push(call('list_customers', { keyword: cname })) }
    const contract = pick(seg, /合同(?:号)?\s*[:：]?\s*([A-Za-z0-9-]+)/)
    if (contract) args.contractNo = contract
    // 「款项说明 无」用来模拟用户没说款项说明（测 missing.title）
    const title = pick(seg, /(?:款项说明|标题)\s*[:：]?\s*([^\s，,。；;]+)/)
    if (title !== '无') args.title = title || (contract ? `合同 ${contract} 款项` : '应收款')
    const company = companyId || pinnedCompany(ctx)
    if (company) args.company_id = company
    if (pinnedId(ctx, 'receivable') && /改|修改|更新/.test(seg)) args.id = pinnedId(ctx, 'receivable')
    calls.push(call('draft_receivable', args))
  } else if (kind === 'invoice') {
    const args = {
      invoiceNo: pick(seg, /发票号(?:码)?\s*[:：]?\s*([0-9A-Za-z]+)/),
      type: /销项/.test(seg) ? 'SALES' : /红字/.test(seg) ? 'RED' : /费用/.test(seg) ? 'EXPENSE' : /进项/.test(seg) ? 'PURCHASE' : /开票|开.{0,12}发票/.test(seg) ? 'SALES' : 'PURCHASE',
      issueDate: date, totalAmount: amount,
      taxAmount: pick(seg, /税额\s*(?:是|为|[:：])?\s*([^\s，。；;、]+)/),
      sellerName: pick(seg, /开票方\s*[:：]?\s*([^\s，,。；;]+)/),
      amount: pick(seg, /不含税(?:金额)?\s*(?:是|为|[:：])?\s*([^\s，。；;、]+)/),
      company_id: companyId || pinnedCompany(ctx)
    }
    const cid = pick(full, /客户\s*[:：]?\s*(\d+)/) || pinnedId(ctx, 'customer')
    if (cid) args.customer_id = cid
    calls.push(call('draft_invoice', args))
  } else if (kind === 'transaction' || kind === 'receipt') {
    // 用户点名的账户优先于 @：「给招行基本户记一笔」
    const named = pick(full, /给\s*([^\s，,。；;]*?户)\s*[记录]/)
    const accountName = named && !/^(?:客户|这|该|此|那)/.test(named) ? named : undefined
    const args = {
      direction: /支出|付了|付款|转出/.test(seg) ? 'OUT' : 'IN',
      amount, txnDate: date || dayjs().format('YYYY-MM-DD'),
      account_id: pick(full, /账户\s*[:：]?\s*(\d+)/) || (accountName ? undefined : pinnedId(ctx, 'account')),
      account_name: accountName,
      counterparty: pick(seg, /对方\s*[:：]?\s*([^\s，,。；;]+)/),
      summary: pick(seg, /摘要\s*[:：]?\s*([^，,。；;]+)/),
      bizType: pick(seg, /业务类型\s*[:：]?\s*([A-Z_]+)/),
      company_id: companyId || (accountName ? undefined : pinnedId(ctx, 'company'))
    }
    if (kind === 'receipt') {
      args.invoice_id = pinnedId(ctx, 'invoice')
      args.receivable_id = pinnedId(ctx, 'receivable')
    }
    if (!args.account_id && !accountName) calls.push(call('list_accounts', {}))
    calls.push(call('draft_transaction', args))
  } else if (kind === 'account') {
    calls.push(call('draft_account', {
      name: pick(seg, /(?:账户名称|叫)\s*[:：]?\s*([^\s，,。；;]+)/),
      bankName: pick(seg, /(?:开户行|银行)\s*[:：]?\s*([^\s，,。；;]+)/),
      accountNo: pick(seg, /账号\s*[:：]?\s*([0-9\s-]+\d)/),
      initialBalance: pick(seg, /(?:期初|余额)\s*(?:是|为|[:：])?\s*([^\s，。；;、]+)/) || amount,
      initialDate: date,
      type: pick(seg, /类型\s*[:：]?\s*([A-Z_]+)/) || (/支付宝/.test(seg) ? 'ALIPAY' : /微信/.test(seg) ? 'WECHAT' : /现金/.test(seg) ? 'CASH' : 'BANK'),
      company_id: companyId || pinnedId(ctx, 'company')
    }))
  }
  return calls
}

function stubPlan(text, ctx) {
  if (/改成|改为|调整为/.test(text)) return stubEdit(text, ctx)
  return splitIntents(text).flatMap(({ kind, text: seg }) => amountsOf(seg).flatMap((amount) => planOne(kind, seg, text, amount, ctx)))
}

export function stubLLM({ messages, ctx }) {
  const last = messages[messages.length - 1]
  if (last.role === 'tool') {
    // 工具都执行完了：汇总这一批草稿给一句回复（缺字段就反问）
    const results = []
    for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) {
      try { results.unshift(JSON.parse(messages[i].content)) } catch { /* 忽略 */ }
    }
    const drafts = results.filter((r) => r?.draft)
    if (!drafts.length) return { role: 'assistant', content: '（stub）查到了相关记录，请继续说明要录入什么。' }
    const missing = [...new Set(drafts.flatMap((d) => d.missingLabels || []))]
    const warnings = [...new Set(drafts.flatMap((d) => d.warnings || []))]
    if (missing.length) {
      return { role: 'assistant', content: `（stub）还缺这些信息：${missing.join('、')}，请补充。${warnings.length ? '\n另外：' + warnings.join('；') : ''}` }
    }
    return { role: 'assistant', content: `（stub）已按你说的填好${drafts.length > 1 ? ` ${drafts.length} 张` : ''}草稿，确认一下金额和日期。${warnings.length ? '\n注意：' + warnings.join('；') : ''}` }
  }
  const text = typeof last.content === 'string' ? last.content : ''
  const calls = stubPlan(text, ctx)
  if (!calls.length) {
    return { role: 'assistant', content: '（stub）没识别出要录入的内容。可以说「录一笔应收：客户 12，金额 128000，月底到期」。' }
  }
  return { role: 'assistant', content: '', tool_calls: calls }
}
