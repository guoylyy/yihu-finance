// D. 权限矩阵：ADMIN / FINANCE / MANAGER / VIEWER 能用助手，STAFF 403；界面入口用无头浏览器断言 DOM
import { assert, ctx, pin, assertChatShape } from './lib.mjs'
import { launchBrowser, sendInAssistant } from './browser.mjs'

const CAN_CHAT = { ADMIN: true, FINANCE: true, MANAGER: true, VIEWER: true, STAFF: false }
const CAN_SUBMIT_RECEIVABLE = { ADMIN: true, FINANCE: true, MANAGER: false, VIEWER: false }

export default async function run(t) {
  const { check, fx } = t

  for (const role of ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER']) {
    await check('D', `${role} 调 /assistant/chat 与 /status → 200`, async () => {
      const tok = fx.tokens[role.toLowerCase()]
      const s = await t.api.http('GET', '/api/fin/assistant/status', tok)
      assert.equal(s.status, 200)
      assert.equal(s.json.data.available, true)
      const r = await t.api.chat(tok, `录一笔应收：客户 ${fx.custA.id}，金额 100，月底到期`)
      assertChatShape(r)
    }, { needs: ['write'] })
  }
  await check('D', 'STAFF 调 /assistant/chat 与 /status → 403', async () => {
    const r = await t.api.chat(fx.tokens.staff, '录一笔应收：金额 100')
    assert.equal(r.status, 403)
    assert.equal(r.json.code, 9003)
    assert.equal((await t.api.http('GET', '/api/fin/assistant/status', fx.tokens.staff)).status, 403)
  }, { needs: ['write'] })
  await check('D', '未登录 → 401', async () => {
    assert.equal((await t.api.chat(null, 'hi')).status, 401)
    assert.equal((await t.api.chat('not-a-jwt', 'hi')).status, 401)
  })
  await check('D', '助手只出草稿，写入仍按模块权限：VIEWER / MANAGER 拿草稿去 POST → 403', async () => {
    for (const who of ['viewer', 'manager']) {
      const d = assertChatShape(await t.api.chat(fx.tokens[who], `录一笔应收：客户 ${fx.custA.id}，金额 100，月底到期`))
      const r = await t.api.http('POST', '/api/fin/receivables', fx.tokens[who], d.drafts[0].payload)
      assert.equal(r.status, 403, `${who} 不该能提交`)
    }
  }, { needs: ['write'] })

  // 只读模式：只能验当前 token 自己这个角色
  await check('D', '当前 token 的角色与助手可用性一致（只读模式）', async () => {
    const role = t.me.role
    const r = await t.api.http('GET', '/api/fin/assistant/status', t.token)
    assert.equal(r.status === 200, CAN_CHAT[role] ?? false, `${role} → HTTP ${r.status}`)
    return `${role} → HTTP ${r.status}`
  }, { needs: ['readonly'] })

  // ---------- 界面入口（无头 Chrome） ----------
  // 规则：AdminLayout 里 v-if="can('finance.view')" 才渲染助手按钮和抽屉；草稿卡的「确认提交」再按 <模块>.manage 置灰
  await check('D', 'DOM：ADMIN/FINANCE/MANAGER/VIEWER 有助手抽屉，STAFF 没有；无 manage 权限的「确认提交」置灰', async () => {
    const b = await launchBrowser(t.opts.chrome)
    const rows = []
    try {
      for (const role of ['ADMIN', 'FINANCE', 'MANAGER', 'VIEWER', 'STAFF']) {
        const key = role.toLowerCase()
        await b.openAs(t.opts.ui, { token: fx.tokens[key], user: fx.users[key] }, '/receivables')
        if (CAN_CHAT[role]) {
          await b.waitFor(`!!document.querySelector('.assistant-pane')`, { what: `${role} 的助手抽屉` })
          await sendInAssistant(b, `录一笔应收：客户 ${fx.custA.id}，金额 100，月底到期`)
          await b.waitFor(`!!document.querySelector('.assistant-pane .draft .draft-actions')`, { what: `${role} 的草稿卡` })
          const disabled = await b.evaluate(`document.querySelector('.assistant-pane .draft .draft-actions .el-button--primary').disabled`)
          assert.equal(!disabled, CAN_SUBMIT_RECEIVABLE[role], `${role} 的「确认提交」${disabled ? '置灰' : '可点'}，不符合权限`)
          rows.push(`${role}:抽屉✓/提交${disabled ? '灰' : '可点'}`)
        } else {
          await new Promise((r) => setTimeout(r, 1500))
          const n = await b.evaluate(`document.querySelectorAll('.assistant-pane').length`)
          assert.equal(n, 0, 'STAFF 不应看到助手抽屉')
          rows.push(`${role}:无抽屉`)
        }
      }
    } finally { await b.close() }
    return rows.join(' ')
  }, { needs: ['write', 'stub', 'browser'] })
}
