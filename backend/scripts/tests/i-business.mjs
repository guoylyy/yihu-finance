// I. 业务回归：草稿「确认提交」走的是各模块现有接口——余额重算、审计、列表都和手工录入一致
import { assert, ctx, pin, assertChatShape, cents } from './lib.mjs'

export default async function run(t) {
  const { check, fx } = t
  const W = { needs: ['write', 'stub'] }
  const T = () => fx.tokens.finance
  let txn

  await check('I', '流水草稿确认提交 → 账户余额 = 原余额 − 金额（接口查）', async () => {
    const before = await t.api.data('GET', `/api/fin/accounts/${fx.accA.id}`, T())
    const d = assertChatShape(await t.api.chat(T(), '记一笔支出：金额 321.09，对方 余额回归测试，摘要 E2E', ctx('/transactions', [pin('account', fx.accA.id)])))
    const x = d.drafts[0]
    assert.deepEqual(x.missing, [])
    txn = await t.api.data('POST', '/api/fin/transactions', T(), x.payload)
    const after = await t.api.data('GET', `/api/fin/accounts/${fx.accA.id}`, T())
    assert.equal(cents(after.balance) - cents(before.balance), -32109n, `${before.balance} → ${after.balance}`)
    return `${before.balance} → ${after.balance}`
  }, W)

  await check('I', '收入流水 → 余额 = 原余额 + 金额；对账差额为 0', async () => {
    const before = await t.api.data('GET', `/api/fin/accounts/${fx.accA.id}`, T())
    const x = assertChatShape(await t.api.chat(T(), '记一笔收入：金额 1000.01', ctx('/transactions', [pin('account', fx.accA.id)]))).drafts[0]
    await t.api.data('POST', '/api/fin/transactions', T(), x.payload)
    const after = await t.api.data('GET', `/api/fin/accounts/${fx.accA.id}`, T())
    assert.equal(cents(after.balance) - cents(before.balance), 100001n)
    const rec = await t.api.data('GET', `/api/fin/accounts/${fx.accA.id}/reconcile`, T())
    assert.equal(rec.diff, 0)
  }, W)

  await check('I', 'audit_logs 同时有 assistant.chat 与业务自身的 CREATE transaction 审计行', async () => {
    assert.ok(txn, '上一步没建出流水')
    const admin = fx.tokens.admin
    const chats = (await t.api.data('GET', '/api/fin/audit-logs?action=assistant.chat&page_size=50', admin)).list.filter((r) => String(r.userId) === String(fx.users.finance.id))
    assert.ok(chats.length > 0, '没有 assistant.chat 审计行')
    const biz = (await t.api.data('GET', '/api/fin/audit-logs?entity=transaction&action=CREATE&page_size=50', admin)).list.find((r) => r.entityId === String(txn.id))
    assert.ok(biz, '没有业务 CREATE 审计行')
    assert.equal(String(biz.userId), String(fx.users.finance.id))
  }, W)

  await check('I', '列表接口能查到刚创建的流水', async () => {
    const list = await t.api.data('GET', `/api/fin/transactions?account_id=${fx.accA.id}&page_size=100`, T())
    assert.ok(list.list.some((r) => String(r.id) === String(txn.id)))
  }, W)

  await check('I', '应收草稿确认提交 → 列表可查、审计有 CREATE receivable、金额精确', async () => {
    const x = assertChatShape(await t.api.chat(T(), `录一笔应收：客户 ${fx.custA.id}，金额 999999999999999.99，月底到期`, ctx('/receivables'))).drafts[0]
    const ar = await t.api.data('POST', '/api/fin/receivables', T(), x.payload)
    const got = await t.api.data('GET', `/api/fin/receivables/${ar.id}`, T())
    assert.equal(cents(got.amount), 99999999999999999n, `入库金额 ${got.amount}`)
    const list = await t.api.data('GET', `/api/fin/receivables?keyword=${encodeURIComponent(ar.code)}`, T())
    assert.ok(list.list.some((r) => String(r.id) === String(ar.id)))
    const biz = (await t.api.data('GET', '/api/fin/audit-logs?entity=receivable&action=CREATE&page_size=50', fx.tokens.admin)).list.find((r) => r.entityId === String(ar.id))
    assert.ok(biz)
  }, W)

  await check('I', '账户 / 发票草稿确认提交 → 创建成功、余额 = 期初', async () => {
    const acc = assertChatShape(await t.api.chat(T(), `新增账户：叫 ${fx.prefix}回归户，期初 88.8`, ctx('/accounts', [pin('company', fx.companyA.id)]))).drafts[0]
    const a = await t.api.data('POST', '/api/fin/accounts', T(), acc.payload)
    assert.equal(cents(a.balance ?? a.initialBalance), 8880n)
    const inv = assertChatShape(await t.api.chat(T(), `录一张进项发票：发票号 ${fx.invoiceNoBase}I1，金额 1060，税额 60`, ctx('/invoices', [pin('company', fx.companyA.id)]))).drafts[0]
    const i = await t.api.data('POST', '/api/fin/invoices', T(), inv.payload)
    assert.equal(cents(i.amount), 100000n)
  }, W)
}
