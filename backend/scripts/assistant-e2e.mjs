// 录入助手端到端检查（本地 / CI）：需要后端以 FIN_LLM_STUB=1 启动并已 seed
//   FIN_LLM_STUB=1 npm start
//   node scripts/assistant-e2e.mjs [--fixtures]
// --fixtures：客户不足 12 个时补建演示客户（让「客户 12」存在），只建在测试库上用
import assert from 'node:assert/strict'
import dayjs from 'dayjs'

const BASE = process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3010}`
const withFixtures = process.argv.includes('--fixtures')
let failed = 0

async function http(method, path, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const login = async (u, p) => (await http('POST', '/api/auth/login', null, { username: u, password: p })).json.data.token
const chat = (token, text, context = { route: '/receivables', pinned: [] }) =>
  http('POST', '/api/fin/assistant/chat', token, { messages: [{ role: 'user', content: text }], context })

async function check(name, fn) {
  try { await fn(); console.log(`✔ ${name}`) } catch (e) { failed++; console.log(`✘ ${name}\n  ${e.message}`) }
}

const admin = await login('admin', 'admin123')
const staff = await login('staff', 'staff123')

if (withFixtures) {
  const names = ['栗海贸易', '栗海科技', '北辰物流', '南屿咨询', '东篱文化', '西岭数据', '白鹭传媒', '青禾农业', '远山建设', '晨星医疗', '暮云软件', '栗海贸易']
  const { json } = await http('GET', '/api/fin/customers?page_size=100', admin)
  for (let i = json.data.total; i < 12; i++) {
    // 第 12 个客户固定叫「栗海贸易」，第 1 / 2 个用于测同名模糊匹配
    await http('POST', '/api/fin/customers', admin, { name: i === 11 ? '栗海贸易' : names[i] })
  }
  // 客户 12 归属云帆科技（公司 1），用来验证「所属公司按客户带出」
  const c12 = (await http('GET', '/api/fin/customers/12', admin)).json.data
  if (c12 && !c12.companyId) await http('PUT', '/api/fin/customers/12', admin, { companyId: '1' })
}

const eom = dayjs().endOf('month').format('YYYY-MM-DD')

await check('status：stub 模式可用', async () => {
  const { json } = await http('GET', '/api/fin/assistant/status', admin)
  assert.equal(json.code, 0)
  assert.equal(json.data.available, true)
  assert.equal(json.data.stub, true)
})

let full
await check('完整应收 → drafts[0].kind === receivable 且字段齐全', async () => {
  const { json } = await chat(admin, '录一笔应收：客户 12，金额 128000，月底到期')
  assert.equal(json.code, 0, json.message)
  const d = json.data.drafts[0]
  full = d
  console.log('  reply:', json.data.reply)
  console.log('  draft:', JSON.stringify(d))
  assert.equal(d.kind, 'receivable')
  assert.deepEqual(d.missing, [])
  assert.equal(d.payload.customerId, '12')
  assert.equal(d.payload.amount, '128000.00')
  assert.equal(d.payload.expectDate, eom)
  for (const k of ['companyId', 'customerId', 'title', 'amount', 'expectDate', 'confidence']) assert.ok(d.payload[k], `缺少 ${k}`)
  assert.equal(d.payload.companyId, '1')
  assert.ok(d.warnings.some((w) => w.includes('按客户带出')))
})

await check('页面筛选里的 company_id 作为公司提示（服务端校验）', async () => {
  const { json } = await chat(admin, '录一笔应收：金额 900，月底到期', { route: '/receivables', pinned: [], filters: { company_id: '2' } })
  assert.equal(json.data.drafts[0].payload.companyId, '2')
})

await check('缺金额 → missing 含 amount', async () => {
  const { json } = await chat(admin, '录一笔应收：客户 12，月底到期')
  const d = json.data.drafts[0]
  console.log('  reply:', json.data.reply, '| missing:', d.missing)
  assert.ok(d.missing.includes('amount'))
  assert.equal(d.payload.amount, undefined)
})

for (const bad of ['-5', 'abc', '12.345', '0']) {
  await check(`金额 ${bad} → 进 warnings / missing，payload 不带非法金额`, async () => {
    const { json } = await chat(admin, `录一笔应收：客户 12，金额 ${bad}，月底到期`)
    const d = json.data.drafts[0]
    console.log('  missing:', d.missing, '| warnings:', d.warnings)
    assert.ok(d.missing.includes('amount'))
    assert.ok(d.warnings.some((w) => w.includes('应收金额')))
    assert.equal(d.payload.amount, undefined)
  })
}

await check('名称匹配到多个 → warnings + candidates', async () => {
  const { json } = await chat(admin, '录一笔应收：客户 栗海，金额 5000，月底到期')
  const d = json.data.drafts[0]
  console.log('  warnings:', d.warnings, '| candidates:', JSON.stringify(d.candidates.customerId))
  assert.ok(d.warnings.some((w) => /匹配到 \d+ 个/.test(w)))
  assert.ok(d.candidates.customerId.length >= 2)
})

await check('pinned 伪造 id / 非法类型被服务端忽略，合法的按库里数据重查', async () => {
  const { json } = await chat(admin, '录一笔应收：金额 100，月底到期', {
    route: '/receivables', pinned: [{ type: 'customer', id: '12' }, { type: 'customer', id: '99999' }, { type: 'user', id: '1' }, { type: 'customer', id: '1 OR 1=1' }]
  })
  const d = json.data.drafts[0]
  assert.equal(d.payload.customerId, '12')
  assert.equal(d.labels.customerId, '栗海贸易')
})

await check('非录入页面（/dashboard）不出草稿', async () => {
  const { json } = await chat(admin, '录一笔应收：客户 12，金额 128000，月底到期', { route: '/dashboard', pinned: [] })
  assert.equal(json.data.drafts.length, 0)
})

await check('流水草稿：账户按 @ 引用带出公司，金额两位小数', async () => {
  const acc = (await http('GET', '/api/fin/accounts?page_size=1', admin)).json.data.list[0]
  const { json } = await chat(admin, '记一笔支出：金额 3200.5，对方 某某物业，摘要 10 月物业费', { route: '/transactions', pinned: [{ type: 'account', id: acc.id }] })
  const d = json.data.drafts[0]
  console.log('  draft:', JSON.stringify(d.payload), d.missing)
  assert.equal(d.kind, 'transaction')
  assert.equal(d.payload.amount, '3200.50')
  assert.equal(d.payload.companyId, String(acc.companyId))
  assert.equal(d.payload.bizType, 'OTHER_OUT')
  assert.deepEqual(d.missing, [])
})

await check('发票草稿：补齐不含税金额', async () => {
  const { json } = await chat(admin, '录一张进项发票：发票号 E2E20261028，金额 10600，税额 600，今天开的', { route: '/invoices', pinned: [{ type: 'company', id: '1' }] })
  const d = json.data.drafts[0]
  console.log('  draft:', JSON.stringify(d.payload), d.missing)
  assert.equal(d.kind, 'invoice')
  assert.equal(d.payload.amount, '10000.00')
  assert.deepEqual(d.missing, [])
})

await check('草稿可直接提交给现有 REST 创建接口（模拟「确认提交」）', async () => {
  const { json } = await http('POST', '/api/fin/receivables', admin, full.payload)
  assert.equal(json.code, 0, json.message)
  assert.equal(json.data.amount, '128000')
  console.log('  created:', json.data.code, json.data.title, json.data.amount)
})

await check('audit_logs 里有 assistant.chat，且不含对话原文', async () => {
  const { json } = await http('GET', '/api/fin/audit-logs?action=assistant.chat&page_size=3', admin)
  assert.ok(json.data.total > 0)
  const row = json.data.list[0]
  console.log('  latest:', row.action, '|', row.summary, '|', JSON.stringify(row.after))
  assert.ok(!JSON.stringify(row).includes('128000'))
})

await check('无 finance.view 的用户（STAFF）→ 403', async () => {
  const r = await chat(staff, '录一笔应收：客户 12，金额 128000，月底到期')
  console.log('  HTTP', r.status, JSON.stringify(r.json))
  assert.equal(r.status, 403)
  const s = await http('GET', '/api/fin/assistant/status', staff)
  assert.equal(s.status, 403)
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
