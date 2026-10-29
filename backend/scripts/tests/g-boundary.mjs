// G. 边界值：金额 / 日期 / 输入长度。只读模式也能跑（只调 chat，不写业务数据）
import dayjs from 'dayjs'
import { assert, ctx, assertChatShape } from './lib.mjs'

export default async function run(t) {
  const { check } = t
  const token = () => (t.write ? t.fx.tokens.admin : t.token)
  const draftOf = async (text, route = '/receivables') => {
    const d = assertChatShape(await t.api.chat(token(), text, ctx(route)))
    assert.equal(d.drafts.length, 1, `应有 1 份草稿：${d.reply}`)
    t.log(text, '→', JSON.stringify(d.drafts[0].payload), d.drafts[0].warnings)
    return d.drafts[0]
  }
  const S = { needs: ['stub'] }

  // ---------- 金额 ----------
  const AMOUNTS = [
    ['0', null, /必须大于 0/],
    ['-0.01', null, /不能为负数/],
    ['12.345', null, /两位小数/],
    ['1e15', null, /不是有效金额/],                  // 科学计数法不认（Number() 认，财务上不认）
    ['0x10', null, /不是有效金额/],                  // 修复前被当成 16
    ['１２８０００', '128000.00', null],              // 全角数字：归一成半角（修复前判非法）
    ['128,000.5', '128000.50', null],
    ['¥3200元', '3200.00', null],
    ['999999999999999.99', '999999999999999.99', null], // 修复前经 Number() 变成 1000000000000000.00（丢分）
    ['9999999999999999.99', '9999999999999999.99', null], // Decimal(18,2) 上限
    ['10000000000000000', null, /超出金额范围/]
  ]
  for (const [raw, want, warn] of AMOUNTS) {
    await check('G', `金额「${raw}」→ ${want ?? '拒绝'}`, async () => {
      const x = await draftOf(`录一笔应收：金额 ${raw}，月底到期`)
      if (want) {
        assert.equal(x.payload.amount, want)
        assert.ok(!x.missing.includes('amount'))
      } else {
        assert.equal(x.payload.amount, undefined)
        assert.ok(x.missing.includes('amount'))
        assert.ok(x.warnings.some((w) => warn.test(w)), `warnings 应匹配 ${warn}：${JSON.stringify(x.warnings)}`)
      }
    }, S)
  }
  await check('G', '金额为空（「金额 ，」）→ missing，不报非法', async () => {
    const x = await draftOf('录一笔应收：金额 ，月底到期')
    assert.ok(x.missing.includes('amount'))
  }, S)

  // ---------- 日期 ----------
  await check('G', '日期 2026-02-30 → warnings，payload 不带非法日期', async () => {
    const x = await draftOf('录一笔应收：金额 100，2026-02-30 到期')
    assert.equal(x.payload.expectDate, undefined)
    assert.ok(x.warnings.some((w) => w.includes('预计收款日')), JSON.stringify(x.warnings))
  }, S)
  await check('G', '日期「下个月底」→ 下月最后一天', async () => {
    const x = await draftOf('录一笔应收：金额 100，下个月底到期')
    assert.equal(x.payload.expectDate, dayjs().add(1, 'month').endOf('month').format('YYYY-MM-DD'))
  }, S)
  await check('G', '日期「T+30」→ 不编造日期（payload 不带或为合法日期）', async () => {
    const x = await draftOf('录一笔应收：金额 100，T+30 到期')
    if (x.payload.expectDate != null) assert.match(x.payload.expectDate, /^\d{4}-\d{2}-\d{2}$/)
    return `expectDate=${x.payload.expectDate ?? '（未填）'}`
  }, S)
  await check('G', '日期 2026/10/31 → 2026-10-31', async () => {
    const x = await draftOf('录一笔应收：金额 100，2026/10/31 到期')
    assert.equal(x.payload.expectDate, '2026-10-31')
  }, S)
  await check('G', '日期 1999-12-31 / 2101-01-01 → 超出合理范围被拒', async () => {
    for (const d of ['1999-12-31', '2101-01-01']) {
      const x = await draftOf(`录一笔应收：金额 100，${d} 到期`)
      assert.equal(x.payload.expectDate, undefined, d)
    }
  }, S)

  // ---------- 输入 ----------
  await check('G', '空消息 → 9002「请输入要说的话」，不 500', async () => {
    const r = await t.api.http('POST', '/api/fin/assistant/chat', token(), { messages: [{ role: 'user', content: '' }], context: {} })
    assert.equal(r.status, 200)
    assert.equal(r.json.code, 9002)
  })
  await check('G', '只有空格 / 换行 → 9002', async () => {
    const r = await t.api.http('POST', '/api/fin/assistant/chat', token(), { messages: [{ role: 'user', content: '   \n\t ' }], context: {} })
    assert.equal(r.json.code, 9002)
  })
  await check('G', 'messages 缺失 / 不是数组 / content 不是字符串 → 9002，不 500', async () => {
    for (const body of [{}, { messages: 'hi' }, { messages: [{ role: 'user', content: { x: 1 } }] }, { messages: [{ role: 'assistant', content: 'hi' }] }, null]) {
      const r = await t.api.http('POST', '/api/fin/assistant/chat', token(), body)
      assert.ok(r.status < 500, `${JSON.stringify(body)} → HTTP ${r.status}`)
      assert.equal(r.json.code, 9002, JSON.stringify(body))
    }
  })
  await check('G', '10k 字长消息 → 正常返回（服务端截断到 4000 字），不 500', async () => {
    const long = '录一笔应收：金额 100，月底到期。' + '很长的备注'.repeat(2000)
    const r = await t.api.chat(token(), long)
    assertChatShape(r)
    return `${long.length} 字，${Math.round(r.ms)} ms`
  })
  await check('G', '30 条历史消息 + context 里塞垃圾字段 → 正常返回', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 句` }))
    messages.push({ role: 'user', content: '录一笔应收：金额 100' })
    const r = await t.api.http('POST', '/api/fin/assistant/chat', token(), {
      messages, context: { route: '/receivables'.repeat(50), pinned: 'oops', filters: { company_id: "1' OR '1'='1" }, extra: { a: [1, 2, 3] } }
    })
    assertChatShape(r)
  })
}
