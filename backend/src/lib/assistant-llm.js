// 录入助手调用的大模型：平台大模型（以虎 One）或 stub（FIN_LLM_STUB=1，本地 / CI 用，不发任何外部请求）
// 两者都返回 OpenAI chat.completions 的 message：{ role: 'assistant', content, tool_calls }
import dayjs from 'dayjs'

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
// stub：按最后一条用户消息的关键词，返回预置的工具调用序列；
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

function detectKind(text, ctx) {
  if (/应收/.test(text)) return 'receivable'
  if (/发票/.test(text)) return 'invoice'
  if (/开户|新增账户|建.{0,4}账户/.test(text)) return 'account'
  if (/流水|收入|支出|收到|付了|转入|转出/.test(text)) return 'transaction'
  if (/录|填|登记|新增|建/.test(text)) return ctx.pageKind
  return null
}

function stubPlan(text, ctx) {
  const kind = ctx.draftsAllowed ? detectKind(text, ctx) : null
  if (!kind) return []
  // 金额：保留原文交给草稿校验（-5 / abc 这类非法值应被校验挡下来，而不是在这里被「修正」）
  const amount = pick(text, /金额\s*(?:是|为|[:：])?\s*([^\s，。；;、]+)/)
  const date = parseDate(text)
  const calls = []
  if (kind === 'receivable') {
    const args = { amount, expectDate: date }
    const cid = pick(text, /客户\s*[:：]?\s*(\d+)/) || pinnedId(ctx, 'customer')
    const cname = !cid && pick(text, /客户\s*[:：]?\s*([^\s\d，,。；;][^\s，,。；;]*)/)
    if (cid) args.customer_id = cid
    if (cname) { args.customer_name = cname; calls.push(call('list_customers', { keyword: cname })) }
    const contract = pick(text, /合同(?:号)?\s*[:：]?\s*([A-Za-z0-9-]+)/)
    if (contract) args.contractNo = contract
    args.title = contract ? `合同 ${contract} 款项` : '应收款'
    if (pinnedId(ctx, 'company')) args.company_id = pinnedId(ctx, 'company')
    if (pinnedId(ctx, 'receivable') && /改|修改|更新/.test(text)) args.id = pinnedId(ctx, 'receivable')
    calls.push(call('draft_receivable', args))
  } else if (kind === 'invoice') {
    const args = {
      invoiceNo: pick(text, /发票号(?:码)?\s*[:：]?\s*([0-9A-Za-z]+)/),
      type: /销项/.test(text) ? 'SALES' : /红字/.test(text) ? 'RED' : /费用/.test(text) ? 'EXPENSE' : 'PURCHASE',
      issueDate: date, totalAmount: amount,
      taxAmount: pick(text, /税额\s*(?:是|为|[:：])?\s*([^\s，。；;、]+)/),
      sellerName: pick(text, /开票方\s*[:：]?\s*([^\s，,。；;]+)/),
      company_id: pinnedId(ctx, 'company')
    }
    const cid = pick(text, /客户\s*[:：]?\s*(\d+)/) || pinnedId(ctx, 'customer')
    if (cid) args.customer_id = cid
    calls.push(call('draft_invoice', args))
  } else if (kind === 'transaction') {
    const args = {
      direction: /支出|付了|付款|转出/.test(text) ? 'OUT' : 'IN',
      amount, txnDate: date || dayjs().format('YYYY-MM-DD'),
      account_id: pick(text, /账户\s*[:：]?\s*(\d+)/) || pinnedId(ctx, 'account'),
      counterparty: pick(text, /对方\s*[:：]?\s*([^\s，,。；;]+)/),
      summary: pick(text, /摘要\s*[:：]?\s*([^，,。；;]+)/),
      company_id: pinnedId(ctx, 'company')
    }
    if (!args.account_id) calls.push(call('list_accounts', {}))
    calls.push(call('draft_transaction', args))
  } else if (kind === 'account') {
    calls.push(call('draft_account', {
      name: pick(text, /(?:账户名称?|叫)\s*[:：]?\s*([^\s，,。；;]+)/),
      bankName: pick(text, /(?:开户行|银行)\s*[:：]?\s*([^\s，,。；;]+)/),
      accountNo: pick(text, /账号\s*[:：]?\s*([0-9\s-]+\d)/),
      initialBalance: pick(text, /(?:期初|余额)\s*(?:是|为|[:：])?\s*([^\s，。；;、]+)/) || amount,
      initialDate: date,
      type: /支付宝/.test(text) ? 'ALIPAY' : /微信/.test(text) ? 'WECHAT' : /现金/.test(text) ? 'CASH' : 'BANK',
      company_id: pinnedId(ctx, 'company')
    }))
  }
  return calls
}

export function stubLLM({ messages, ctx }) {
  const last = messages[messages.length - 1]
  if (last.role === 'tool') {
    // 工具都执行完了：根据最后一份草稿的结果给一句回复（缺字段就反问）
    const results = []
    for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) {
      try { results.unshift(JSON.parse(messages[i].content)) } catch { /* 忽略 */ }
    }
    const draft = results.reverse().find((r) => r?.draft)
    if (!draft) return { role: 'assistant', content: '（stub）查到了相关记录，请继续说明要录入什么。' }
    if (draft.missing?.length) {
      return { role: 'assistant', content: `（stub）还缺这些信息：${draft.missingLabels.join('、')}，请补充。${draft.warnings?.length ? '\n另外：' + draft.warnings.join('；') : ''}` }
    }
    return { role: 'assistant', content: `（stub）已按你说的填好草稿，确认一下金额和日期。${draft.warnings?.length ? '\n注意：' + draft.warnings.join('；') : ''}` }
  }
  const text = typeof last.content === 'string' ? last.content : ''
  const calls = stubPlan(text, ctx)
  if (!calls.length) {
    return { role: 'assistant', content: ctx.draftsAllowed
      ? '（stub）没识别出要录入的内容。可以说「录一笔应收：客户 12，金额 128000，月底到期」。'
      : '（stub）当前页面只支持问答，不生成草稿；录入请到账户 / 流水 / 应收 / 发票页面。' }
  }
  return { role: 'assistant', content: '', tool_calls: calls }
}
