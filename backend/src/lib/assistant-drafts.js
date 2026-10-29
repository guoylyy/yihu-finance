// 录入助手的「草稿」：把大模型给的参数校验成可以直接提交给现有 REST 接口的结构
// 这里只校验、查库核对引用，绝不写库。字段不合规一律剔除，记进 missing / warnings 让模型去反问，
// 所以返回的 payload 里只会有值域内的数据
import { z } from 'zod'
import dayjs from 'dayjs'
import prisma from './prisma.js'
import { scopeWhere, inScope } from './auth.js'
import { dec, parseAmount } from './money.js'
import { toDate } from './period.js'
import { assertPeriodOpen } from './close.js'

export const DRAFT_KINDS = ['account', 'receivable', 'invoice', 'transaction']

const ACCOUNT_TYPES = ['BANK', 'ALIPAY', 'WECHAT', 'CASH', 'PETTY', 'INTERCOMPANY']
const INVOICE_TYPES = ['SALES', 'PURCHASE', 'EXPENSE', 'RED']
const CONFIDENCE = ['CONFIRMED', 'HIGH', 'ESTIMATE']
const CURRENCIES = ['CNY', 'USD', 'HKD', 'EUR']
const BIZ_IN = ['SALES_RECEIPT', 'OTHER_IN', 'LOAN', 'REPAY', 'TRANSFER', 'INTERCOMPANY']
const BIZ_OUT = ['SALARY', 'LABOR', 'REIMBURSE', 'PURCHASE', 'SERVICE', 'TAX', 'RENT', 'SOFTWARE', 'OTHER_OUT', 'LOAN', 'REPAY', 'TRANSFER', 'INTERCOMPANY']

// ---------- 字段类型 ----------
const idSchema = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^[1-9]\d{0,17}$/, '必须是正整数 id'))
const str = (max) => z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().min(1, '不能为空').max(max, `不能超过 ${max} 个字`))

/** 金额：返回两位小数的字符串（交给后端按 Decimal(18,2) 入库），不做浮点运算 */
function moneySchema({ allowZero = false, allowNegative = false } = {}) {
  return z.union([z.string(), z.number()]).transform((v, ctx) => {
    const raw = String(v).trim()
    const n = parseAmount(raw)
    if (n == null || !Number.isFinite(n)) { ctx.addIssue({ code: 'custom', message: '不是有效金额' }); return z.NEVER }
    const decimals = raw.replace(/[¥￥,\s元()]/g, '').split('.')[1]
    if (decimals && decimals.length > 2) { ctx.addIssue({ code: 'custom', message: '最多两位小数（到分）' }); return z.NEVER }
    if (n < 0 && !allowNegative) { ctx.addIssue({ code: 'custom', message: '不能为负数' }); return z.NEVER }
    if (n === 0 && !allowZero) { ctx.addIssue({ code: 'custom', message: '必须大于 0' }); return z.NEVER }
    if (Math.abs(n) >= 1e16) { ctx.addIssue({ code: 'custom', message: '超出金额范围' }); return z.NEVER }
    return dec(n).toFixed(2)
  })
}

