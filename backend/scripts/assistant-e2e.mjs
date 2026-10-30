// 录入助手端到端测试 runner。用法见 scripts/README.md
//   node scripts/assistant-e2e.mjs                 stub 全量（默认；后端需以 FIN_LLM_STUB=1 启动）
//   node scripts/assistant-e2e.mjs --live          真实模型：只断言结构与安全属性
//   node scripts/assistant-e2e.mjs --read-only     不写库：生产冒烟（可与 --live 叠加）
//   node scripts/assistant-e2e.mjs --cleanup-stale 清掉上次跑崩留下的 E2E- 测试数据
// 写库模式只在自建的两家测试公司（E2E-<时间戳>-A/B）里写，测试用户的数据范围也只限这两家；跑完硬删除
import fs from 'node:fs'
import path from 'node:path'
import { parseOptions, makeHttp, makeRunner, openDb, countRows, purge, residual, findStale, BACKEND_DIR, ROOT_DIR } from './tests/lib.mjs'
import { createFixtures } from './tests/fixtures.mjs'
import { chromeAvailable } from './tests/browser.mjs'

const GROUPS = [
  ['S', '冒烟', 's-smoke'], ['A', '四类草稿全覆盖', 'a-drafts'], ['B', '修改模式', 'b-update'], ['C', '数据范围与越权', 'c-scope'],
  ['D', '权限矩阵', 'd-perms'], ['E', '降级（mock 上游）', 'e-degrade'], ['F', '安全', 'f-security'], ['G', '边界值', 'g-boundary'],
  ['H', '幂等与并发', 'h-concurrency'], ['I', '业务回归', 'i-business'], ['J', '性能基线', 'j-perf'], ['K', '跨页面操作', 'k-cross-page']
]

const opts = parseOptions(process.argv.slice(2))
if (opts.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'))
  process.exit(0)
}
const mode = opts.live ? 'live' : 'stub'
const write = !opts.readOnly
const api = makeHttp(opts.base)
const startedAt = new Date()

console.log(`录入助手 E2E · ${opts.base} · ${mode}${write ? '' : ' · 只读'}`)

// ---------- 数据库（只有写库模式需要） ----------
let db = null
let dbUrl = null
if (write || opts.cleanupStale) {
  const r = await openDb()
  if (!r.db) { console.error(`✘ 写库模式需要直连被测服务的数据库（用来建数前后比对行数、硬删除测试数据）：${r.reason}\n  只想跑不写库的检查请加 --read-only`); process.exit(2) }
  db = r.db
  dbUrl = r.url
}

if (opts.cleanupStale) {
  const stale = await findStale(db)
  console.log(`残留测试公司 ${stale.companies.map((c) => c.code).join('、') || '无'}；测试用户 ${stale.users.map((u) => u.username).join('、') || '无'}`)
  if (stale.companyIds.length || stale.userIds.length) console.log('已删除：', await purge(db, { ...stale, keepAudit: opts.keepAudit }))
  await db.$disconnect()
  process.exit(0)
}

// ---------- 引导身份 ----------
let token = opts.token
let me
try {
  if (!token) token = (await api.login(opts.user, opts.pass)).token
  me = (await api.data('GET', '/api/auth/me', token)).user
} catch (e) {
  console.error(`✘ 拿不到登录身份：${e.message}\n  用 --token <jwt> 传入，或 --user/--pass（默认 admin/admin123）`)
  process.exit(2)
}
console.log(`身份：${me.username}（${me.role}${me.companyScope ? `，范围 ${me.companyScope.join(',')}` : '，全部公司'}）${opts.token ? ' · 来自 --token' : ' · 自动登录'}`)

const status = await api.http('GET', '/api/fin/assistant/status', token)
if (status.json.code === 0) {
  const s = status.json.data
  if (opts.live && s.stub) { console.error('✘ --live 要求后端不开 FIN_LLM_STUB（当前是 stub）'); process.exit(2) }
  if (!opts.live && !s.stub) { console.error('✘ 默认模式要求后端以 FIN_LLM_STUB=1 启动（当前接的是真实模型）；要跑真实模型请加 --live'); process.exit(2) }
  if (opts.live && !s.available) { console.error(`✘ 助手不可用：${s.reason}`); process.exit(2) }
}
if (write && me.role !== 'ADMIN') { console.error('✘ 写库模式需要 ADMIN 身份来建测试公司与测试用户'); process.exit(2) }

// ---------- 环境能力 ----------
const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(new URL(opts.base).hostname)
const caps = new Set([mode, write ? 'write' : 'readonly'])
if (db) caps.add('db')
if (write && isLocal && fs.existsSync(path.join(BACKEND_DIR, 'src/index.js'))) caps.add('spawn')
let uiOk = false
try { uiOk = (await fetch(`${opts.ui}/login`)).ok } catch { /* 前端没托管 */ }
if (chromeAvailable(opts.chrome) && uiOk) caps.add('browser')
const env = { has: (c) => caps.has(c), groupTitle: Object.fromEntries(GROUPS.map(([g, title]) => [g, title])) }
console.log(`能力：${[...caps].join(' / ')}${caps.has('browser') ? '' : `（无头浏览器不可用：${chromeAvailable(opts.chrome) ? `前端 ${opts.ui} 打不开` : `找不到 Chrome ${opts.chrome}`}）`}`)

