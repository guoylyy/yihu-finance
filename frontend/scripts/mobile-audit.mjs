// 移动端验收脚本（playwright）
//   node scripts/mobile-audit.mjs audit                 375×667 下逐路由断言无横向滚动（列出超宽元素）、页面标题只出现一次；
//                                                       助手输入框提示语随视口切换（375 不提 Shift，1280 保持 Enter / Shift+Enter）
//   node scripts/mobile-audit.mjs shots [--widths 375,768,1440] [--out screenshots/mobile]
// 环境变量：APP_URL（默认 http://localhost:5173）、FIN_USER / FIN_PASS（默认 admin / admin123）
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const APP = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')
const USER = process.env.FIN_USER || 'admin'
const PASS = process.env.FIN_PASS || 'admin123'
const args = process.argv.slice(2)
const mode = args[0] || 'audit'
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i > -1 ? args[i + 1] : def }
const HEIGHT = { 375: 667, 768: 1024, 1440: 900 }

const ROUTES = [
  'dashboard', 'companies', 'accounts', 'transactions', 'transactions/import', 'receivables', 'payables', 'payments',
  'payrolls', 'payrolls/:id', 'reimbursements', 'invoices', 'loans', 'close', 'analytics', 'forecast', 'anomalies',
  'parties', 'users', 'audit-logs', 'profile', 'guide'
]

async function login(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(`${APP}/login`)
  await page.getByPlaceholder('用户名').fill(USER)
  await page.getByPlaceholder('密码').fill(PASS)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(/dashboard/)
  // 第一张工资单的 id，用于 payrolls/:id
  const token = await page.evaluate(() => Object.entries(localStorage).find(([k]) => /token/i.test(k))?.[1])
  const res = await page.request.get(`${APP}/api/fin/payrolls?page_size=1`, { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.json().catch(() => ({}))
  const payrollId = body?.data?.list?.[0]?.id
  const state = await ctx.storageState()
  await ctx.close()
  return { state, payrollId }
}

// 在页面里找出右边界超出视口、且没有被可滚动/裁剪祖先兜住的元素，只报最外层
// 注意：移动端仿真下内容超宽时 innerWidth 会被撑大，所以视口宽度由外部传入（375），不读 innerWidth
const FIND_OVERFLOW = (vw) => {
  const sel = (el) => {
    let s = el.tagName.toLowerCase()
    if (el.id) s += `#${el.id}`
    const cls = [...el.classList].filter((c) => !/^data-v-/.test(c)).slice(0, 3)
    if (cls.length) s += '.' + cls.join('.')
    return s
  }
  const pathOf = (el) => {
    const parts = []
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) parts.unshift(sel(e))
    return parts.join(' > ')
  }
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX
      if (ox !== 'visible') return p.getBoundingClientRect().right <= vw + 1
    }
    return false
  }
  const bad = []
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    if (r.right > vw + 1 || r.left < -1) {
      if (clipped(el)) continue
      if (bad.some((b) => b.el.contains(el))) continue
      bad.push({ el, path: pathOf(el), right: Math.round(r.right) })
    }
  }
  // 同一选择器只报一次（表格每行一样），带出现次数与最大右边界
  const grouped = new Map()
  for (const b of bad) {
    const g = grouped.get(b.path) || { n: 0, right: 0 }
    grouped.set(b.path, { n: g.n + 1, right: Math.max(g.right, b.right) })
  }
  const list = [...grouped].slice(0, 6).map(([p, g]) => `${p} (right=${g.right}${g.n > 1 ? ` ×${g.n}` : ''})`)
  if (grouped.size > 6) list.push(`…另 ${grouped.size - 6} 类`)
  return { scrollWidth: document.body.scrollWidth, docWidth: document.documentElement.scrollWidth, vw, bad: list }
}

