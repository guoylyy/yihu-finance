// H. 幂等与并发：草稿「确认提交」去重（同一草稿 / 同内容 60 秒内）、提交状态持久化、业务编号并发不撞号；并发 chat 不串上下文
import { assert, ctx, pin, assertChatShape, assertDraftIdsWithin, cents } from './lib.mjs'
import { launchBrowser, sendInAssistant, STORE } from './browser.mjs'

export default async function run(t) {
  const { check, fx } = t
  const W = { needs: ['write', 'stub'] }
  const A = String(fx?.companyA?.id)
  const draft = async (text, c, who = 'admin') => assertChatShape(await t.api.chat(fx.tokens[who], text, c)).drafts[0]
  // 「确认提交」= POST /assistant/drafts/:id/submit（服务端代调模块接口 + 去重）
  const submit = (d, who = 'admin', body = {}) => t.api.http('POST', `/api/fin/assistant/drafts/${d.draftId}/submit`, fx.tokens[who], body)
  const seqOf = (code) => Number(code.split('-').pop())
  const assertConsecutive = (codes) => {
    const head = codes[0].replace(/\d+$/, '')
    assert.ok(codes.every((c) => c.startsWith(head)), `编号前缀不一致：${codes}`)
    const seqs = codes.map(seqOf).sort((a, b) => a - b)
    for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, `编号不连续：${codes}`)
  }

  await check('H', 'chat 返回的每张草稿都带 draftId（已落库）', async () => {
    const x = await draft(`录一笔应收：客户 ${fx.custA.id}，金额 4320，月底到期`, ctx('/receivables'))
    assert.match(String(x.draftId), /^[1-9]\d*$/)
    const g = await t.api.data('GET', `/api/fin/assistant/drafts/${x.draftId}`, fx.tokens.admin)
    assert.equal(g.submitted, false)
    assert.equal(g.submittedAt, null)
    assert.equal(g.kind, 'receivable')
  }, W)

  await check('H', '同一应收草稿顺序提交两次 → 只产生 1 条，第二次 duplicate: true 且 id / 编号相同', async () => {
    const x = await draft(`录一笔应收：客户 ${fx.custA.id}，金额 4321，月底到期`, ctx('/receivables'))
    const r1 = await submit(x)
    const r2 = await submit(x)
    assert.equal(r1.json.code, 0, JSON.stringify(r1.json))
    assert.equal(r2.json.code, 0, JSON.stringify(r2.json))
    const a = r1.json.data
    const b = r2.json.data
    assert.equal(a.duplicate, false)
    assert.match(a.code, /^AR-\d{4}-\d{4}$/)
    assert.equal(b.duplicate, true)
    assert.equal(b.id, a.id)
    assert.equal(b.code, a.code)
    assert.equal(b.originalId, a.id)
    const n = await t.db.receivable.count({ where: { companyId: BigInt(A), amount: '4321', deletedAt: null } })
    assert.equal(n, 1, `库里应只有 1 笔 4321 的应收，实际 ${n}`)
    t.notes.push(`H-应收：同一草稿顺序提交两次 → 1 笔（${a.code}），第二次 duplicate=true、id 相同`)
    return `${a.id}/${a.code}/dup=${a.duplicate} → ${b.id}/${b.code}/dup=${b.duplicate}`
  }, W)

  await check('H', '同一应收草稿并发提交两次 → 只产生 1 条，两次返回同一个 id', async () => {
    const x = await draft(`录一笔应收：客户 ${fx.custA.id}，金额 4323，月底到期`, ctx('/receivables'))
    const rs = await Promise.all([1, 2].map(() => submit(x)))
    for (const r of rs) assert.equal(r.json.code, 0, JSON.stringify(r.json))
    const [a, b] = rs.map((r) => r.json.data)
    assert.equal(a.id, b.id)
    assert.equal(a.code, b.code)
    assert.deepEqual([a.duplicate, b.duplicate].sort(), [false, true])
    const n = await t.db.receivable.count({ where: { companyId: BigInt(A), amount: '4323', deletedAt: null } })
    assert.equal(n, 1, `库里应只有 1 笔 4323 的应收，实际 ${n}`)
    return `${a.code}，duplicate=${a.duplicate}/${b.duplicate}`
  }, W)

  await check('H', '同一流水草稿提交两次 → 只记 1 笔，余额只扣一次', async () => {
    const acc0 = await t.api.data('GET', `/api/fin/accounts/${fx.accA.id}`, fx.tokens.admin)
    const x = await draft('记一笔支出：金额 11.11，对方 重复提交测试', ctx('/transactions', [pin('account', fx.accA.id)]))
    const a = await t.api.data('POST', `/api/fin/assistant/drafts/${x.draftId}/submit`, fx.tokens.admin, {})
    const b = await t.api.data('POST', `/api/fin/assistant/drafts/${x.draftId}/submit`, fx.tokens.admin, {})
    assert.equal(b.duplicate, true)
    assert.equal(b.id, a.id)
    const acc1 = await t.api.data('GET', `/api/fin/accounts/${fx.accA.id}`, fx.tokens.admin)
    assert.equal(cents(acc1.balance) - cents(acc0.balance), -1111n)
    const n = await t.db.transaction.count({ where: { accountId: BigInt(fx.accA.id), counterparty: '重复提交测试', deletedAt: null } })
    assert.equal(n, 1)
    t.notes.push(`H-流水：同一草稿提交两次 → 1 笔（${a.code}），余额变动 -11.11`)
  }, W)

  await check('H', '内容相同的另一张草稿 60 秒内提交 → duplicate: true，返回第一次的 id 与编号', async () => {
    const text = `录一笔应收：客户 ${fx.custA.id}，金额 4324，月底到期`
    const x1 = await draft(text, ctx('/receivables'))
    const x2 = await draft(text, ctx('/receivables'))
    assert.notEqual(x1.draftId, x2.draftId)
    const a = await t.api.data('POST', `/api/fin/assistant/drafts/${x1.draftId}/submit`, fx.tokens.admin, {})
    const b = await t.api.data('POST', `/api/fin/assistant/drafts/${x2.draftId}/submit`, fx.tokens.admin, {})
    assert.equal(a.duplicate, false)
    assert.equal(b.duplicate, true)
    assert.equal(b.originalId, a.id)
    assert.equal(b.code, a.code)
    assert.equal(b.originalDraftId, x1.draftId)
    // 第二张草稿也被标成已提交（抽屉重开不能再点）
    const g = await t.api.data('GET', `/api/fin/assistant/drafts/${x2.draftId}`, fx.tokens.admin)
    assert.equal(g.submitted, true)
    assert.equal(g.id, a.id)
    const n = await t.db.receivable.count({ where: { companyId: BigInt(A), amount: '4324', deletedAt: null } })
    assert.equal(n, 1)
  }, W)

  await check('H', '内容相同但已过 60 秒窗口 → 视为新的一笔', async () => {
    const text = `录一笔应收：客户 ${fx.custA.id}，金额 4325，月底到期`
    const x1 = await draft(text, ctx('/receivables'))
    const x2 = await draft(text, ctx('/receivables'))
    const a = await t.api.data('POST', `/api/fin/assistant/drafts/${x1.draftId}/submit`, fx.tokens.admin, {})
    // 直接把指纹的认领时间往前拨 61 秒，模拟过了窗口
    await t.db.assistantSubmission.updateMany({ where: { draftId: BigInt(x1.draftId) }, data: { claimedAt: new Date(Date.now() - 61_000) } })
    const b = await t.api.data('POST', `/api/fin/assistant/drafts/${x2.draftId}/submit`, fx.tokens.admin, {})
    assert.equal(b.duplicate, false)
    assert.notEqual(b.id, a.id)
    const n = await t.db.receivable.count({ where: { companyId: BigInt(A), amount: '4325', deletedAt: null } })
    assert.equal(n, 2)
  }, { needs: ['write', 'stub', 'db'] })

  await check('H', '抽屉状态：提交后 GET 草稿 → submitted + submittedAt + 业务 id / 编号；批量接口同样；别人看不到', async () => {
    const x = await draft(`录一笔应收：客户 ${fx.custA.id}，金额 4326，月底到期`, ctx('/receivables'))
    const s = await t.api.data('POST', `/api/fin/assistant/drafts/${x.draftId}/submit`, fx.tokens.admin, {})
    const g = await t.api.data('GET', `/api/fin/assistant/drafts/${x.draftId}`, fx.tokens.admin)
    assert.equal(g.submitted, true)
    assert.ok(g.submittedAt && !Number.isNaN(Date.parse(g.submittedAt)), `submittedAt=${g.submittedAt}`)
    assert.equal(g.id, s.id)
    assert.equal(g.code, s.code)
    const list = (await t.api.data('GET', `/api/fin/assistant/drafts?ids=${x.draftId},99999999999`, fx.tokens.admin)).list
    assert.equal(list.length, 1)
    assert.equal(list[0].id, s.id)
    const other = await t.api.http('GET', `/api/fin/assistant/drafts/${x.draftId}`, fx.tokens.finance)
    assert.equal(other.json.code, 9004, '别人的草稿应查不到')
    const steal = await t.api.http('POST', `/api/fin/assistant/drafts/${x.draftId}/submit`, fx.tokens.finance, {})
    assert.equal(steal.json.code, 9004, '别人的草稿不能代为提交')
    return `submittedAt=${g.submittedAt} id=${g.id} code=${g.code}`
  }, W)

  await check('H', '提交被业务校验拒（篡改成别家公司 → 403）→ 不算已提交，改回后可正常提交', async () => {
    const x = await draft('记一笔支出：金额 7.77，对方 越权后重试', ctx('/transactions', [pin('account', fx.accA.id)]), 'financeA')
    const bad = await submit(x, 'financeA', { payload: { ...x.payload, companyId: String(fx.companyB.id), accountId: String(fx.accB.id) } })
    assert.equal(bad.status, 403, JSON.stringify(bad.json))
    const g = await t.api.data('GET', `/api/fin/assistant/drafts/${x.draftId}`, fx.tokens.financeA)
    assert.equal(g.submitted, false)
    const ok = await submit(x, 'financeA')
    assert.equal(ok.json.code, 0, JSON.stringify(ok.json))
    assert.equal(ok.json.data.duplicate, false)
    assert.equal(String(ok.json.data.record.companyId), A)
  }, W)

  await check('H', '发票草稿：同一张提交两次 → 第二次幂等返回；另录同号发票仍被发票号查重挡下', async () => {
    const x = await draft(`录一张进项发票：发票号 ${fx.invoiceNoBase}D1，金额 1060，税额 60`, ctx('/invoices', [pin('company', fx.companyA.id)]))
    const a = await submit(x)
    const b = await submit(x)
    assert.equal(a.json.code, 0, JSON.stringify(a.json))
    assert.equal(b.json.data.duplicate, true)
    assert.equal(b.json.data.code, `${fx.invoiceNoBase}D1`)
    const c = await t.api.http('POST', '/api/fin/invoices', fx.tokens.admin, x.payload)
    assert.equal(c.json.code, 9002)
    assert.match(c.json.message, /已存在/)
  }, W)

  await check('H', '并发 8 笔流水同时 POST → 全部成功，编号唯一且连续', async () => {
    const body = { companyId: A, accountId: String(fx.accA.id), txnDate: '2026-10-28', direction: 'OUT', amount: '1.01', counterparty: '并发编号测试' }
    const rs = await Promise.all(Array.from({ length: 8 }, () => t.api.http('POST', '/api/fin/transactions', fx.tokens.admin, body)))
    const fails = rs.filter((r) => r.json.code !== 0).map((r) => r.json.message)
    assert.equal(fails.length, 0, `失败 ${fails.length} 笔：${fails[0]}`)
    const codes = rs.map((r) => r.json.data.code)
    assert.equal(new Set(codes).size, 8, `出现重复编号 ${codes}`)
    assertConsecutive(codes)
    t.notes.push(`H-流水并发 8 笔：全部成功，编号 ${[...codes].sort().join('、')}`)
    return [...codes].sort().join(' ')
  }, { needs: ['write'] })

  await check('H', '并发 4 笔应收 + 4 次转账同时提交 → 全部成功，应收编号连续；转账两腿编号互不重复', async () => {
    const ars = Array.from({ length: 4 }, (_, i) => t.api.http('POST', '/api/fin/receivables', fx.tokens.admin, { companyId: A, title: `${fx.prefix} 并发应收${i}`, amount: '9.00' }))
    const tfs = Array.from({ length: 4 }, () => t.api.http('POST', '/api/fin/accounts/transfer', fx.tokens.admin, { fromAccountId: String(fx.accA.id), toAccountId: String(fx.accB.id), amount: '0.50', txnDate: '2026-10-28' }))
    const rs = await Promise.all([...ars, ...tfs])
    const fails = rs.filter((r) => r.json.code !== 0).map((r) => r.json.message)
    assert.equal(fails.length, 0, `失败：${fails[0]}`)
    const arCodes = rs.slice(0, 4).map((r) => r.json.data.code)
    assertConsecutive(arCodes)
    const legs = rs.slice(4).flatMap((r) => [r.json.data.outTxn.code, r.json.data.inTxn.code])
    assert.equal(new Set(legs).size, 8, `转账编号重复 ${legs}`)
    return `应收 ${arCodes.join(' ')}`
  }, { needs: ['write'] })

  await check('H', '数据库约束报错 → 中文可读错误，不带 Prisma 原文', async () => {
    const r = await t.api.http('POST', '/api/fin/transactions', fx.tokens.admin, { companyId: A, accountId: String(fx.accA.id), txnDate: '2026-10-28', direction: 'OUT', amount: '1.00', categoryId: '999999999999' })
    assert.notEqual(r.json.code, 0)
    assert.ok(!/prisma|invocation|constraint|`/i.test(r.json.message), `报错里不应有数据库原文：${r.json.message}`)
    return r.json.message
  }, { needs: ['write'] })

  // ---------- 界面：提交后关掉抽屉重开仍是「已提交 · 编号」；同内容另一张草稿提示「刚才已提交过」 ----------
  await check('H', 'DOM：确认提交 → 「已提交 · 编号」；抽屉关掉重开、清掉前端状态后按 draftId 从服务端拉回；同内容再提交提示「刚才已提交过」', async () => {
    const b = await launchBrowser(t.opts.chrome)
    const text = `录一笔应收：客户 ${fx.custA.id}，金额 4327，月底到期`
    const lastCard = `[...document.querySelectorAll('.assistant-pane .draft')].at(-1)`
    const submitLast = async () => {
      await b.waitFor(`!${lastCard}.querySelector('.draft-actions .el-button--primary').disabled`, { what: '确认提交可点' })
      await b.evaluate(`${lastCard}.querySelector('.draft-actions .el-button--primary').click(), true`)
      await b.waitFor(`!!document.querySelector('.el-message-box .el-button--primary')`, { what: '确认框' })
      await b.evaluate(`document.querySelector('.el-message-box .el-button--primary').click(), true`)
    }
    const reopen = async () => {
      await b.evaluate(`${STORE}.open = false, true`)
      await b.waitFor(`!document.querySelector('.assistant-pane')`, { what: '抽屉关闭' })
      await b.evaluate(`${STORE}.open = true, true`)
      await b.waitFor(`!!document.querySelector('.assistant-pane .draft')`, { what: '抽屉重开' })
    }
    const doneState = `(() => { const c = ${lastCard}; const tag = c.querySelector('.done-tag'); return tag && /已提交 · 编号 AR-\\d{4}-\\d{4}/.test(tag.textContent) && c.querySelector('.draft-actions .el-button--primary').disabled ? tag.textContent.trim() : null })()`
    try {
      await b.openAs(t.opts.ui, { token: fx.tokens.admin, user: fx.users.admin }, '/receivables')
      await sendInAssistant(b, text)
      await submitLast()
      const label = await b.waitFor(doneState, { what: '提交后显示「已提交 · 编号」且按钮置灰' })
      await reopen()
      assert.equal(await b.waitFor(doneState, { what: '重开后仍是已提交' }), label)
      // 模拟旧问题：前端状态丢了（组件重建 / store 被清），只剩 draftId → 必须从服务端拉回
      await b.evaluate(`${STORE}.messages.forEach((m) => (m.drafts || []).forEach((d) => { delete d.submission })), true`)
      await reopen()
      assert.equal(await b.waitFor(doneState, { what: '清掉前端状态后从服务端拉回已提交' }), label)
      // 同内容的另一张草稿
      await sendInAssistant(b, text)
      await submitLast()
      const msg = await b.waitFor(`document.querySelector('.el-message--warning')?.textContent.trim()`, { what: '重复提交提示' })
      assert.match(msg, /这笔刚才已提交过（编号 AR-\d{4}-\d{4}）/)
      assert.ok(msg.includes(label.replace('已提交 · 编号 ', '')), `提示里的编号应与第一次一致：${msg} / ${label}`)
      const n = await t.db.receivable.count({ where: { companyId: BigInt(A), amount: '4327', deletedAt: null } })
      assert.equal(n, 1)
      return `${label}；${msg}`
    } finally { await b.close() }
  }, { needs: ['write', 'stub', 'browser', 'db'] })

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
      ? t.api.chat(fx.tokens.financeA, `录一笔应收：公司 ${fx.companyB.id}，金额 ${100 + i}，月底到期`, ctx('/receivables')).then((r) => ['A', i, r])
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