const runner = makeRunner(opts, env)
const prefix = `E2E-${Date.now().toString(36)}`
const track = { companyIds: [], userIds: [] }
const t = { opts, api, check: runner.check, log: runner.log, notes: runner.notes, perf: runner.perf, env, mode, write, db, dbUrl, token, me, fx: null }

let before = null
let after = null
let removed = null
let left = null
let fatal = null

const cleanup = async () => {
  if (!write || !db || removed) return
  removed = await purge(db, { ...track, keepAudit: opts.keepAudit })
  left = await residual(db, { ...track, prefix })
  after = await countRows(db)
}
process.on('SIGINT', async () => { console.log('\n中断，清理测试数据…'); await cleanup().catch((e) => console.error(e)); process.exit(130) })

try {
  if (write) {
    before = await countRows(db)
    t.fx = await createFixtures(api, token, prefix, track)
    // 确认直连的库就是被测服务用的库：刚通过接口建的公司在库里能查到
    const hit = await db.company.findFirst({ where: { code: `${prefix}-A` } })
    if (!hit) throw new Error('DATABASE_URL 指向的库里查不到刚通过接口建的测试公司：被测服务和本脚本连的不是同一个库')
    console.log(`测试数据前缀 ${prefix}：公司 ${track.companyIds.join(',')}，用户 ${track.userIds.length} 个`)
  }
  for (const [, , file] of GROUPS) {
    const mod = await import(`./tests/${file}.mjs`)
    await mod.default(t)
  }
} catch (e) {
  fatal = e
  console.error(`\n✘ 运行中断：${e.stack || e.message}`)
} finally {
  await cleanup().catch((e) => { console.error('✘ 清理失败：', e); fatal ||= e })
  await db?.$disconnect()
}

// ---------- 汇总 ----------
const { results, notes, perf } = runner
const n = (s) => results.filter((r) => r.status === s).length
console.log(`\n通过 ${n('PASS')} / 失败 ${n('FAIL')} / 跳过 ${n('SKIP')}${fatal ? ' / 运行中断' : ''}`)
if (notes.length) console.log(`\n记录：\n${notes.map((x) => `  · ${x}`).join('\n')}`)
let rowsTable = ''
if (before && after) {
  const diff = Object.keys(before).filter((k) => before[k] !== after[k])
  rowsTable = ['| 表 | 测试前 | 清理后 | 差 |', '|---|---:|---:|---:|', ...Object.keys(before).map((k) => `| ${k} | ${before[k]} | ${after[k]} | ${after[k] - before[k] || ''} |`)].join('\n')
  console.log(`\n清理：硬删除 ${JSON.stringify(removed)}`)
  console.log(`残留测试行：${Object.keys(left || {}).length ? JSON.stringify(left) : '0'}`)
  console.log(diff.length ? `⚠ 行数与测试前不一致：${diff.map((k) => `${k} ${before[k]}→${after[k]}`).join('，')}（若测试期间有人在录数据，这是正常的；残留测试行为 0 才是判据）` : '各表行数与测试前完全一致')
}

// ---------- 报告：只替换本模式那一段，人工写的部分不动 ----------
if (opts.report && !opts.only) {
  const key = `${mode}${write ? '' : '-readonly'}`
  const lines = [
    `### 自动结果：${key}（${startedAt.toLocaleString('zh-CN', { hour12: false })}，${opts.base}）`, '',
    `通过 **${n('PASS')}** / 失败 **${n('FAIL')}** / 跳过 ${n('SKIP')}${fatal ? ` / ⚠ 运行中断：${fatal.message}` : ''}`, '',
    '| 组 | 检查项 | 结果 | 说明 |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.group} | ${r.name.replace(/\|/g, '\\|')} | ${{ PASS: '✅', FAIL: '❌', SKIP: '⏭' }[r.status]} | ${(r.detail || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    '',
    ...(Object.keys(perf).length ? ['**性能**', '', ...Object.entries(perf).map(([k, v]) => `- ${k}：p50 ${v.p50} ms，p95 ${v.p95} ms（${v.runs.join(' / ')} ms）`), ''] : []),
    ...(notes.length ? ['**现状记录**', '', ...notes.map((x) => `- ${x}`), ''] : []),
    ...(rowsTable ? ['**测试数据清理**', '', `前缀 \`${prefix}\`；硬删除 \`${JSON.stringify(removed)}\`；残留测试行 ${Object.keys(left || {}).length ? `\`${JSON.stringify(left)}\`` : '**0**'}`, '', rowsTable, ''] : [])
  ].join('\n')
  const file = opts.report
  let doc = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# 录入助手测试报告\n'
  const begin = `<!-- AUTO:${key}:BEGIN -->`
  const end = `<!-- AUTO:${key}:END -->`
  const block = `${begin}\n${lines}\n${end}`
  doc = doc.includes(begin) ? doc.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), () => block) : `${doc.trimEnd()}\n\n${block}\n`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, doc)
  console.log(`\n报告已写入 ${path.relative(ROOT_DIR, file)}（段落 ${key}）`)
}

process.exit(n('FAIL') || fatal ? 1 : 0)