// 手机端标题只保留一处：顶栏标题 + 页内同名 .page-title 只能有一个可见
const TITLE_ONCE = () => {
  const visible = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 }
  const top = document.querySelector('.topbar .title')
  const title = top?.textContent.trim()
  if (!title) return { title: null, count: 0 }
  const count = [...document.querySelectorAll('.topbar .title, .page-title')].filter((el) => visible(el) && el.textContent.trim() === title).length
  return { title, count }
}

// 内容在 .main 里滚动，整页截图前临时放开，截到完整长度（只影响截图，不影响断言）
async function unlockScroll(page) {
  await page.addStyleTag({ content: '.layout,.main-col{height:auto!important}.main{overflow:visible!important}' })
  await page.waitForTimeout(150)
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(500)
}

async function open(page, route, payrollId) {
  const r = route.replace(':id', payrollId || 1)
  await page.goto(`${APP}/${r}`)
  await settle(page)
}

async function audit() {
  const browser = await chromium.launch()
  const { state, payrollId } = await login(browser)
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const rows = []
  // must：交互态必须真的打开了（选择器可见），否则判失败，避免「没打开所以没超宽」的假通过
  const check = async (name, must) => {
    const r = await page.evaluate(FIND_OVERFLOW, 375)
    const bad = [...r.bad]
    if (must && !(await page.locator(must).first().isVisible().catch(() => false))) bad.push(`未打开：${must}`)
    const pass = r.scrollWidth <= r.vw + 1 && r.docWidth <= r.vw + 1 && !bad.length
    rows.push({ name, pass, scrollWidth: r.scrollWidth, bad })
  }
  // 登录页（未登录上下文）
  const anon = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true })
  const lp = await anon.newPage()
  await lp.goto(`${APP}/login`); await settle(lp)
  const lr = await lp.evaluate(FIND_OVERFLOW, 375)
  rows.push({ name: 'login', pass: lr.scrollWidth <= lr.vw + 1 && !lr.bad.length, scrollWidth: lr.scrollWidth, bad: lr.bad })
  await anon.close()

  for (const route of ROUTES) {
    await open(page, route, payrollId)
    await check(route)
    const t = await page.evaluate(TITLE_ONCE)
    if (t.count !== 1) {
      const row = rows[rows.length - 1]
      row.pass = false
      row.bad.push(t.title ? `标题「${t.title}」出现 ${t.count} 次（应只出现 1 次）` : '顶栏标题缺失')
    }
  }
  // 交互态：导航抽屉、新增弹窗、筛选 sheet、助手
  await open(page, 'receivables', payrollId)
  await page.locator('.m-menu-btn').click().catch(() => {}); await page.waitForTimeout(400); await check('[抽屉] 导航', '.m-nav-drawer')
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  await clickAdd(page); await check('[弹窗] 新增应收', '.el-dialog')
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  await page.locator('.m-filter-btn').first().click().catch(() => {}); await page.waitForTimeout(400); await check('[sheet] 筛选', '.m-sheet')
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  await openAssistant(page); await check('[助手] 展开', '.assistant-pane.is-sheet')
  rows.push(await hintRow(page, 375))
  // 助手里发一句，拿到草稿卡（STUB 模型），检查草稿卡形态
  await page.locator('.a-input textarea').fill('录一笔应收：客户 12，金额 128000，月底到期')
  await page.locator('.a-input .el-button--primary').click()
  await page.locator('.draft').first().waitFor({ timeout: 15000 }).catch(() => {})
  await check('[助手] 草稿卡', '.draft')
  // 跨类型：账户页出流水 + 发票两种草稿，徽章和按钮不能撑宽；「填入表单」跳到发票页打开弹窗
  await open(page, 'accounts', payrollId)
  await openAssistant(page)
  await page.locator('.a-input textarea').fill('记两笔收款，1000 和 2000，再开一张 1000 的发票')
  await page.locator('.a-input .el-button--primary').click()
  await page.locator('.draft').nth(2).waitFor({ timeout: 15000 }).catch(() => {})
  await check('[助手] 跨类型草稿卡', '.draft .kind-badge')
  await page.locator('.draft').filter({ hasText: '发票类型' }).locator('.draft-actions .el-button').first().click().catch(() => {})
  await page.waitForTimeout(800)
  await check('[助手] 跨页填入表单', '.el-dialog')
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  for (const route of ['transactions', 'accounts']) {
    await open(page, route, payrollId)
    await page.locator('.page-head .el-button--primary').first().click().catch(() => {})
    await page.waitForTimeout(500)
    await check(`[弹窗] ${route} 主按钮`, '.el-dialog')
    await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  }

  // 桌面对照：提示语保持 Enter / Shift+Enter
  const desk = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 800 } })
  const dp = await desk.newPage()
  await dp.goto(`${APP}/receivables`); await settle(dp)
  await openAssistant(dp)
  rows.push(await hintRow(dp, 1280))
  await desk.close()

  // 平板 / 桌面：逐路由 + 助手跨类型草稿卡
  for (const w of [768, 1440]) {
    const c = await browser.newContext({ storageState: state, viewport: { width: w, height: HEIGHT[w] } })
    const p = await c.newPage()
    const at = async (name) => {
      const r = await p.evaluate(FIND_OVERFLOW, w)
      rows.push({ name: `${w} ${name}`, pass: r.scrollWidth <= w + 1 && r.docWidth <= w + 1 && !r.bad.length, scrollWidth: r.scrollWidth, bad: r.bad })
    }
    await p.goto(`${APP}/dashboard`)
    await p.evaluate(() => localStorage.setItem('fin_assistant_ui', JSON.stringify({ open: false, width: 380 })))
    for (const route of ROUTES) { await open(p, route, payrollId); await at(route) }
    await open(p, 'accounts', payrollId)
    await openAssistant(p)
    await p.locator('.a-input textarea').fill('记两笔收款，1000 和 2000，再开一张 1000 的发票')
    await p.locator('.a-input .el-button--primary').click()
    await p.locator('.draft').nth(2).waitFor({ timeout: 15000 }).catch(() => {})
    await at('[助手] 跨类型草稿卡')
    await c.close()
  }

  await browser.close()
  console.log('\n| 页面（无前缀为 375） | 通过 | body.scrollWidth | 违规元素 |')
  console.log('|---|---|---|---|')
  for (const r of rows) console.log(`| ${r.name} | ${r.pass ? '✅' : '❌'} | ${r.scrollWidth} | ${r.bad.length ? r.bad.join('<br>') : '—'} |`)
  const failed = rows.filter((r) => !r.pass).length
  console.log(`\n合计 ${rows.length} 项，通过 ${rows.length - failed}，失败 ${failed}`)
  process.exit(failed ? 1 : 0)
}