/** 日期：只认 YYYY-MM-DD（允许 / . 分隔），按 lib/period.js 的 toDate() 归一，输出 YYYY-MM-DD */
const dateSchema = z.string().trim().transform((v, ctx) => {
  const m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  const norm = m && `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  const d = norm && dayjs(norm, 'YYYY-MM-DD', true).isValid() && dayjs(norm).format('YYYY-MM-DD') === norm ? toDate(norm) : null
  if (!d) { ctx.addIssue({ code: 'custom', message: '日期格式应为 YYYY-MM-DD' }); return z.NEVER }
  const y = d.getUTCFullYear()
  if (y < 2000 || y > 2100) { ctx.addIssue({ code: 'custom', message: '日期超出合理范围' }); return z.NEVER }
  return d.toISOString().slice(0, 10)
})

// ---------- 各类草稿的字段表 ----------
// arg：工具入参名（给模型看的）；key：REST 接口字段名（payload 里用）
const f = (arg, key, label, schema, extra = {}) => ({ arg, key, label, schema, ...extra })

const SPECS = {
  account: {
    label: '账户', model: 'account',
    fields: [
      f('company_id', 'companyId', '所属公司', idSchema, { required: true, ref: 'company' }),
      f('name', 'name', '账户名称', str(100), { required: true }),
      f('type', 'type', '账户类型', z.enum(ACCOUNT_TYPES), { default: 'BANK' }),
      f('bankName', 'bankName', '开户机构', str(100)),
      f('accountNo', 'accountNo', '账号', str(64).pipe(z.string().regex(/^[0-9A-Za-z\s-]+$/, '只能包含数字、字母、空格和横线'))),
      f('currency', 'currency', '币种', z.enum(CURRENCIES), { default: 'CNY' }),
      f('initialBalance', 'initialBalance', '期初余额', moneySchema({ allowZero: true })),
      f('initialDate', 'initialDate', '期初基准日', dateSchema),
      f('remark', 'remark', '备注', str(500))
    ]
  },
  receivable: {
    label: '应收款', model: 'receivable',
    fields: [
      f('company_id', 'companyId', '收款公司', idSchema, { required: true, ref: 'company' }),
      f('customer_id', 'customerId', '客户', idSchema, { ref: 'customer' }),
      f('project_id', 'projectId', '项目', idSchema, { ref: 'project' }),
      f('contractNo', 'contractNo', '合同号', str(64)),
      f('title', 'title', '款项说明', str(200), { required: true }),
      f('amount', 'amount', '应收金额', moneySchema(), { required: true }),
      f('expectDate', 'expectDate', '预计收款日', dateSchema),
      f('confidence', 'confidence', '把握度', z.enum(CONFIDENCE), { default: 'HIGH' }),
      f('remark', 'remark', '备注', str(500))
    ]
  },
  invoice: {
    label: '发票', model: 'invoice',
    fields: [
      f('company_id', 'companyId', '所属公司', idSchema, { required: true, ref: 'company' }),
      f('type', 'type', '发票类型', z.enum(INVOICE_TYPES), { required: true }),
      f('invoiceNo', 'invoiceNo', '发票号码', str(64).pipe(z.string().regex(/^[0-9A-Za-z]+$/, '只能包含数字和字母')), { required: true }),
      f('invoiceCode', 'invoiceCode', '发票代码', str(64).pipe(z.string().regex(/^[0-9A-Za-z]+$/, '只能包含数字和字母'))),
      f('issueDate', 'issueDate', '开票日期', dateSchema),
      f('sellerName', 'sellerName', '开票方', str(120)),
      f('buyerName', 'buyerName', '受票方', str(120)),
      // 红字发票金额为负，其余类型不得为负：在 buildDraft 里按 type 二次校验
      f('amount', 'amount', '不含税金额', moneySchema({ allowZero: true, allowNegative: true })),
      f('taxAmount', 'taxAmount', '税额', moneySchema({ allowZero: true, allowNegative: true })),
      f('totalAmount', 'totalAmount', '价税合计', moneySchema({ allowZero: true, allowNegative: true })),
      f('customer_id', 'customerId', '客户', idSchema, { ref: 'customer' }),
      f('remark', 'remark', '备注', str(500))
    ]
  },
  transaction: {
    label: '流水', model: 'transaction',
    fields: [
      f('company_id', 'companyId', '公司', idSchema, { required: true, ref: 'company' }),
      f('account_id', 'accountId', '账户', idSchema, { required: true, ref: 'account' }),
      f('txnDate', 'txnDate', '交易日期', dateSchema, { required: true }),
      f('direction', 'direction', '收支方向', z.enum(['IN', 'OUT']), { required: true }),
      f('amount', 'amount', '金额', moneySchema(), { required: true }),
      f('counterparty', 'counterparty', '对方名称', str(120)),
      f('summary', 'remark', '摘要', str(500)),
      f('bizType', 'bizType', '业务类型', z.enum([...new Set([...BIZ_IN, ...BIZ_OUT])])),
      f('project_id', 'projectId', '项目', idSchema, { ref: 'project' })
    ]
  }
}

export const fieldLabels = (kind) => Object.fromEntries(SPECS[kind].fields.map((x) => [x.key, x.label]))

const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 30 ? s.slice(0, 30) + '…' : s }

// ---------- 引用核对：id 必须真实存在且在当前用户的数据范围内 ----------
async function loadRef(ref, id, user) {
  const bid = BigInt(id)
  if (ref === 'company') {
    const r = await prisma.company.findFirst({ where: { id: bid, deletedAt: null, ...scopeWhere(user, 'id') }, select: { id: true, code: true, name: true } })
    return r && { row: r, label: r.code }
  }
  if (ref === 'customer') {
    const r = await prisma.customer.findFirst({ where: { id: bid, deletedAt: null }, select: { id: true, name: true, companyId: true } })
    if (r?.companyId && !inScope(user, r.companyId)) return null
    return r && { row: r, label: r.name }
  }
  if (ref === 'project') {
    const r = await prisma.project.findFirst({ where: { id: bid, deletedAt: null, ...scopeWhere(user) }, select: { id: true, name: true, companyId: true } })
    return r && { row: r, label: r.name }
  }
  if (ref === 'account') {
    const r = await prisma.account.findFirst({ where: { id: bid, deletedAt: null, ...scopeWhere(user) }, select: { id: true, name: true, companyId: true, currency: true, status: true } })
    return r && { row: r, label: r.name }
  }
  return null
}

// 按名称模糊匹配（模型只知道名字时的兜底）：唯一命中就带出，多个就列候选让用户选
async function matchByName(ref, name, user) {
  const kw = String(name).trim().slice(0, 60)
  if (!kw) return []
  const take = 6
  if (ref === 'company') return (await prisma.company.findMany({ where: { deletedAt: null, ...scopeWhere(user, 'id'), OR: [{ code: { contains: kw } }, { name: { contains: kw } }] }, select: { id: true, code: true }, take })).map((r) => ({ id: String(r.id), label: r.code }))
  if (ref === 'customer') return (await prisma.customer.findMany({ where: { deletedAt: null, name: { contains: kw } }, select: { id: true, name: true, companyId: true }, take })).filter((r) => !r.companyId || inScope(user, r.companyId)).map((r) => ({ id: String(r.id), label: r.name }))
  if (ref === 'account') return (await prisma.account.findMany({ where: { deletedAt: null, ...scopeWhere(user), OR: [{ name: { contains: kw } }, { bankName: { contains: kw } }] }, select: { id: true, name: true }, take })).map((r) => ({ id: String(r.id), label: r.name }))
  if (ref === 'project') return (await prisma.project.findMany({ where: { deletedAt: null, ...scopeWhere(user), name: { contains: kw } }, select: { id: true, name: true }, take })).map((r) => ({ id: String(r.id), label: r.name }))
  return []
}

/**
 * 校验一份草稿
 * @param kind  account / receivable / invoice / transaction
 * @param args  模型给的工具参数（id 字段为 snake_case，可附带 xxx_name 作名称兜底；带 id 表示修改已有记录）
 * @returns { kind, mode, id, payload, labels, missing, warnings, candidates }
 */
export async function buildDraft(kind, args, user) {
  const spec = SPECS[kind]
  if (!spec) throw new Error(`不支持的草稿类型：${kind}`)
  args = args && typeof args === 'object' ? args : {}
  const payload = {}
  const labels = {}
  const missing = []
  const warnings = []
  const candidates = {}
  const refRows = {}

  // 修改模式：带 id 时先确认这条记录存在、在数据范围内
  let mode = 'create'
  let id = null
  if (args.id !== undefined && args.id !== null && args.id !== '') {
    const p = idSchema.safeParse(args.id)
    const row = p.success && await prisma[spec.model].findFirst({ where: { id: BigInt(p.data), deletedAt: null, ...scopeWhere(user) } })
    if (row) { mode = 'update'; id = p.data } else warnings.push(`要修改的${spec.label}（id ${short(args.id)}）不存在或无权访问，已按新增处理`)
  }

  for (const fd of spec.fields) {
    let v = args[fd.arg] ?? args[fd.key]
    if (v === '' || v === null) v = undefined
    if (v !== undefined) {
      const r = fd.schema.safeParse(v)
      if (!r.success) {
        warnings.push(`${fd.label}「${short(v)}」不合法：${r.error.issues[0]?.message || '格式不对'}`)
      } else if (fd.ref) {
        const hit = await loadRef(fd.ref, r.data, user)
        if (hit) { payload[fd.key] = r.data; labels[fd.key] = hit.label; refRows[fd.key] = hit.row } else warnings.push(`${fd.label} id ${r.data} 不存在或无权访问`)
      } else {
        payload[fd.key] = r.data
      }
    }
    // 只给了名称没给 id：按名称匹配
    const nameArg = fd.ref && args[`${fd.ref}_name`]
    if (fd.ref && payload[fd.key] === undefined && nameArg) {
      const hits = await matchByName(fd.ref, nameArg, user)
      if (hits.length === 1) { payload[fd.key] = hits[0].id; labels[fd.key] = hits[0].label; refRows[fd.key] = (await loadRef(fd.ref, hits[0].id, user))?.row }
      else if (hits.length > 1) { candidates[fd.key] = hits; warnings.push(`${fd.label}名称「${short(nameArg)}」匹配到 ${hits.length} 个，请选择`) }
      else warnings.push(`没找到名称包含「${short(nameArg)}」的${fd.label}`)
    }
  }

  // ---------- 联动与跨字段校验 ----------
  // 公司没给时，按客户 / 账户 / 项目的归属带出；用户只能看一家公司时直接用它
  if (!payload.companyId) {
    const from = ['accountId', 'projectId', 'customerId'].find((k) => refRows[k]?.companyId)
    if (from) {
      const c = await loadRef('company', String(refRows[from].companyId), user)
      if (c) { payload.companyId = String(c.row.id); labels.companyId = c.label; warnings.push(`所属公司按${fieldLabels(kind)[from]}带出为「${c.label}」，请核对`) }
    } else if (mode === 'create') {
      const list = await prisma.company.findMany({ where: { deletedAt: null, status: 'ACTIVE', ...scopeWhere(user, 'id') }, select: { id: true, code: true }, take: 6 })
      if (list.length === 1) { payload.companyId = String(list[0].id); labels.companyId = list[0].code }
      else if (list.length > 1) candidates.companyId = list.map((c) => ({ id: String(c.id), label: c.code }))
    }
  }
  if (kind === 'transaction') {
    const acc = refRows.accountId
    if (acc && payload.companyId && String(acc.companyId) !== String(payload.companyId)) {
      warnings.push(`账户「${acc.name}」不属于所选公司，已移除账户`)
      delete payload.accountId; delete labels.accountId
    }
    if (acc && acc.status !== 'ACTIVE') warnings.push(`账户「${acc.name}」不是启用状态`)
    if (payload.direction) {
      const allowed = payload.direction === 'IN' ? BIZ_IN : BIZ_OUT
      if (payload.bizType && !allowed.includes(payload.bizType)) { warnings.push(`业务类型 ${payload.bizType} 与收支方向不符，已改为默认`); delete payload.bizType }
      if (!payload.bizType && mode === 'create') payload.bizType = payload.direction === 'IN' ? 'OTHER_IN' : 'OTHER_OUT'
    }
    if (payload.companyId && payload.txnDate) {
      const locked = await assertPeriodOpen(payload.companyId, toDate(payload.txnDate))
      if (locked) warnings.push(locked)
    }
  }
  if (kind === 'invoice') {
    const type = payload.type
    for (const k of ['amount', 'taxAmount', 'totalAmount']) {
      if (payload[k] != null && type !== 'RED' && dec(payload[k]).isNegative()) {
        warnings.push(`${fieldLabels(kind)[k]}「${payload[k]}」不合法：只有红字发票金额可以为负`)
        delete payload[k]
      }
    }
    // 三个金额填两个，补齐第三个（与 invoices.js 的 fillAmounts 一致，但用 Decimal 算）
    const { amount, taxAmount, totalAmount } = payload
    if (totalAmount == null && amount != null && taxAmount != null) payload.totalAmount = dec(amount).plus(taxAmount).toFixed(2)
    else if (amount == null && totalAmount != null && taxAmount != null) payload.amount = dec(totalAmount).minus(taxAmount).toFixed(2)
    else if (taxAmount == null && totalAmount != null && amount != null) payload.taxAmount = dec(totalAmount).minus(amount).toFixed(2)
    else if (amount != null && taxAmount != null && totalAmount != null && !dec(amount).plus(taxAmount).eq(totalAmount)) {
      warnings.push(`不含税金额 + 税额 ≠ 价税合计（${amount} + ${taxAmount} ≠ ${totalAmount}），请核对`)
    }
    if (mode === 'create' && payload.amount == null && payload.totalAmount == null) missing.push('amount')
    if (mode === 'create' && payload.companyId && payload.invoiceNo) {
      const exist = await prisma.invoice.findFirst({ where: { companyId: BigInt(payload.companyId), invoiceNo: payload.invoiceNo, deletedAt: null }, select: { id: true } })
      if (exist) warnings.push(`发票号 ${payload.invoiceNo} 已存在（id ${exist.id}），提交会被拒绝`)
    }
  }

  // 默认值与必填
  if (mode === 'create') {
    for (const fd of spec.fields) {
      if (payload[fd.key] === undefined && fd.default !== undefined) payload[fd.key] = fd.default
      if (fd.required && payload[fd.key] === undefined && !missing.includes(fd.key)) missing.push(fd.key)
    }
  }

  return { kind, mode, id, payload, labels, missing, warnings, candidates }
}

// ---------- 给模型看的工具定义（OpenAI function calling 格式） ----------
const P = {
  id: (d) => ({ type: 'string', description: d }),
  s: (d) => ({ type: 'string', description: d }),
  money: (d) => ({ type: 'string', description: `${d}，单位元，最多两位小数，如 "128000.00"` }),
  date: (d) => ({ type: 'string', description: `${d}，格式 YYYY-MM-DD` }),
  e: (values, d) => ({ type: 'string', enum: values, description: d })
}
const editId = (label) => ({ id: P.id(`要修改的${label} id；新增时不传`) })

export const DRAFT_TOOLS = {
  account: {
    description: '生成「账户」草稿（不落库，由用户在界面确认后提交）。',
    properties: {
      ...editId('账户'),
      company_id: P.id('所属公司 id'), company_name: P.s('不知道 id 时给公司名称'),
      name: P.s('账户名称，如「基本户」'), type: P.e(ACCOUNT_TYPES, '账户类型'),
      bankName: P.s('开户机构'), accountNo: P.s('账号'), currency: P.e(CURRENCIES, '币种，默认 CNY'),
      initialBalance: P.money('期初余额'), initialDate: P.date('期初余额对应的日期'), remark: P.s('备注')
    }
  },
  receivable: {
    description: '生成「应收款」草稿（不落库，由用户在界面确认后提交）。',
    properties: {
      ...editId('应收款'),
      company_id: P.id('收款公司 id'), company_name: P.s('不知道 id 时给公司名称'),
      customer_id: P.id('客户 id'), customer_name: P.s('不知道 id 时给客户名称'),
      project_id: P.id('项目 id'), contractNo: P.s('合同号'), title: P.s('款项说明，如「XX 项目一期款」'),
      amount: P.money('应收金额，必须大于 0'), expectDate: P.date('预计收款日'),
      confidence: P.e(CONFIDENCE, '把握度：CONFIRMED 已确认 / HIGH 大概率 / ESTIMATE 估计'), remark: P.s('备注')
    }
  },
  invoice: {
    description: '生成「发票」草稿（不落库，由用户在界面确认后提交）。三个金额给两个即可。',
    properties: {
      ...editId('发票'),
      company_id: P.id('所属公司 id'), company_name: P.s('不知道 id 时给公司名称'),
      invoiceNo: P.s('发票号码'), invoiceCode: P.s('发票代码'),
      type: P.e(INVOICE_TYPES, 'SALES 销项 / PURCHASE 进项 / EXPENSE 费用 / RED 红字'),
      issueDate: P.date('开票日期'), sellerName: P.s('开票方'), buyerName: P.s('受票方'),
      amount: P.money('不含税金额'), taxAmount: P.money('税额'), totalAmount: P.money('价税合计'),
      customer_id: P.id('客户 id'), customer_name: P.s('不知道 id 时给客户名称'), remark: P.s('备注')
    }
  },
  transaction: {
    description: '生成「资金流水」草稿（不落库，由用户在界面确认后提交）。',
    properties: {
      ...editId('流水'),
      company_id: P.id('公司 id'), account_id: P.id('账户 id'), account_name: P.s('不知道 id 时给账户名称'),
      txnDate: P.date('交易日期'), direction: P.e(['IN', 'OUT'], 'IN 收入 / OUT 支出'),
      amount: P.money('金额，恒为正数，方向看 direction'), counterparty: P.s('对方名称'), summary: P.s('摘要/备注'),
      bizType: P.e([...new Set([...BIZ_IN, ...BIZ_OUT])], '业务类型，不确定就不传'), project_id: P.id('项目 id')
    }
  }
}
