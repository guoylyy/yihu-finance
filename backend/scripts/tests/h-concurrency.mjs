// H. 幂等与并发：同一草稿连点两次「确认提交」会怎样（记录现状，不改产品）；并发 chat 不串上下文
import { assert, ctx, pin, assertChatShape, assertDraftIdsWithin, cents } from './lib.mjs'

export default async function run(t) {
  const { check, fx } = t
  const W = { needs: ['write', 'stub'] }
  const draft = async (text, c, who = 'admin') => assertChatShape(await t.api.chat(fx.tokens[who], text, c)).drafts[0]

  // 「确认提交」= 前端拿 draft.payload 调一次模块的创建接口；连点两次 = 同一 payload 调两次
  await check('H', '应收草稿提交两次 → 产生两笔（服务端无去重）【现状记录】', async () => {
    const x = await draft(`录一笔应收：客户 ${fx.custA.id}，金额 4321，月底到期`, ctx('/receivables'))
    const [r1, r2] = await Promise.all([1, 2].map(() => t.api.http('POST', '/api/fin/receivables', fx.tokens.admin, x.payload)))
    const ok = [r1, r2].filter((r) => r.json.code === 0)
    t.notes.push(`H-应收：同一草稿并发提交两次 → 成功 ${ok.length} 笔${ok.length === 2 ? `（${ok.map((r) => r.json.data.code).join('、')}）` : `；失败原因：${[r1, r2].find((r) => r.json.code !== 0)?.json.message}`}`)
    assert.ok(ok.length >= 1)
    return `成功 ${ok.length} 笔`
  }, W)

  await check('H', '应收草稿顺序提交两次 → 两笔，编号不同', async () => {
    const x = await draft(`录一笔应收：客户 ${fx.custA.id}，金额 4322，月底到期`, ctx('/receivables'))
    const a = await t.api.data('POST', '/api/fin/receivables', fx.tokens.admin, x.payload)
    const b = await t.api.data('POST', '/api/fin/receivables', fx.tokens.admin, x.payload)
    assert.notEqual(a.id, b.id)
    t.notes.push(`H-应收：顺序提交两次 → 两笔（${a.code}、${b.code}）`)
    return `${a.code} / ${b.code}`
  }, W)

  await check('H', '发票草稿提交两次 → 第二次被发票号查重挡下', async () => {
    const x = await draft(`录一张进项发票：发票号 ${fx.invoiceNoBase}D1，金额 1060，税额 60`, ctx('/invoices', [pin('company', fx.companyA.id)]))
    const a = await t.api.http('POST', '/api/fin/invoices', fx.tokens.admin, x.payload)
    const b = await t.api.http('POST', '/api/fin/invoices', fx.tokens.admin, x.payload)
    assert.equal(a.json.code, 0)
    assert.equal(b.json.code, 9002)
    assert.match(b.json.message, /已存在/)
    t.notes.push('H-发票：第二次提交被「发票号已存在」挡下（同公司同号查重）')
  }, W)

  await check('H', '流水草稿提交两次 → 两笔，余额被扣两次【现状记录】', async () => {
    const acc0 = await t.api.data('GET', `/api/fin/accounts/${fx.accA.id}`, fx.tokens.admin)
    const x = await draft('记一笔支出：金额 11.11，对方 重复提交测试', ctx('/transactions', [pin('account', fx.accA.id)]))
    await t.api.data('POST', '/api/fin/transactions', fx.tokens.admin, x.payload)
    await t.api.data('POST', '/api/fin/transactions', fx.tokens.admin, x.payload)
    const acc1 = await t.api.data('GET', `/api/fin/accounts/${fx.accA.id}`, fx.tokens.admin)
    const delta = cents(acc1.balance) - cents(acc0.balance)
    assert.equal(delta, -2222n)
    t.notes.push(`H-流水：同一草稿提交两次 → 两笔流水，账户余额变动 ${Number(delta) / 100}（扣了两次）`)
  }, W)

  await check('H', '并发流水提交：同时 POST 两笔 → 都成功或明确报错，不出现同号两笔', async () => {
    const x = await draft('记一笔支出：金额 1.01，对方 并发编号测试', ctx('/transactions', [pin('account', fx.accA.id)]))
    const rs = await Promise.all([1, 2, 3].map(() => t.api.http('POST', '/api/fin/transactions', fx.tokens.admin, x.payload)))
    const codes = rs.filter((r) => r.json.code === 0).map((r) => r.json.data.code)
    assert.equal(new Set(codes).size, codes.length, `出现重复编号 ${codes}`)
    const fails = rs.filter((r) => r.json.code !== 0).map((r) => r.json.message)
    t.notes.push(`H-流水并发 3 笔：成功 ${codes.length}，失败 ${fails.length}${fails.length ? `（${fails[0].slice(0, 80)}）` : ''}`)
    return `成功 ${codes.length}，失败 ${fails.length}`
  }, W)

  await check('H', '同时发两个 chat → 都正常返回，各自对应自己的问题', async () => {
    const [r1, r2] = await Promise.all([
      t.api.chat(fx.tokens.admin, `录一笔应收：客户 ${fx.custA.id}，金额 111，月底到期`, ctx('/receivables')),
      t.api.chat(fx.tokens.finance, '记一笔支出：金额 222，对方 并发测试', ctx('/transactions', [pin('account', fx.accA.id)]))
    ])
    const d1 = assertChatShape(r1).drafts[0]
    const d2 = assertChatShape(r2).drafts[0]
    assert.equal(d1.kind, 'receivable'); assert.equal(d1.payload.amount, '111.00')
    assert.equal(d2.kind, 'transaction'); assert.equal(d2.payload.amount, '222.00')
  }, W)

  await check('H', '并发 8 个 chat（两个用户交错）→ 只看 A 的用户拿不到 B 的数据', async () => {
    const jobs = Array.from({ length: 8 }, (_, i) => i % 2
      ? t.api.chat(fx.tokens.financeA, `录一笔应收：金额 ${100 + i}，月底到期`, ctx('/receivables', [pin('company', fx.companyB.id), pin('customer', fx.custB.id)])).then((r) => ['A', i, r])
      : t.api.chat(fx.tokens.admin, `录一笔应收：客户 ${fx.custB.id}，金额 ${100 + i}，月底到期`, ctx('/receivables')).then((r) => ['all', i, r]))
    for (const [who, i, r] of await Promise.all(jobs)) {
      const d = assertChatShape(r)
      assert.equal(d.drafts[0].payload.amount, `${100 + i}.00`)
      if (who === 'A') assertDraftIdsWithin(d.drafts, { companyId: fx.scope.A })
      else assert.equal(d.drafts[0].payload.companyId, String(fx.companyB.id))
    }
  }, W)

  await check('H', 'live：并发两个 chat 都正常返回', async () => {
    const rs = await Promise.all([
      t.api.chat(t.write ? fx.tokens.admin : t.token, '现在是哪个页面？', ctx('/dashboard')),
      t.api.chat(t.write ? fx.tokens.admin : t.token, '录入助手能做什么？', ctx('/receivables'))
    ])
    for (const r of rs) assertChatShape(r)
  }, { needs: ['live'] })
}