// 助手输入框提示语：手机没有 Shift 键，不能写「Shift+Enter」
async function hintRow(page, width) {
  const ph = await page.locator('.a-input textarea').first().getAttribute('placeholder').catch(() => null)
  const mobile = width <= 768
  const pass = !!ph && (mobile ? !/shift/i.test(ph) && /发送/.test(ph) : /Shift\+Enter/.test(ph))
  return { name: `[助手] 输入框提示语 ${width}`, pass, scrollWidth: '—', bad: pass ? [] : [`placeholder=「${ph}」${mobile ? '（手机端不应提 Shift）' : '（桌面应为 Enter 发送，Shift+Enter 换行）'}`] }
}

async function clickAdd(page) {
  await page.locator('.page-head .el-button--primary').filter({ hasText: /新增|登记|添加/ }).first().click()
  await page.waitForTimeout(600)
}

// 手机端从头像菜单打开（store 在手机上总是默认收起）；平板/桌面走存储的偏好
async function openAssistant(page) {
  if (page.viewportSize().width <= 768) {
    await page.locator('.topbar .user').click()
    await page.getByRole('menuitem', { name: /录入助手/ }).click()
    await page.waitForTimeout(500)
    return
  }
  await page.evaluate(() => localStorage.setItem('fin_assistant_ui', JSON.stringify({ open: true, width: 380 })))
  await page.reload(); await settle(page)
}

