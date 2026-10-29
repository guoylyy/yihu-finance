// B. 修改模式：引用既有记录说「把金额改成 2000」→ mode:update + 正确 id；越权的 id 必须拒绝并给 warning
import { assert, ctx, pin, assertChatShape, cents } from './lib.mjs'

export default async function run(t) {
  const { check, fx } = t
  const W = { needs: ['write', 'stub'] }
  const say = async (who, text, c) => {
    const d = assertChatShape(await t.api.chat(fx.tokens[who], text, c))
    t.log('drafts:', JSON.stringify(d.drafts.map((x) => ({ kind: x.kind, mode: x.mode, id: x.id, payload: x.payload, warnings: x.warnings }))))
    return d
  }

  await check('B', '@ 发票 + 「把金额改成 2000」→ mode:update、id 正确、只带改动字段', async () => {
    const d = await say('admin', '把金额改成 2000', ctx('/invoices', [pin('invoice', fx.invA.id)]))
    assert.equal(d.drafts.length, 1)
    const x = d.drafts[0]
    assert.equal(x.kind, 'invoice')
    assert.equal(x.mode, 'update')
    assert.equal(x.id, String(fx.invA.id))
    assert.equal(x.payload.totalAmount, '2000.00')
    assert.deepEqual(Object.keys(x.payload).sort(), ['totalAmount'])
    assert.deepEqual(x.missing, [])
  }, W)

  await check('B', '修改发票只改价税合计 → 与库里原值核对，给出「不含税 + 税额 ≠ 价税合计」警告', async () => {
    const d = await say('admin', '把金额改成 2000', ctx('/invoices', [pin('invoice', fx.invA.id)]))
    assert.ok(d.drafts[0].warnings.some((w) => w.includes('修改后') && w.includes('≠')), JSON.stringify(d.drafts[0].warnings))
  }, W)

  await check('B', '@ 账户 + 「把金额改成 2000」→ update 草稿；按草稿 PUT 后余额 = 新期初 + 流水，对账差额 0', async () => {
    const d = await say('admin', '把金额改成 2000', ctx('/accounts', [pin('account', fx.accA.id)]))
    const x = d.drafts[0]
    assert.equal(x.kind, 'account')
    assert.equal(x.mode, 'update')
    assert.equal(x.id, String(fx.accA.id))
    assert.equal(x.payload.initialBalance, '2000.00')
    const after = await t.api.data('PUT', `/api/fin/accounts/${x.id}`, fx.tokens.admin, x.payload)
    assert.equal(cents(after.initialBalance), 200000n)
    const rec = await t.api.data('GET', `/api/fin/accounts/${x.id}/reconcile`, fx.tokens.admin)
    assert.equal(rec.diff, 0, `对账差额 ${rec.diff}`)
    return `余额 ${rec.recordedBalance}`
  }, W)

  await check('B', '只看 A 公司的财务说「把 #<B 公司发票> 改成 2000」→ 不出 update 草稿，warning 说明无权', async () => {
    const d = await say('financeA', `把发票 #${fx.invB.id} 的金额改成 2000`, ctx('/invoices'))
    for (const x of d.drafts) {
      assert.notEqual(x.mode, 'update')
      assert.notEqual(x.id, String(fx.invB.id))
    }
    assert.ok(d.drafts.length && d.drafts[0].warnings.some((w) => w.includes('不存在或无权访问')), JSON.stringify(d.drafts.map((x) => x.warnings)))
  }, W)

  await check('B', '只看 A 公司的财务 @ 了 B 公司的发票 → 引用被服务端剔除，不出 update 草稿', async () => {
    const d = await say('financeA', '把金额改成 2000', ctx('/invoices', [pin('invoice', fx.invB.id)]))
    assert.ok(!d.drafts.some((x) => x.mode === 'update'), JSON.stringify(d.drafts))
  }, W)

  await check('B', '修改不存在的 id → 不出 update 草稿 + warning', async () => {
    const d = await say('admin', '把发票 #999999999999 的金额改成 2000', ctx('/invoices'))
    assert.ok(!d.drafts.some((x) => x.mode === 'update'))
    assert.ok(d.drafts[0]?.warnings.some((w) => w.includes('不存在或无权访问')))
  }, W)
}
