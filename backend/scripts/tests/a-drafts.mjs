// A. 四类草稿：happy / 缺关键字段 / 非法值（stub 下断言具体值；live 下只断言结构）
import dayjs from 'dayjs'
import { assert, ctx, pin, assertChatShape } from './lib.mjs'

export default async function run(t) {
  const { check, fx } = t
  const W = { needs: ['write', 'stub'] }
  const say = async (text, c, who = 'admin') => {
    const d = assertChatShape(await t.api.chat(fx.tokens[who], text, c))
    t.log('reply:', d.reply.replace(/\n/g, ' '), '| drafts:', JSON.stringify(d.drafts.map((x) => ({ kind: x.kind, mode: x.mode, payload: x.payload, missing: x.missing, warnings: x.warnings }))))
    return d
  }
  const one = (d, kind) => { assert.equal(d.drafts.length, 1, `应有 1 份草稿，实际 ${d.drafts.length}`); assert.equal(d.drafts[0].kind, kind); return d.drafts[0] }
  const A = String(fx?.companyA?.id)
  const B = String(fx?.companyB?.id)
  const today = dayjs().format('YYYY-MM-DD')
  const eom = dayjs().endOf('month').format('YYYY-MM-DD')
  const hasWarn = (d, re) => assert.ok(d.warnings.some((w) => re.test(w)), `warnings 里没有 ${re}：${JSON.stringify(d.warnings)}`)

  // ---------- account ----------
  const ACC = (pins = [pin('company', A)]) => ctx('/accounts', pins)
  await check('A', 'account happy：name / type / 公司 / 期初余额两位小数', async () => {
    const d = one(await say(`新增账户：叫 ${fx.prefix}招行基本户，开户行 招商银行，期初 5000.5`, ACC()), 'account')
    assert.equal(d.mode, 'create')
    assert.equal(d.payload.name, `${fx.prefix}招行基本户`)
    assert.equal(d.payload.type, 'BANK')
    assert.equal(d.payload.companyId, A)
    assert.equal(d.payload.initialBalance, '5000.50')
    assert.equal(d.payload.currency, 'CNY')
    assert.deepEqual(d.missing, [])
  }, W)
  await check('A', 'account type 合法枚举（WECHAT）原样保留；非法枚举进 warnings', async () => {
    const ok = one(await say(`新增账户：叫 ${fx.prefix}微信，类型 WECHAT`, ACC()), 'account')
    assert.equal(ok.payload.type, 'WECHAT')
    const bad = one(await say(`新增账户：叫 ${fx.prefix}X，类型 FOO`, ACC()), 'account')
    hasWarn(bad, /账户类型/)
    assert.notEqual(bad.payload.type, 'FOO')
  }, W)
  await check('A', 'account 缺 name → missing 含 name', async () => {
    const d = one(await say('新增账户：开户行 招商银行', ACC()), 'account')
    assert.ok(d.missing.includes('name'), JSON.stringify(d.missing))
    assert.equal(d.payload.name, undefined)
  }, W)
  for (const bad of ['-1', 'abc']) {
    await check('A', `account initialBalance=${bad} → warnings，payload 不带期初余额`, async () => {
      const d = one(await say(`新增账户：叫 ${fx.prefix}Y，期初 ${bad}`, ACC()), 'account')
      hasWarn(d, /期初余额/)
      assert.equal(d.payload.initialBalance, undefined)
    }, W)
  }

  // ---------- receivable ----------
  const AR = (pins = []) => ctx('/receivables', pins)
  await check('A', 'receivable happy：客户带出公司、金额两位小数、月底换算', async () => {
    const d = one(await say(`录一笔应收：客户 ${fx.custA.id}，金额 128000，月底到期`, AR()), 'receivable')
    assert.deepEqual(d.missing, [])
    assert.equal(d.payload.customerId, String(fx.custA.id))
    assert.equal(d.payload.companyId, A)
    assert.equal(d.payload.amount, '128000.00')
    assert.equal(d.payload.expectDate, eom)
    assert.equal(d.payload.confidence, 'HIGH')
    assert.ok(d.payload.title)
    hasWarn(d, /按客户带出/)
  }, W)
  await check('A', 'receivable 页面筛选 company_id 作为公司提示（服务端校验）', async () => {
    const d = one(await say('录一笔应收：金额 900，月底到期', ctx('/receivables', [], { company_id: B })), 'receivable')
    assert.equal(d.payload.companyId, B)
  }, W)
  await check('A', 'receivable 缺 amount → missing 含 amount', async () => {
    const d = one(await say(`录一笔应收：客户 ${fx.custA.id}，月底到期`, AR()), 'receivable')
    assert.ok(d.missing.includes('amount'))
    assert.equal(d.payload.amount, undefined)
  }, W)
  await check('A', 'receivable 缺 title → missing 含 title', async () => {
    const d = one(await say(`录一笔应收：客户 ${fx.custA.id}，金额 500，款项说明 无`, AR()), 'receivable')
    assert.ok(d.missing.includes('title'), JSON.stringify(d.missing))
  }, W)
  for (const bad of ['0', '-5', 'abc', '12.345']) {
    await check('A', `receivable 金额 ${bad} → missing + warnings，payload 不带非法金额`, async () => {
      const d = one(await say(`录一笔应收：客户 ${fx.custA.id}，金额 ${bad}，月底到期`, AR()), 'receivable')
      assert.ok(d.missing.includes('amount'))
      hasWarn(d, /应收金额/)
      assert.equal(d.payload.amount, undefined)
    }, W)
  }
  await check('A', 'receivable 名称匹配到多个 → warnings + candidates', async () => {
    const d = one(await say(`录一笔应收：客户 ${fx.prefix}-栗海，金额 5000，月底到期`, AR()), 'receivable')
    hasWarn(d, /匹配到 \d+ 个/)
    const ids = d.candidates.customerId.map((c) => c.id).sort()
    assert.deepEqual(ids, [String(fx.custA.id), String(fx.custA2.id)].sort())
    assert.equal(d.payload.customerId, undefined)
  }, W)

  // ---------- invoice ----------
  const INV = (pins = [pin('company', A)]) => ctx('/invoices', pins)
  const no = (s) => `${fx.invoiceNoBase}${s}`
  await check('A', 'invoice happy：价税合计 + 税额 → 补齐不含税金额', async () => {
    const d = one(await say(`录一张进项发票：发票号 ${no('H1')}，金额 10600，税额 600，今天开的`, INV()), 'invoice')
    assert.deepEqual(d.missing, [])
    assert.equal(d.payload.type, 'PURCHASE')
    assert.equal(d.payload.invoiceNo, no('H1'))
    assert.equal(d.payload.totalAmount, '10600.00')
    assert.equal(d.payload.taxAmount, '600.00')
    assert.equal(d.payload.amount, '10000.00')
    assert.equal(d.payload.issueDate, today)
  }, W)
  await check('A', 'invoice 三个金额一致 → 无「≠」警告', async () => {
    const d = one(await say(`录一张进项发票：发票号 ${no('H2')}，金额 10600，不含税 10000，税额 600`, INV()), 'invoice')
    assert.ok(!d.warnings.some((w) => w.includes('≠')), JSON.stringify(d.warnings))
  }, W)
  await check('A', 'invoice totalAmount ≠ amount + taxAmount → warning', async () => {
    const d = one(await say(`录一张进项发票：发票号 ${no('H3')}，金额 12000，不含税 10000，税额 600`, INV()), 'invoice')
    hasWarn(d, /≠ 价税合计/)
  }, W)
  await check('A', 'invoice 缺 invoiceNo → missing 含 invoiceNo', async () => {
    const d = one(await say('录一张进项发票：金额 1060，税额 60', INV()), 'invoice')
    assert.ok(d.missing.includes('invoiceNo'), JSON.stringify(d.missing))
  }, W)
  await check('A', 'invoice 非法值：税额 abc / 非红字负数金额 → warnings 且剔除', async () => {
    const d1 = one(await say(`录一张进项发票：发票号 ${no('H4')}，金额 1060，税额 abc`, INV()), 'invoice')
    hasWarn(d1, /税额/)
    assert.equal(d1.payload.taxAmount, undefined)
    const d2 = one(await say(`录一张销项发票：发票号 ${no('H5')}，金额 -1060`, INV()), 'invoice')
    hasWarn(d2, /只有红字发票/)
    assert.equal(d2.payload.totalAmount, undefined)
  }, W)
  await check('A', 'invoice 红字发票允许负数金额且联动正确', async () => {
    const d = one(await say(`录一张红字发票：发票号 ${no('H6')}，金额 -1060，税额 -60`, INV()), 'invoice')
    assert.equal(d.payload.type, 'RED')
    assert.equal(d.payload.amount, '-1000.00')
  }, W)
  await check('A', 'invoice 发票号已存在 → warning（提交会被拒）', async () => {
    const d = one(await say(`录一张进项发票：发票号 ${fx.invA.invoiceNo}，金额 100，税额 6`, INV()), 'invoice')
    hasWarn(d, /已存在/)
  }, W)

  // ---------- transaction ----------
  const TXN = (pins = [pin('account', fx.accA.id)]) => ctx('/transactions', pins)
  await check('A', 'transaction happy（OUT）：账户带出公司、金额两位小数、bizType 推导 OTHER_OUT', async () => {
    const d = one(await say('记一笔支出：金额 3200.5，对方 某某物业，摘要 10 月物业费', TXN()), 'transaction')
    assert.equal(d.payload.direction, 'OUT')
    assert.equal(d.payload.amount, '3200.50')
    assert.equal(d.payload.companyId, A)
    assert.equal(d.payload.accountId, String(fx.accA.id))
    assert.equal(d.payload.bizType, 'OTHER_OUT')
    assert.equal(d.payload.txnDate, today)
    assert.deepEqual(d.missing, [])
  }, W)
  await check('A', 'transaction direction=IN → bizType 推导 OTHER_IN', async () => {
    const d = one(await say('记一笔收入：金额 800', TXN()), 'transaction')
    assert.equal(d.payload.direction, 'IN')
    assert.equal(d.payload.bizType, 'OTHER_IN')
  }, W)
  await check('A', 'transaction bizType 与方向不符 → warning 并改回默认；合法的原样保留', async () => {
    const bad = one(await say('记一笔收入：金额 100，业务类型 SALARY', TXN()), 'transaction')
    hasWarn(bad, /与收支方向不符/)
    assert.equal(bad.payload.bizType, 'OTHER_IN')
    const ok = one(await say('记一笔支出：金额 100，业务类型 RENT', TXN()), 'transaction')
    assert.equal(ok.payload.bizType, 'RENT')
  }, W)
  await check('A', 'transaction 缺 accountId → missing 含 accountId', async () => {
    const d = one(await say('记一笔支出：金额 100，对方 某某', TXN([])), 'transaction')
    assert.ok(d.missing.includes('accountId'), JSON.stringify(d.missing))
    assert.equal(d.payload.accountId, undefined)
  }, W)
  await check('A', 'transaction 金额负数 → missing + warning', async () => {
    const d = one(await say('记一笔支出：金额 -100', TXN()), 'transaction')
    assert.ok(d.missing.includes('amount'))
    hasWarn(d, /金额/)
  }, W)
  await check('A', 'transaction 账户不属于所选公司 → 移除账户 + warning', async () => {
    const d = one(await say('记一笔支出：金额 100', TXN([pin('company', B), pin('account', fx.accA.id)])), 'transaction')
    hasWarn(d, /不属于所选公司/)
    assert.equal(d.payload.accountId, undefined)
    assert.ok(d.missing.includes('accountId'))
  }, W)

  // ---------- live：只断言结构 ----------
  await check('A', 'live：四类页面各说一句，返回结构合法、金额/日期/id 格式合法', async () => {
    const t0 = fx.tokens.admin
    for (const [route, text, pins] of [
      ['/accounts', `新开一个账户，叫 ${fx.prefix}L1，招商银行，期初 0`, [pin('company', A)]],
      ['/receivables', `给 ${fx.custA.name} 录一笔应收 128000 元，月底到期`, []],
      ['/invoices', `录一张进项发票，发票号 ${no('L1')}，价税合计 10600，税额 600，今天开的`, [pin('company', A)]],
      ['/transactions', '记一笔支出 3200.5 元，对方某某物业，10 月物业费', [pin('account', fx.accA.id)]]
    ]) {
      const d = assertChatShape(await t.api.chat(t0, text, ctx(route, pins)))
      t.log(route, d.reply, JSON.stringify(d.drafts))
    }
  }, { needs: ['write', 'live'] })
}
