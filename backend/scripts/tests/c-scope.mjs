// C. 数据范围与越权：伪造引用、别家公司的客户、只有 A 权限的人要 B 公司的草稿；以及「确认提交」走的 REST 接口本身；
//    转账 / 登记回款 / 关联发票 / 批量改流水 / 资金预测 / 异常清单 / 经营分析 对受限账号（只能看 A）的范围校验
import { assert, ctx, pin, assertChatShape, assertDraftIdsWithin, cents } from './lib.mjs'

export default async function run(t) {
  const { check, fx } = t
  const W = { needs: ['write', 'stub'] }
  const A = String(fx?.companyA?.id)
  const B = String(fx?.companyB?.id)
  const say = async (who, text, c) => {
    const d = assertChatShape(await t.api.chat(fx.tokens[who], text, c))
    t.log('drafts:', JSON.stringify(d.drafts.map((x) => ({ kind: x.kind, payload: x.payload, missing: x.missing, warnings: x.warnings }))))
    return d
  }

  await check('C', 'pinned 非法类型 / 非法 id 被忽略，合法的按库里数据重查', async () => {
    const d = await say('admin', '录一笔应收：金额 100，月底到期', ctx('/receivables', [
      pin('customer', fx.custA.id), { type: 'user', id: '1' }, { type: 'customer', id: '1 OR 1=1' }, { type: 'customer', id: -1 }, { type: '__proto__', id: '1' }
    ]))
    const x = d.drafts[0]
    assert.equal(x.payload.customerId, String(fx.custA.id))
    assert.equal(x.labels.customerId, fx.custA.name)
  }, W)

  await check('C', '草稿里填了别家公司的 customerId → 服务端剔除该字段 + warning', async () => {
    const d = await say('admin', `录一笔应收：客户 ${fx.custB.id}，金额 100，月底到期`, ctx('/receivables', [pin('company', A)]))
    const x = d.drafts[0]
    assert.equal(x.payload.companyId, A)
    assert.equal(x.payload.customerId, undefined)
    assert.ok(x.warnings.some((w) => w.includes('不属于所选公司')), JSON.stringify(x.warnings))
  }, W)

  await check('C', '发票草稿同理：别家公司的客户被剔除', async () => {
    const d = await say('admin', `录一张销项发票：发票号 ${fx.invoiceNoBase}C1，金额 1060，税额 60，客户 ${fx.custB.id}`, ctx('/invoices', [pin('company', A)]))
    assert.equal(d.drafts[0].payload.customerId, undefined)
    assert.ok(d.drafts[0].warnings.some((w) => w.includes('不属于所选公司')))
  }, W)

  await check('C', '只有 A 权限的账号要 B 公司的应收草稿 → 不产出 B 的数据，也不悄悄改成 A', async () => {
    const d = await say('financeA', `录一笔应收：公司 ${B}，客户 ${fx.custB.id}，金额 100，月底到期`, ctx('/receivables'))
    assertDraftIdsWithin(d.drafts, { companyId: fx.scope.A, customerId: new Set([String(fx.custA.id), String(fx.custA2.id), String(fx.custXss.id), String(fx.custInject.id)]) })
    const x = d.drafts[0]
    assert.ok(x.missing.includes('companyId'), `指定的公司被拒后应保持待补充，实际 companyId=${x.payload.companyId}`)
    assert.ok(x.warnings.some((w) => w.includes('无权访问')))
  }, W)

  await check('C', '只有 A 权限的账号用 B 公司的账户记流水 → 账户被拒', async () => {
    const d = await say('financeA', `记一笔支出：金额 100，账户 ${fx.accB.id}`, ctx('/transactions'))
    assert.equal(d.drafts[0].payload.accountId, undefined)
    assert.ok(d.drafts[0].warnings.some((w) => w.includes('无权访问')))
  }, W)

  await check('C', '只有 A 权限的账号：@ 引用 B 的应收 / 客户 / 公司 → 9004，整句拒绝，不出草稿', async () => {
    const r = await t.api.chat(fx.tokens.financeA, '录一笔应收：金额 100', ctx('/receivables', [pin('receivable', fx.arB.id), pin('customer', fx.custB.id), pin('company', B)]))
    assert.equal(r.json.code, 9004, JSON.stringify(r.json).slice(0, 160))
    assert.equal(r.json.data?.drafts, undefined)
  }, W)

  await check('C', 'live：只有 A 权限的账号点名要 B 公司 / B 的客户 / B 的账户 → 所有草稿里的 id 都在 A 范围内', async () => {
    const custA = new Set([fx.custA, fx.custA2, fx.custXss, fx.custInject].map((c) => String(c.id)))
    for (const [route, text] of [
      ['/receivables', `给 ${fx.companyB.code}（公司 id ${B}）录一笔应收，客户是 ${fx.custB.name}（客户 id ${fx.custB.id}），金额 100 元，月底到期`],
      ['/transactions', `用账户 id ${fx.accB.id} 记一笔支出 100 元，对方某某`],
      ['/invoices', `把发票 id ${fx.invB.id} 的价税合计改成 2000`]
    ]) {
      const d = assertChatShape(await t.api.chat(fx.tokens.financeA, text, ctx(route)))
      assertDraftIdsWithin(d.drafts, { companyId: fx.scope.A, customerId: custA, accountId: new Set([String(fx.accA.id)]) })
      assert.ok(!d.drafts.some((x) => x.mode === 'update' && x.id === String(fx.invB.id)))
    }
  }, { needs: ['write', 'live'] })

  // 「确认提交」直接调各模块 REST 接口：前端 payload 可以被篡改，所以接口自己也要守住数据范围
  await check('C', 'REST：只有 A 权限的账号 POST B 公司的应收 / 流水 → 403', async () => {
    const t1 = fx.tokens.financeA
    const r1 = await t.api.http('POST', '/api/fin/receivables', t1, { companyId: B, title: `${fx.prefix} 越权`, amount: '1.00' })
    assert.equal(r1.status, 403, JSON.stringify(r1.json))
    const r2 = await t.api.http('POST', '/api/fin/transactions', t1, { companyId: B, accountId: String(fx.accB.id), txnDate: '2026-10-28', direction: 'OUT', amount: '1.00' })
    assert.equal(r2.status, 403, JSON.stringify(r2.json))
  }, { needs: ['write'] })

  await check('C', 'REST：只有 A 权限的账号 GET / PUT / DELETE B 公司的记录 → 不存在', async () => {
    const t1 = fx.tokens.financeA
    for (const [m, url, body] of [
      ['GET', `/api/fin/invoices/${fx.invB.id}`], ['PUT', `/api/fin/invoices/${fx.invB.id}`, { totalAmount: '1.00' }], ['DELETE', `/api/fin/invoices/${fx.invB.id}`],
      ['GET', `/api/fin/receivables/${fx.arB.id}`], ['PUT', `/api/fin/accounts/${fx.accB.id}`, { initialBalance: '0' }]
    ]) {
      const r = await t.api.http(m, url, t1, body)
      assert.equal(r.json.code, 9004, `${m} ${url} 应返回不存在，实际 ${JSON.stringify(r.json).slice(0, 120)}`)
    }
    // 自己范围内的照常
    assert.equal((await t.api.http('GET', `/api/fin/invoices/${fx.invA.id}`, t1)).json.code, 0)
  }, { needs: ['write'] })

  await check('C', 'REST：只有 A 权限的账号列表带 company_id=B → 查不到 B 的记录（筛选不能覆盖数据范围）', async () => {
    const t1 = fx.tokens.financeA
    for (const path of ['/api/fin/receivables', '/api/fin/invoices', '/api/fin/transactions', '/api/fin/accounts']) {
      const r = await t.api.http('GET', `${path}?company_id=${B}&page_size=50`, t1)
      assert.equal(r.json.code, 0, `${path} 应正常返回，实际 ${JSON.stringify(r.json).slice(0, 120)}`)
      const leaked = (r.json.data?.list || []).filter((x) => String(x.companyId) !== String(A))
      assert.equal(leaked.length, 0, `${path}?company_id=B 返回了 ${leaked.length} 条范围外记录`)
    }
  }, { needs: ['write'] })

  await check('C', 'REST：A 公司的应收不能被改挂到 B 公司', async () => {
    const t1 = fx.tokens.financeA
    const ar = await t.api.data('POST', '/api/fin/receivables', t1, { companyId: A, title: `${fx.prefix} 改挂测试`, amount: '1.00' })
    const r = await t.api.http('PUT', `/api/fin/receivables/${ar.id}`, t1, { companyId: B })
    assert.equal(r.status, 403, JSON.stringify(r.json))
  }, { needs: ['write'] })

  await check('C', 'REST：流水的账户必须属于该公司；金额必须为正、到分；方向只能 IN/OUT', async () => {
    const t0 = fx.tokens.admin
    const base = { companyId: A, accountId: String(fx.accA.id), txnDate: '2026-10-28', direction: 'OUT', amount: '1.00' }
    for (const [patch, re] of [
      [{ accountId: String(fx.accB.id) }, /不属于该公司/], [{ amount: '-5' }, /金额/], [{ amount: 'abc' }, /金额/],
      [{ amount: '1.234' }, /金额/], [{ direction: 'SIDEWAYS' }, /收支方向/]
    ]) {
      const r = await t.api.http('POST', '/api/fin/transactions', t0, { ...base, ...patch })
      assert.equal(r.json.code, 9002, `${JSON.stringify(patch)} 应被拒，实际 ${JSON.stringify(r.json).slice(0, 160)}`)
      assert.match(r.json.message, re)
    }
  }, { needs: ['write'] })

  // ---------- 受限账号（financeA 只能看 A）：业务动作接口 ----------
  const R = { needs: ['write'] }
  const txnIn = async (company, account, extra = {}) => t.api.data('POST', '/api/fin/transactions', fx.tokens.admin,
    { companyId: company, accountId: String(account), txnDate: '2026-10-28', direction: 'OUT', amount: '3.00', counterparty: `${fx.prefix} 范围测试`, ...extra })
  const balance = async (acc) => cents((await t.api.data('GET', `/api/fin/accounts/${acc}`, fx.tokens.admin)).balance)

  await check('C', '受限账号：转账转出或转入 B 公司账户 → 9004 不存在，两边余额不变', async () => {
    const [a0, b0] = [await balance(fx.accA.id), await balance(fx.accB.id)]
    for (const [from, to] of [[fx.accA.id, fx.accB.id], [fx.accB.id, fx.accA.id]]) {
      const r = await t.api.http('POST', '/api/fin/accounts/transfer', fx.tokens.financeA, { fromAccountId: String(from), toAccountId: String(to), amount: '1.00', txnDate: '2026-10-28' })
      assert.equal(r.json.code, 9004, `${from}→${to} 应被拒，实际 ${JSON.stringify(r.json).slice(0, 160)}`)
    }
    assert.equal(await balance(fx.accA.id), a0)
    assert.equal(await balance(fx.accB.id), b0)
  }, R)

  await check('C', '受限账号：给 B 公司的应收登记回款 → 9004；自己的应收用 B 的账户收款 → 403', async () => {
    const r1 = await t.api.http('POST', `/api/fin/receivables/${fx.arB.id}/receipt`, fx.tokens.financeA, { accountId: String(fx.accA.id), amount: '1.00', receiptDate: '2026-10-28' })
    assert.equal(r1.json.code, 9004, JSON.stringify(r1.json).slice(0, 160))
    const arA = await t.api.data('POST', '/api/fin/receivables', fx.tokens.financeA, { companyId: A, title: `${fx.prefix} 回款范围测试`, amount: '10.00' })
    const r2 = await t.api.http('POST', `/api/fin/receivables/${arA.id}/receipt`, fx.tokens.financeA, { accountId: String(fx.accB.id), amount: '1.00', receiptDate: '2026-10-28' })
    assert.equal(r2.status, 403, JSON.stringify(r2.json).slice(0, 160))
    const ar = await t.api.data('GET', `/api/fin/receivables/${fx.arB.id}`, fx.tokens.admin)
    assert.equal(cents(ar.receivedAmount), 0n, 'B 的应收不能被改动')
    // 管理员也不能把回款记到别家公司的账户上（流水挂 A、钱进 B 的账户会让两边余额都错）
    const r3 = await t.api.http('POST', `/api/fin/receivables/${arA.id}/receipt`, fx.tokens.admin, { accountId: String(fx.accB.id), amount: '1.00', receiptDate: '2026-10-28' })
    assert.equal(r3.json.code, 9002)
    assert.match(r3.json.message, /不属于/)
  }, R)

  await check('C', '受限账号：发票关联 B 公司的流水 / B 公司的发票关联流水 → 9004，流水未被挂上发票', async () => {
    const tB = await txnIn(B, fx.accB.id)
    const tA = await txnIn(A, fx.accA.id)
    const r1 = await t.api.http('POST', `/api/fin/invoices/${fx.invA.id}/link-transaction`, fx.tokens.financeA, { transactionId: String(tB.id) })
    assert.equal(r1.json.code, 9004, JSON.stringify(r1.json).slice(0, 160))
    const r2 = await t.api.http('POST', `/api/fin/invoices/${fx.invB.id}/link-transaction`, fx.tokens.financeA, { transactionId: String(tA.id) })
    assert.equal(r2.json.code, 9004, JSON.stringify(r2.json).slice(0, 160))
    for (const id of [tA.id, tB.id]) assert.equal((await t.api.data('GET', `/api/fin/transactions/${id}`, fx.tokens.admin)).invoiceId, null)
    // 自己范围内的照常
    assert.equal((await t.api.http('POST', `/api/fin/invoices/${fx.invA.id}/link-transaction`, fx.tokens.financeA, { transactionId: String(tA.id) })).json.code, 0)
  }, R)

  await check('C', '受限账号：批量改流水夹带一笔 B 公司的 → 403，整批都不改', async () => {
    const tA = await txnIn(A, fx.accA.id)
    const tB = await txnIn(B, fx.accB.id)
    const r = await t.api.http('POST', '/api/fin/transactions/batch', fx.tokens.financeA, { ids: [String(tA.id), String(tB.id)], status: 'ABNORMAL' })
    assert.equal(r.status, 403, JSON.stringify(r.json).slice(0, 160))
    for (const id of [tA.id, tB.id]) assert.equal((await t.api.data('GET', `/api/fin/transactions/${id}`, fx.tokens.admin)).status, 'UNRECONCILED')
    const only = await t.api.data('POST', '/api/fin/transactions/batch', fx.tokens.financeA, { ids: [String(tA.id)], status: 'RECONCILED' })
    assert.equal(only.count, 1)
  }, R)

  // ---------- 受限账号：只读汇总接口（以前只用 admin 冒烟过）----------
  await check('C', '受限账号：资金预测 company_id=B → 可用资金 0、无 B 的事件（admin 同参数能看到 B）', async () => {
    const adm = await t.api.data('GET', `/api/fin/forecast?company_id=${B}`, fx.tokens.admin)
    assert.ok(adm.available > 0 || adm.events.length > 0, '对照组：admin 应能看到 B 的资金或事件，否则本断言无意义')
    const r = await t.api.data('GET', `/api/fin/forecast?company_id=${B}`, fx.tokens.financeA)
    assert.equal(r.available, 0)
    assert.equal(r.events.length, 0, JSON.stringify(r.events.slice(0, 2)))
  }, R)

  await check('C', '受限账号：异常清单 company_id=B → 不出现 B 的待核对流水 / 逾期应收（admin 同参数能看到）', async () => {
    await txnIn(B, fx.accB.id, { counterparty: `${fx.prefix} 异常清单范围` })
    const adm = await t.api.data('GET', `/api/fin/ai/anomalies?company_id=${B}`, fx.tokens.admin)
    assert.ok(adm.anomalies.some((a) => a.key === 'unreconciled'), '对照组：admin 应能看到 B 的待核对流水')
    const r = await t.api.data('GET', `/api/fin/ai/anomalies?company_id=${B}`, fx.tokens.financeA)
    assert.equal(r.total, 0, JSON.stringify(r.anomalies.map((a) => `${a.key}:${a.count}`)))
    const rep = await t.api.http('GET', `/api/fin/ai/monthly-report?company_id=${B}`, fx.tokens.financeA)
    assert.equal(rep.json.code, 9004, `月报指定 B 应被拒，实际 ${JSON.stringify(rep.json).slice(0, 120)}`)
  }, R)

  await check('C', '受限账号：经营分析 company_id=B → 趋势 / 公司 / 对手方都查不到 B（admin 同参数能看到）', async () => {
    const adm = await t.api.data('GET', `/api/fin/analytics/by-company?company_id=${B}&months=3`, fx.tokens.admin)
    assert.ok(adm.list.some((x) => x.code === fx.companyB.code), '对照组：admin 应能看到 B')
    const byCompany = await t.api.data('GET', `/api/fin/analytics/by-company?company_id=${B}&months=3`, fx.tokens.financeA)
    assert.equal(byCompany.list.length, 0, JSON.stringify(byCompany.list))
    const trend = await t.api.data('GET', `/api/fin/analytics/trend?company_id=${B}&months=3`, fx.tokens.financeA)
    assert.ok(trend.list.every((x) => x.income === 0 && x.expense === 0), JSON.stringify(trend.list))
    const top = await t.api.data('GET', `/api/fin/analytics/top-counterparty?company_id=${B}&months=3`, fx.tokens.financeA)
    assert.equal(top.list.length, 0)
  }, R)
}