async function shots() {
  const widths = opt('widths', '375,768,1440').split(',').map(Number)
  const out = opt('out', 'screenshots/mobile')
  const browser = await chromium.launch()
  const { state, payrollId } = await login(browser)
  for (const w of widths) {
    const dir = path.join(out, String(w))
    fs.mkdirSync(dir, { recursive: true })
    const mobile = w < 769
    const base = { viewport: { width: w, height: HEIGHT[w] || 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 }
    const anon = await browser.newContext(base)
    const lp = await anon.newPage()
    await lp.goto(`${APP}/login`); await settle(lp)
    await lp.screenshot({ path: path.join(dir, 'login.png') })
    await anon.close()

    const ctx = await browser.newContext({ ...base, storageState: state })
    const page = await ctx.newPage()
    // 截图统一先关掉助手，单独截一张展开态
    await page.goto(`${APP}/dashboard`)
    await page.evaluate(() => localStorage.setItem('fin_assistant_ui', JSON.stringify({ open: false, width: 380 })))
    const list = [['dashboard', 'dashboard'], ['transactions', 'transactions'], ['receivables', 'receivables'],
      ['parties', 'associations-parties'], ['loans', 'loans'], ['transactions/import', 'transaction-import'],
      ['analytics', 'analytics'], ['close', 'close-workbench']]
    for (const [route, name] of list) {
      await open(page, route, payrollId)
      await unlockScroll(page)
      await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true })
    }
    await open(page, 'receivables', payrollId)
    await clickAdd(page)
    await page.screenshot({ path: path.join(dir, 'receivables-add-dialog.png') })
    await page.keyboard.press('Escape'); await page.waitForTimeout(300)
    if (mobile) {
      await page.locator('.m-menu-btn').click().catch(() => {}); await page.waitForTimeout(500)
      await page.screenshot({ path: path.join(dir, 'nav-drawer.png') })
      await page.keyboard.press('Escape'); await page.waitForTimeout(300)
      await page.locator('.m-filter-btn').first().click().catch(() => {}); await page.waitForTimeout(500)
      await page.screenshot({ path: path.join(dir, 'filter-sheet.png') })
      await page.keyboard.press('Escape'); await page.waitForTimeout(300)
    }
    await openAssistant(page)
    await page.screenshot({ path: path.join(dir, 'assistant-open.png') })
    await page.locator('.a-input textarea').fill('录一笔应收：客户 12，金额 128000，月底到期')
    await page.locator('.a-input .el-button--primary').click()
    await page.locator('.draft').first().waitFor({ timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(dir, 'assistant-draft.png') })
    await page.evaluate(() => localStorage.setItem('fin_assistant_ui', JSON.stringify({ open: false, width: 380 })))
    await ctx.close()
    console.log(`${w}: ${fs.readdirSync(dir).map((f) => path.join(dir, f)).join('\n     ')}`)
  }
  await browser.close()
}

// 每个路由整页截图（桌面回归对比用）
async function routes() {
  const w = Number(opt('width', '1440'))
  const out = opt('out', 'screenshots/routes')
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch()
  const { state, payrollId } = await login(browser)
  const ctx = await browser.newContext({ storageState: state, viewport: { width: w, height: HEIGHT[w] || 900 } })
  const page = await ctx.newPage()
  await page.goto(`${APP}/dashboard`)
  await page.evaluate(() => localStorage.setItem('fin_assistant_ui', JSON.stringify({ open: false, width: 380 })))
  for (const route of ROUTES) {
    await open(page, route, payrollId)
    await page.waitForTimeout(700)
    await page.screenshot({ path: path.join(out, route.replace(/[/:]/g, '_') + '.png'), fullPage: true })
  }
  await browser.close()
  console.log(`已截 ${ROUTES.length} 个路由 → ${out}`)
}

if (mode === 'audit') await audit()
else if (mode === 'routes') await routes()
else if (mode === 'shots') await shots()
else { console.error('用法：node scripts/mobile-audit.mjs audit|shots'); process.exit(2) }
