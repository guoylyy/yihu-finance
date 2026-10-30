// K. 跨页面操作（v1.3.1）：页面是上下文，不是能力边界。意图来自用户的话，一句话可以多个动作；权限与数据范围不放松
import { assert, ctx, pin, assertChatShape, cents } from './lib.mjs'
import { launchBrowser, sendInAssistant, STORE } from './browser.mjs'

export default async function run(t) {
  const { check, fx } = t
  const W = { needs: ['write', 'stub'] }
  const A = String(fx?.companyA?.id)
  const B = String(fx?.companyB?.id)
  const say = async (text, c, who = 'admin') => {
    const d = assertChatShape(await t.api.chat(fx.tokens[who], text, c))
    t.log('reply:', d.reply.replace(/\n/g, ' '), '| drafts:', JSON.stringify(d.drafts.map((x) => ({ kind: x.kind, payload: x.payload, missing: x.missing, warnings: x.warnings }))))
    return d
  }
  const balance = async (id) => cents((await t.api.data('GET', `/api/fin/accounts/${id}`, fx.tokens.admin)).balance)
  const draftRows = () => t.db.assistantDraft.count()

  // ---------- 单个跨类型 ----------
  await check('K', '/accounts + @账户：「给这个账户记一笔收款 5000」→ 1 张 transaction，accountId=该账户，IN', async () => {
    const d = await say('给这个账户记一笔收款 5000', ctx('/accounts', [pin('account', fx.accA.id)]))
    assert.equal(d.drafts.length, 1)
    const x = d.drafts[0]
    assert.equal(x.kind, 'transaction')
    assert.equal(x.mode, 'create')
    assert.equal(x.payload.accountId, String(fx.accA.id))
    assert.equal(x.payload.direction, 'IN')
    assert.equal(x.payload.amount, '5000.00')
    assert.equal(x.payload.companyId, A)
    assert.deepEqual(x.missing, [])
  }, W)

  await check('K', '/transactions：「录一笔应收，客户 X，金额 1000」→ receivable（跨类型）', async () => {
    const d = await say(`录一笔应收，客户 ${fx.custB.name}，金额 1000`, ctx('/transactions'))
    assert.equal(d.drafts.length, 1)
    assert.equal(d.drafts[0].kind, 'receivable')
    assert.equal(d.drafts[0].payload.customerId, String(fx.custB.id))
    assert.equal(d.drafts[0].payload.amount, '1000.00')
  }, W)

  await check('K', '/parties（原先完全不能出草稿）：「给客户 X 建一笔应收 2000」→ receivable', async () => {
    const d = await say(`给客户 ${fx.custB.name} 建一笔应收 2000`, ctx('/parties'))
    assert.equal(d.drafts.length, 1)
    assert.equal(d.drafts[0].kind, 'receivable')
    assert.equal(d.drafts[0].payload.customerId, String(fx.custB.id))
    assert.equal(d.drafts[0].payload.amount, '2000.00')
    assert.equal(d.drafts[0].payload.companyId, B)
  }, W)

  await check('K', '意图只看话不看路由：同一句话在 6 个页面上得到同样的草稿', async () => {
    const seen = new Set()
    for (const route of ['/accounts', '/receivables', '/invoices', '/transactions', '/dashboard', '/parties']) {
      const d = await say(`记一笔支出 88.5，账户 ${fx.accA.id}，对方 同话测试`, ctx(route))
      seen.add(JSON.stringify(d.drafts.map((x) => [x.kind, x.payload])))
    }
    assert.equal(seen.size, 1, [...seen].join('\n'))
    assert.match([...seen][0], /"transaction"/)
  }, W)

  // ---------- 回款 ----------
  const salesInvoice = async (suffix, customerId, total) => t.api.data('POST', '/api/fin/invoices', fx.tokens.admin, {
    companyId: A, invoiceNo: `${fx.invoiceNoBase}K${suffix}`, type: 'SALES', issueDate: '2026-10-01', amount: total, taxAmount: '0.00', totalAmount: total, customerId: String(customerId)
  })
  const receivableOf = async (title, customerId, amount) => t.api.data('POST', '/api/fin/receivables', fx.tokens.admin, { companyId: A, customerId: String(customerId), title: `${fx.prefix} ${title}`, amount })

  await check('K', '/invoices + @发票：「这笔开票的钱收到了」→ 回款草稿：引用发票、唯一匹配的应收、金额取价税合计', async () => {
    const ar = await receivableOf('回款匹配', fx.custA.id, '1234.00')
    const inv = await salesInvoice('R1', fx.custA.id, '1234.00')
    const d = await say('这笔开票的钱收到了', ctx('/invoices', [pin('invoice', inv.id)]))
    assert.equal(d.drafts.length, 1)
    const x = d.drafts[0]
    assert.equal(x.kind, 'transaction')
    assert.equal(x.payload.direction, 'IN')
    assert.equal(x.payload.invoiceId, String(inv.id))
    assert.equal(x.payload.refType, 'RECEIVABLE')
    assert.equal(x.payload.refId, String(ar.id))
    assert.equal(x.payload.bizType, 'SALES_RECEIPT')
    assert.equal(x.payload.amount, '1234.00')
    assert.deepEqual(x.missing, ['accountId'], '账户没说，要问，不能猜')
    await t.api.data('POST', `/api/fin/receivables/${ar.id}/receipt`, fx.tokens.admin, { accountId: String(fx.accA.id), amount: '1234.00', receiptDate: '2026-10-28' })
  }, W)

  await check('K', '回款草稿确认提交 → 应收冲减为已收清、流水 SALES_RECEIPT 且挂上发票、账户余额增加（没有走普通新增流水）', async () => {
    const ar = await receivableOf('回款提交', fx.custA2.id, '700.00')
    const inv = await salesInvoice('R2', fx.custA2.id, '700.00')
    const before = await balance(fx.accA.id)
    const d = await say('这笔开票的钱收到了', ctx('/invoices', [pin('invoice', inv.id), pin('account', fx.accA.id)]))
    const x = d.drafts[0]
    assert.deepEqual(x.missing, [])
    const r = await t.api.data('POST', `/api/fin/assistant/drafts/${x.draftId}/submit`, fx.tokens.admin, {})
    const after = await t.api.data('GET', `/api/fin/receivables/${ar.id}`, fx.tokens.admin)
    assert.equal(after.status, 'RECEIVED')
    assert.equal(cents(after.receivedAmount), 70000n)
    assert.equal(await balance(fx.accA.id), before + 70000n)
    const txn = await t.api.data('GET', `/api/fin/transactions/${r.id}`, fx.tokens.admin)
    assert.equal(txn.bizType, 'SALES_RECEIPT')
    assert.equal(txn.refType, 'RECEIVABLE')
    assert.equal(String(txn.refId), String(ar.id))
    assert.equal(String(txn.invoiceId), String(inv.id))
    assert.match(r.code, /^TXN-/)
    const again = await t.api.data('POST', `/api/fin/assistant/drafts/${x.draftId}/submit`, fx.tokens.admin, {})
    assert.equal(again.duplicate, true)
    assert.equal(cents((await t.api.data('GET', `/api/fin/receivables/${ar.id}`, fx.tokens.admin)).receivedAmount), 70000n, '重复提交不能再冲减一次')
  }, W)

  await check('K', '同客户有多笔未收清应收且金额对不上 → 不猜：列候选、refId 进 missing', async () => {
    const cust = await t.api.data('POST', '/api/fin/customers', fx.tokens.admin, { companyId: A, name: `${fx.prefix}-多应收客户` })
    const a1 = await receivableOf('候选一', cust.id, '100.00')
    const a2 = await receivableOf('候选二', cust.id, '200.00')
    const inv = await salesInvoice('R3', cust.id, '999.00')
    const x = (await say('这笔开票的钱收到了', ctx('/invoices', [pin('invoice', inv.id), pin('account', fx.accA.id)]))).drafts[0]
    assert.equal(x.payload.refId, undefined)
    assert.ok(x.missing.includes('refId'), JSON.stringify(x.missing))
    assert.deepEqual(x.candidates.refId.map((c) => c.id).sort(), [String(a1.id), String(a2.id)].sort())
  }, W)

  await check('K', '发票客户没有未收清应收 → 普通收入流水 + 警告「不会冲减应收」', async () => {
    const cust = await t.api.data('POST', '/api/fin/customers', fx.tokens.admin, { companyId: A, name: `${fx.prefix}-无应收客户` })
    const inv = await salesInvoice('R4', cust.id, '50.00')
    const x = (await say('这笔开票的钱收到了', ctx('/invoices', [pin('invoice', inv.id), pin('account', fx.accA.id)]))).drafts[0]
    assert.equal(x.payload.refType, undefined)
    assert.equal(x.payload.invoiceId, String(inv.id))
    assert.ok(x.warnings.some((w) => w.includes('不会冲减应收')), JSON.stringify(x.warnings))
  }, W)

  // ---------- 一句话多个动作 ----------
  await check('K', '一句话两件事：「给这个账户记一笔收款 1000，再开一张 1000 的发票」→ 2 张，kind 不同，draftId 不同', async () => {
    const d = await say('给这个账户记一笔收款 1000，再开一张 1000 的发票', ctx('/accounts', [pin('account', fx.accA.id)]))
    assert.equal(d.drafts.length, 2)
    assert.deepEqual(d.drafts.map((x) => x.kind).sort(), ['invoice', 'transaction'])
    assert.notEqual(d.drafts[0].draftId, d.drafts[1].draftId)
    const inv = d.drafts.find((x) => x.kind === 'invoice')
    assert.equal(inv.payload.totalAmount, '1000.00')
    assert.equal(inv.payload.type, 'SALES')
    assert.equal(inv.payload.companyId, A, '公司按 @ 的账户带出')
  }, W)

  await check('K', '「记一笔收款 5 万，再开一张 5 万的发票」→ 金额 50000.00，两张都对', async () => {
    const d = await say('给这个账户记一笔收款 5 万，再开一张 5 万的发票', ctx('/accounts', [pin('account', fx.accA.id)]))
    assert.equal(d.drafts.find((x) => x.kind === 'transaction').payload.amount, '50000.00')
    assert.equal(d.drafts.find((x) => x.kind === 'invoice').payload.totalAmount, '50000.00')
  }, W)

  await check('K', '同一句两笔同类型：「记两笔收款，1000 和 2000」→ 2 张（去重没有合并）', async () => {
    const d = await say('记两笔收款，1000 和 2000', ctx('/accounts', [pin('account', fx.accA.id)]))
    assert.equal(d.drafts.length, 2)
    assert.deepEqual(d.drafts.map((x) => x.kind), ['transaction', 'transaction'])
    assert.deepEqual(d.drafts.map((x) => x.payload.amount).sort(), ['1000.00', '2000.00'])
    assert.notEqual(d.drafts[0].draftId, d.drafts[1].draftId)
  }, W)

  await check('K', '金额相同也不合并：「记两笔收款，都是 1000」→ 2 张', async () => {
    const d = await say('记两笔收款，都是 1000', ctx('/accounts', [pin('account', fx.accA.id)]))
    assert.equal(d.drafts.length, 2)
    assert.deepEqual(d.drafts.map((x) => x.payload.amount), ['1000.00', '1000.00'])
  }, W)

  // ---------- 上下文优先级 ----------
  await check('K', '缺信息不猜：「记一笔收款」→ missing 含 accountId / amount', async () => {
    const d = await say('记一笔收款', ctx('/dashboard'))
    assert.equal(d.drafts.length, 1)
    assert.equal(d.drafts[0].kind, 'transaction')
    for (const k of ['accountId', 'amount']) assert.ok(d.drafts[0].missing.includes(k), JSON.stringify(d.drafts[0].missing))
    assert.match(d.reply, /账户/)
  }, W)

  await check('K', '优先级：明确说的 > @：@ A 账户但话里点名 B 账户 → 用 B', async () => {
    const d = await say(`给${fx.prefix}-B基本户记一笔收款 300`, ctx('/accounts', [pin('account', fx.accA.id)]))
    assert.equal(d.drafts[0].payload.accountId, String(fx.accB.id))
    assert.equal(d.drafts[0].payload.companyId, B)
  }, W)

  await check('K', '优先级：@ > 页面筛选：@ A 账户、筛选 B 公司 → 账户留着，公司是 A', async () => {
    const d = await say('给这个账户记一笔收款 300', ctx('/transactions', [pin('account', fx.accA.id)], { company_id: B }))
    assert.equal(d.drafts[0].payload.accountId, String(fx.accA.id))
    assert.equal(d.drafts[0].payload.companyId, A)
  }, W)

  await check('K', '优先级：都不确定 → 问：两家公司的账号没说公司 → companyId 待补充且列候选', async () => {
    const d = await say('录一笔应收，金额 300', ctx('/parties'))
    assert.ok(d.drafts[0].missing.includes('companyId'))
    assert.ok(d.drafts[0].candidates.companyId?.length >= 2)
  }, W)

  await check('K', '@ 支持供应商；补齐后 7 类实体都能 @（服务端重查，不信前端）', async () => {
    const sup = await t.api.data('POST', '/api/fin/suppliers', fx.tokens.admin, { companyId: A, name: `${fx.prefix}-供应商` })
    const proj = await t.api.data('POST', '/api/fin/projects', fx.tokens.admin, { companyId: A, name: `${fx.prefix}-项目`, code: `${fx.invoiceNoBase}P` })
    const ar = await receivableOf('全类型', fx.custA.id, '1.00')
    const r = await t.api.chat(fx.tokens.admin, '你好', ctx('/dashboard', [pin('account', fx.accA.id), pin('customer', fx.custA.id), pin('supplier', sup.id),
      pin('project', proj.id), pin('receivable', ar.id), pin('invoice', fx.invA.id), pin('company', A)]))
    assertChatShape(r)
    const row = (await t.api.data('GET', '/api/fin/audit-logs?action=assistant.chat&page_size=5', fx.tokens.admin)).list.find((x) => JSON.stringify(x).includes(`supplier:${sup.id}`))
    assert.ok(row, '审计里应记下 supplier 引用')
  }, W)

  // ---------- 权限与数据范围 ----------
  await check('K', '越权：受限账号 @ B 公司账户 → 9004 拒绝，不生成草稿、不落草稿表', async () => {
    const before = await draftRows()
    const r = await t.api.chat(fx.tokens.financeA, '给这个账户记一笔收款 5000', ctx('/accounts', [pin('account', fx.accB.id)]))
    assert.equal(r.json.code, 9004, JSON.stringify(r.json).slice(0, 200))
    assert.equal(r.json.data?.drafts, undefined)
    assert.match(r.json.message, /不存在或无权访问/)
    assert.ok(!r.json.message.includes(fx.accB.name), '错误信息不能带出别家账户名')
    assert.equal(await draftRows(), before)
  }, W)

  await check('K', '越权：受限账号 @ B 公司客户 → 9004；混着 A 的引用也整句拒绝（不能落到 A 的账户上）', async () => {
    const before = await draftRows()
    const r1 = await t.api.chat(fx.tokens.financeA, '给这个客户录一笔应收，金额 100', ctx('/parties', [pin('customer', fx.custB.id)]))
    assert.equal(r1.json.code, 9004)
    const r2 = await t.api.chat(fx.tokens.financeA, '给这个账户记一笔收款 100', ctx('/accounts', [pin('account', fx.accA.id), pin('account', fx.accB.id)]))
    assert.equal(r2.json.code, 9004)
    assert.equal(await draftRows(), before)
  }, W)

  await check('K', '不存在与越权的响应完全一样（不暴露记录是否存在）', async () => {
    const shape = (r, id) => JSON.stringify({ s: r.status, c: r.json.code, m: r.json.message.replace(id, 'ID') })
    const out = await t.api.chat(fx.tokens.financeA, '你好', ctx('/accounts', [pin('account', fx.accB.id)]))
    const none = await t.api.chat(fx.tokens.financeA, '你好', ctx('/accounts', [pin('account', '999999999999')]))
    assert.equal(shape(out, String(fx.accB.id)), shape(none, '999999999999'))
  }, W)

  await check('K', '跨页不跨权限：受限账号在 /dashboard 点名 B 的账户 id → 账户被剔除；页面筛选 B 公司 → 当没选', async () => {
    const d = await say(`记一笔收款 100，账户 ${fx.accB.id}`, ctx('/dashboard'), 'financeA')
    assert.equal(d.drafts[0].payload.accountId, undefined)
    assert.ok(d.drafts[0].warnings.some((w) => w.includes('无权访问')))
    const f = await say('录一笔应收，金额 100', ctx('/parties', [], { company_id: B }), 'financeA')
    assert.equal(f.drafts[0].payload.companyId, A, '只能看 A 的账号，筛选的 B 被忽略后回落到唯一可见的 A')
  }, W)

  await check('K', '受限账号：回款不能引用 B 的发票 / 应收（工具参数直接给 id 也不行）；REST 新增流水不能挂 B 的发票', async () => {
    const r = await t.api.chat(fx.tokens.financeA, '这笔开票的钱收到了', ctx('/invoices', [pin('invoice', fx.invB.id)]))
    assert.equal(r.json.code, 9004)
    const r2 = await t.api.http('POST', '/api/fin/transactions', fx.tokens.admin, { companyId: A, accountId: String(fx.accA.id), txnDate: '2026-10-28', direction: 'IN', amount: '1.00', invoiceId: String(fx.invB.id) })
    assert.equal(r2.json.code, 9002)
    assert.match(r2.json.message, /发票不属于该公司/)
  }, W)

  await check('K', 'VIEWER 在 /accounts 拿到回款 / 流水草稿 → 提交按模块权限 403（出草稿 ≠ 能写）', async () => {
    const x = (await say('给这个账户记一笔收款 100', ctx('/accounts', [pin('account', fx.accA.id)]), 'viewer')).drafts[0]
    assert.equal(x.kind, 'transaction')
    const r = await t.api.http('POST', `/api/fin/assistant/drafts/${x.draftId}/submit`, fx.tokens.viewer, {})
    assert.equal(r.status, 403)
  }, W)

  await check('K', '跨页草稿提交走原接口：/accounts 上提交流水草稿 → 余额变动、草稿标记已提交', async () => {
    const before = await balance(fx.accA.id)
    const x = (await say('给这个账户记一笔收款 12.34', ctx('/accounts', [pin('account', fx.accA.id)]))).drafts[0]
    const r = await t.api.data('POST', `/api/fin/assistant/drafts/${x.draftId}/submit`, fx.tokens.admin, {})
    assert.equal(r.duplicate, false)
    assert.equal(await balance(fx.accA.id), before + 1234n)
  }, W)

  await check('K', '审计：一句话两张草稿 → kinds 都记下，不含金额与原文', async () => {
    const marker = '987651'
    await say(`给这个账户记一笔收款 ${marker}，再开一张 ${marker} 的发票`, ctx('/accounts', [pin('account', fx.accA.id)]))
    const row = (await t.api.data('GET', '/api/fin/audit-logs?action=assistant.chat&page_size=5', fx.tokens.admin)).list[0]
    const text = JSON.stringify(row)
    assert.match(text, /transaction/)
    assert.match(text, /invoice/)
    assert.ok(!text.includes(marker), text.slice(0, 300))
  }, W)

  // ---------- 界面（无头 Chrome） ----------
  await check('K', 'DOM：/accounts 一句两件事 → 两张带徽章的草稿；「填入表单」跳到 /invoices 并打开预填弹窗，抽屉和草稿都在', async () => {
    const b = await launchBrowser(t.opts.chrome)
    try {
      await b.openAs(t.opts.ui, { token: fx.tokens.admin, user: fx.users.admin }, '/accounts')
      await b.waitFor(`!!document.querySelector('.assistant-pane')`, { what: '助手抽屉' })
      await b.evaluate(`${STORE}.pin('account', '${fx.accA.id}', '测试账户'), true`)
      await sendInAssistant(b, '给这个账户记一笔收款 1000，再开一张 1000 的发票')
      await b.waitFor(`document.querySelectorAll('.assistant-pane .draft').length === 2`, { what: '两张草稿卡' })
      const badges = await b.evaluate(`[...document.querySelectorAll('.assistant-pane .kind-badge')].map((x) => x.textContent.trim())`)
      assert.deepEqual([...badges].sort(), ['发票', '流水'].sort())
      const ctxText = await b.evaluate(`document.querySelector('.assistant-pane .a-context').textContent`)
      assert.ok(!ctxText.includes('只读问答'), ctxText)
      await b.evaluate(`[...document.querySelectorAll('.assistant-pane .draft')].find((x) => x.textContent.includes('发票')).querySelector('.draft-actions .el-button').click(), true`)
      await b.waitFor(`location.pathname.endsWith('/invoices')`, { what: '跳到发票页' })
      await b.waitFor(`!!document.querySelector('.el-dialog') && getComputedStyle(document.querySelector('.el-dialog')).display !== 'none'`, { what: '预填弹窗' })
      const dlg = await b.evaluate(`[...document.querySelectorAll('.el-dialog input')].map((x) => x.value).join('|')`)
      assert.match(dlg, /1,?000/, `弹窗里没有预填金额：${dlg}`)
      assert.equal(await b.evaluate(`document.querySelectorAll('.assistant-pane .draft').length`), 2, '切页后草稿应保留')
      assert.equal(await b.evaluate(`${STORE}.pinned.length`), 1, '切页后 @ 引用应保留')
      return `徽章 ${badges.join('/')}`
    } finally { await b.close() }
  }, { needs: ['write', 'stub', 'browser'] })
}
