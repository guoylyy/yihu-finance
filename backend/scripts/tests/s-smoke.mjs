// S. 冒烟：所有模式都跑（含 --read-only 的生产冒烟），只调接口、不写业务数据
import { assert, ctx, assertChatShape } from './lib.mjs'

const TOTALS = [['invoice', '/api/fin/invoices'], ['receivable', '/api/fin/receivables'], ['transaction', '/api/fin/transactions'], ['account', '/api/fin/accounts']]

export default async function run(t) {
  const { check } = t
  const token = () => (t.write ? t.fx.tokens.admin : t.token)

  await check('S', '/api/health 正常', async () => {
    const r = await t.api.http('GET', '/api/health')
    assert.equal(r.json.code, 0)
  })
  await check('S', `/assistant/status：available=true 且 stub=${t.mode === 'stub'}`, async () => {
    const s = await t.api.data('GET', '/api/fin/assistant/status', token())
    assert.equal(s.available, true, s.reason)
    assert.equal(s.stub, t.mode === 'stub')
    assert.deepEqual([...s.draftRoutes].sort(), ['/accounts', '/invoices', '/receivables', '/transactions'])
  })
  await check('S', '非录入页面（/dashboard）只问答、不出草稿', async () => {
    const d = assertChatShape(await t.api.chat(token(), '录一笔应收：金额 128000，月底到期', ctx('/dashboard')))
    assert.equal(d.drafts.length, 0)
  })
  await check('S', '四个录入页面各说一句：结构合法，且业务表行数不变（助手不写库）', async () => {
    const totals = async () => {
      const o = {}
      for (const [k, url] of TOTALS) o[k] = (await t.api.data('GET', `${url}?page_size=1`, token())).total
      return o
    }
    const before = await totals()
    for (const [route, text] of [['/accounts', '新增账户：叫 冒烟测试户，期初 0'], ['/receivables', '录一笔应收：金额 100，月底到期'],
      ['/invoices', '录一张进项发票：发票号 SMOKE0001，金额 106，税额 6'], ['/transactions', '记一笔支出：金额 1，对方 冒烟']]) {
      assertChatShape(await t.api.chat(token(), text, ctx(route)))
    }
    assert.deepEqual(await totals(), before)
  })
}
