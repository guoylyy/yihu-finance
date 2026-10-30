// v1.3.0 复现脚本：并发 8 笔流水的编号、同一草稿提交两次的幂等返回
//   node scripts/repro-v130.mjs [--base http://127.0.0.1:3010]
// 需要后端以 FIN_LLM_STUB=1 启动、能直连同一个库（跑完硬删除自建的 E2E- 测试公司与用户）
import { parseOptions, makeHttp, openDb, purge, residual } from './tests/lib.mjs'
import { createFixtures } from './tests/fixtures.mjs'

const opts = parseOptions(process.argv.slice(2))
const api = makeHttp(opts.base)
const { db, reason } = await openDb()
if (!db) { console.error(`连不上数据库：${reason}`); process.exit(2) }

const prefix = `E2E-${Date.now().toString(36)}`
const track = { companyIds: [], userIds: [] }
let failed = false
try {
  const boot = (await api.login(opts.user, opts.pass)).token
  const fx = await createFixtures(api, boot, prefix, track)
  const tok = fx.tokens.admin
  console.log(`后端 ${opts.base}，测试公司 ${fx.companyA.code}\n`)

  // ---- 3. 并发 8 笔流水 ----
  const body = { companyId: String(fx.companyA.id), accountId: String(fx.accA.id), txnDate: '2026-10-28', direction: 'OUT', amount: '1.01', counterparty: '并发复现' }
  const rs = await Promise.all(Array.from({ length: 8 }, () => api.http('POST', '/api/fin/transactions', tok, body)))
  const okCodes = rs.filter((r) => r.json.code === 0).map((r) => r.json.data.code).sort()
  const errs = rs.filter((r) => r.json.code !== 0).map((r) => `HTTP ${r.status} code ${r.json.code}：${String(r.json.message).split('\n')[0]}`)
  const seqs = okCodes.map((c) => Number(c.split('-').pop()))
  const consecutive = seqs.every((n, i) => i === 0 || n === seqs[i - 1] + 1)
  console.log('【3】并发 8 笔 POST /api/fin/transactions')
  console.log(`  成功 ${okCodes.length} / 失败 ${errs.length}`)
  console.log(`  编号：${okCodes.join(', ')}`)
  console.log(`  去重后 ${new Set(okCodes).size} 个，${consecutive ? '连续' : '不连续'}`)
  if (errs.length) console.log(`  失败原因：${errs.join(' | ')}`)
  failed ||= okCodes.length !== 8 || new Set(okCodes).size !== 8 || !consecutive

  // ---- 4. 同一草稿提交两次 ----
  const chat = await api.chat(tok, `录一笔应收：客户 ${fx.custA.id}，金额 4321，月底到期`, { route: '/receivables', pinned: [] })
  const draft = chat.json.data.drafts[0]
  console.log(`\n【4】同一张草稿（draftId=${draft.draftId}）POST /api/fin/assistant/drafts/:id/submit 两次`)
  const show = (n, r) => {
    const d = r.json.data || {}
    console.log(`  第 ${n} 次：HTTP ${r.status} code ${r.json.code} → id=${d.id} code=${d.code} duplicate=${d.duplicate} originalId=${d.originalId}`)
    return d
  }
  const a = show(1, await api.http('POST', `/api/fin/assistant/drafts/${draft.draftId}/submit`, tok, {}))
  const b = show(2, await api.http('POST', `/api/fin/assistant/drafts/${draft.draftId}/submit`, tok, {}))
  const n = await db.receivable.count({ where: { companyId: BigInt(fx.companyA.id), amount: '4321', deletedAt: null } })
  console.log(`  库里金额 4321 的应收：${n} 笔`)
  const g = (await api.http('GET', `/api/fin/assistant/drafts/${draft.draftId}`, tok)).json.data
  console.log(`  GET 草稿：submitted=${g?.submitted} submittedAt=${g?.submittedAt} id=${g?.id} code=${g?.code}`)
  failed ||= !(a.duplicate === false && b.duplicate === true && a.id === b.id && a.code === b.code && n === 1)
} catch (e) {
  failed = true
  console.error('✘', e.message)
} finally {
  const removed = await purge(db, track)
  const left = await residual(db, { ...track, prefix })
  console.log(`\n清理：${JSON.stringify(removed)}；残留 ${Object.keys(left).length ? JSON.stringify(left) : 0}`)
  await db.$disconnect()
}
console.log(failed ? '\n结果：✘ 不符合预期' : '\n结果：✔ 符合预期')
process.exit(failed ? 1 : 0)
