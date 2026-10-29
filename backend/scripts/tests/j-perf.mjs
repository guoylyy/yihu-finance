// J. 性能基线：同一句话跑 5 次 chat，记 p50 / p95；live 超过 30 秒提示
import { ctx, pct, assertChatShape } from './lib.mjs'

export default async function run(t) {
  const label = t.mode
  await t.check('J', `${label}：5 次 chat 的 p50 / p95`, async () => {
    const token = t.write ? t.fx.tokens.admin : t.token
    const text = t.write ? `录一笔应收：客户 ${t.fx.custA.id}，金额 128000，月底到期` : '录一笔应收：金额 128000，月底到期'
    const ms = []
    for (let i = 0; i < 5; i++) {
      const r = await t.api.chat(token, text, ctx('/receivables'))
      assertChatShape(r)
      ms.push(Math.round(r.ms))
    }
    const p50 = pct(ms, 50)
    const p95 = pct(ms, 95)
    t.perf[label] = { runs: ms, p50, p95 }
    if (label === 'live' && p95 > 30_000) t.notes.push(`J：live p95 = ${(p95 / 1000).toFixed(1)}s，超过 30 秒，生产体验差`)
    return `p50 ${p50} ms / p95 ${p95} ms（${ms.join(', ')}）${label === 'live' && p95 > 30_000 ? ' ⚠ 超过 30 秒' : ''}`
  })
}
