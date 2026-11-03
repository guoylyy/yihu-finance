// v1.4 切片 3 前端验收（playwright）：在 dev 库自建公司 S3V-<时间戳> 造数，浏览器里走通
//   ① 先有流水认领 ② 新建流水 ③ 一笔流水拆两笔应收 ④ 超收转预收 ⑤ 发票挂 / 摘应收 ⑥ 375 / 1440 三个弹窗不横向溢出、375 完成一次认领
// 用法：APP_URL=http://localhost:5183 node scripts/verify-v140-s3.mjs   （前端代理须指向 dev 库后端，脚本只认 localhost）
import { chromium } from 'playwright'
import fs from 'node:fs'

const APP = (process.env.APP_URL || 'http://localhost:5183').replace(/\/$/, '')
if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(APP)) { console.error('只允许连本机'); process.exit(2) }
const OUT = process.env.OUT || '/tmp/fin-s3-shots'
fs.mkdirSync(OUT, { recursive: true })

let token
async function api(method, url, body) {
  const r = await fetch(APP + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json()
  if (j.code !== 0) throw new Error(`${method} ${url} → ${j.message}`)
  return j.data
}
let pass = 0
let fail = 0
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? `｜${extra}` : ''}`) }
const head = (t) => console.log(`\n━━ ${t} ━━`)

// ── 造数 ──
token = (await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).token
const ts = Date.now().toString().slice(-6)
const co = await api('POST', '/api/fin/companies', { code: `S3V-${ts}`, name: `切片3验收-${ts}` })
const acc = await api('POST', '/api/fin/accounts', { companyId: co.id, name: `S3V基本户-${ts}`, type: 'BANK' })
const cust = await api('POST', '/api/fin/customers', { companyId: co.id, name: `客户乙${ts}` })
const mkAR = (amount, title) => api('POST', '/api/fin/receivables', { companyId: co.id, customerId: cust.id, title, amount: String(amount) })
const mkTxn = (amount, remark) => api('POST', '/api/fin/transactions', { companyId: co.id, accountId: acc.id, txnDate: '2026-11-02', direction: 'IN', amount: String(amount), counterparty: cust.name, remark, bizType: 'SALES_RECEIPT', status: 'UNRECONCILED' })
const ar1 = await mkAR(10000, `S3V场景1 先有流水 ${ts}`)
const t1 = await mkTxn(10000, `银行导入 场景1 ${ts}`)
const ar2 = await mkAR(3000, `S3V场景2 新建流水 ${ts}`)
const ar3 = await mkAR(5000, `S3V场景3 拆分甲 ${ts}`)
const ar4 = await mkAR(3000, `S3V场景3 拆分乙 ${ts}`)
const t3 = await mkTxn(8000, `银行导入 场景3 ${ts}`)
const ar5 = await mkAR(2000, `S3V场景4 超收 ${ts}`)
const ar6 = await mkAR(1200, `S3V手机认领 ${ts}`)
const t6 = await mkTxn(1200, `银行导入 手机 ${ts}`)
const inv = await api('POST', '/api/fin/invoices', { companyId: co.id, invoiceNo: `S3V${ts}01`, type: 'SALES', issueDate: '2026-11-02', amount: '10000', taxAmount: '0', totalAmount: '10000', buyerName: cust.name, customerId: cust.id })
console.log(`公司 ${co.code}(id ${co.id})｜客户 ${cust.name}｜AR ${[ar1, ar2, ar3, ar4, ar5, ar6].map((a) => a.code).join(' ')}｜TXN ${[t1, t3, t6].map((t) => t.code).join(' ')}｜发票 ${inv.invoiceNo}`)

const browser = await chromium.launch()
async function newPage(width, height, mobile = false) {
  const ctx = await browser.newContext({ viewport: { width, height }, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) })
  const page = await ctx.newPage()
  await page.goto(`${APP}/login`)
  await page.getByPlaceholder('用户名').fill('admin')
  await page.getByPlaceholder('密码').fill('admin123')
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(/dashboard/)
  return page
}
const toast = async (page) => {
  const m = page.locator('.el-message').last()
  await m.waitFor({ timeout: 8000 })
  return (await m.innerText()).trim()
}
const clearToasts = (page) => page.evaluate(() => document.querySelectorAll('.el-message').forEach((e) => e.remove()))
const dialog = (page, title) => page.locator('.el-dialog:visible', { hasText: title }).last()
// 页面与弹窗遮罩的横向宽度：scrollWidth 应等于 innerWidth / clientWidth
const widths = (page) => page.evaluate(() => {
  const ov = [...document.querySelectorAll('.el-overlay-dialog')].filter((e) => e.offsetParent !== null || getComputedStyle(e).display !== 'none').pop()
  const dlg = [...document.querySelectorAll('.el-dialog')].filter((e) => e.getBoundingClientRect().width > 0).pop()
  const btns = dlg ? [...dlg.querySelectorAll('.el-dialog__footer .el-button')].map((b) => Math.round(b.getBoundingClientRect().height)) : []
  return {
    innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth,
    overlayScroll: ov?.scrollWidth, overlayClient: ov?.clientWidth,
    dialogRight: dlg ? Math.round(dlg.getBoundingClientRect().right) : null, dialogScroll: dlg?.scrollWidth, dialogClient: dlg?.clientWidth, footerBtnHeights: btns
  }
})
const okWidth = (w) => w.scrollWidth === w.innerWidth && (w.overlayScroll ?? 0) <= (w.overlayClient ?? 0) && (w.dialogScroll ?? 0) <= (w.dialogClient ?? 0) && (w.dialogRight ?? 0) <= w.innerWidth
async function pickOption(page, selectLoc, text) {
  await selectLoc.click()
  await page.waitForTimeout(400) // 等下拉展开动画结束，否则边动边点会点空
  await page.keyboard.type(text)
  await page.waitForTimeout(400)
  const opt = page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: text }).first()
  await opt.waitFor()
  await opt.click()
}
async function rowAction(page, code, btn) {
  const row = page.locator('.el-table__row, .m-card', { hasText: code }).first()
  await row.waitFor()
  await row.getByRole('button', { name: btn }).first().click()
}
async function searchList(page, kw) {
  // 先等首屏列表出来（否则首屏加载可能把刚填的关键字冲掉），再等带关键字的列表请求返回
  await page.locator('.el-table__row, .m-card, .el-table__empty-text, .m-state').first().waitFor()
  const input = page.getByPlaceholder(/搜索/).first()
  await input.fill(kw)
  const resp = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).searchParams.get('keyword') === kw, { timeout: 10000 })
  await input.press('Enter')
  await resp
  await page.waitForTimeout(300)
}

const widthLog = []
const desk = await newPage(1440, 900)

// ── ① 先有流水认领 ──
head('① 先有流水认领（应收页 → 认领流水 → 选流水 → 确认金额）')
await desk.goto(`${APP}/receivables`)
await searchList(desk, ar1.code)
await rowAction(desk, ar1.code, '认领流水')
let dlg = dialog(desk, '认领流水')
await dlg.waitFor()
await dlg.getByPlaceholder('搜索对方名称 / 流水号 / 备注').fill(t1.code)
await dlg.getByRole('button', { name: '查询' }).click()
await desk.waitForTimeout(500)
const candRow = dlg.locator('.el-table__row', { hasText: t1.code })
console.log('  候选行：' + (await candRow.innerText()).replace(/\s+/g, ' '))
widthLog.push(['认领流水·选流水', 1440, await widths(desk)])
await candRow.click()
check('选中后高亮', await candRow.evaluate((e) => e.classList.contains('is-picked')))
await desk.screenshot({ path: `${OUT}/1440-receipt-pick.png` })
await dlg.getByRole('button', { name: '下一步' }).click()
console.log('  第二步摘要：' + (await dlg.locator('.rc-sum').innerText()).replace(/\s+/g, ' '))
const amtInput = dlg.locator('.rc-confirm input').first()
check('默认金额 = min(应收剩余, 流水剩余)', (await amtInput.inputValue()) === '10000.00', await amtInput.inputValue())
for (const [v, label] of [['-1', '负数'], ['1.234', '三位小数'], ['10000.01', '超剩余'], ['0', '零']]) {
  await amtInput.fill(v)
  const err = (await dlg.locator('.el-form-item__error').first().innerText().catch(() => '')).trim()
  const disabled = await dlg.getByRole('button', { name: '确认认领' }).isDisabled()
  check(`组件层拦截 ${label}（${v}）`, !!err && disabled, err)
}
await amtInput.fill('10000')
await clearToasts(desk)
await dlg.getByRole('button', { name: '确认认领' }).click()
let msg = await toast(desk)
console.log(`  toast：${msg}`)
check('toast = 已认领 ¥10,000.00 到 ' + ar1.code, msg === `已认领 ¥10,000.00 到 ${ar1.code}`)

// ── ② 新建流水 ──
head('② 找不到流水 → 新建一条流水')
await searchList(desk, ar2.code)
await rowAction(desk, ar2.code, '认领流水')
dlg = dialog(desk, '认领流水')
await dlg.getByRole('button', { name: '新建一条流水' }).click()
const nAmt = dlg.locator('.el-input-number input').first()
console.log(`  新建表单默认金额：${await nAmt.inputValue()}；min 属性：${await nAmt.getAttribute('aria-valuemin')}`)
check('新建模式 :min = 0.01', (await nAmt.getAttribute('aria-valuemin')) === '0.01')
await clearToasts(desk)
await dlg.getByRole('button', { name: '确认收款' }).click()
msg = await toast(desk)
console.log(`  toast：${msg}`)
check('新建流水并认领 ¥3,000.00', new RegExp(`^已认领 ¥3,000\\.00 到 ${ar2.code}（新建流水 TXN-\\d{6}-\\d{4}）$`).test(msg))

// ── ④ 超收转预收 ──
head('④ 超收转预收（新建流水 2500 → 应收 2000）')
await searchList(desk, ar5.code)
await rowAction(desk, ar5.code, '认领流水')
dlg = dialog(desk, '认领流水')
await dlg.getByRole('button', { name: '新建一条流水' }).click()
await dlg.locator('.el-input-number input').first().fill('2500')
await dlg.locator('.el-input-number input').first().blur()
await clearToasts(desk)
await dlg.getByRole('button', { name: '确认收款' }).click()
msg = await toast(desk)
console.log(`  toast：${msg}`)
check('toast 含「应收已结清，超出 ¥500.00 已转预收款 PRE-」', /^应收已结清，超出 ¥500\.00 已转预收款 PRE-\d{6}-\d{4}（新建流水 TXN-\d{6}-\d{4}）$/.test(msg))

// ── 应收详情：收款构成 ──
head('应收详情（收款构成）')
await searchList(desk, ar5.code)
await rowAction(desk, ar5.code, '详情')
let drawer = desk.locator('.el-drawer:visible')
await drawer.locator('.ard-sec').nth(1).waitFor()
await desk.waitForTimeout(500)
console.log('  ' + (await drawer.locator('.ard-sec').nth(1).innerText()).replace(/\s+/g, ' '))
await desk.keyboard.press('Escape')
await desk.waitForTimeout(300)

// ── ③ 一笔流水拆两笔 ──
head('③ 流水页：一笔流水（8000）拆给两笔应收（5000 + 3000）')
await desk.goto(`${APP}/transactions`)
await searchList(desk, t3.code)
// 桌面端流水表隐藏了「编号」列（手机才显示），用备注前缀定位行
const t3Key = `银行导入 场景3 ${ts}`
const t3row = desk.locator('.el-table__row', { hasText: t3Key }).first()
await t3row.getByRole('button', { name: '认领到应收' }).click()
dlg = dialog(desk, '认领到应收')
await dlg.locator('.rd-row').first().waitFor()
await desk.waitForTimeout(300)
await pickOption(desk, dlg.locator('.rd-row').nth(0).locator('.el-select'), ar3.code)
await dlg.locator('.rd-row').nth(0).locator('.rd-amt input').fill('5000')
await dlg.getByRole('button', { name: '再拆一笔' }).click()
await pickOption(desk, dlg.locator('.rd-row').nth(1).locator('.el-select'), ar4.code)
await dlg.locator('.rd-row').nth(1).locator('.rd-amt input').fill('3000.01')
console.log('  合计超 1 分：' + (await dlg.locator('.rd-total').innerText()).replace(/\s+/g, ' '))
check('合计 > 剩余时禁用提交', await dlg.getByRole('button', { name: '确认认领' }).isDisabled())
await dlg.locator('.rd-row').nth(1).locator('.rd-amt input').fill('3000')
console.log('  合计：' + (await dlg.locator('.rd-total').innerText()).replace(/\s+/g, ' '))
widthLog.push(['认领到应收（拆分）', 1440, await widths(desk)])
await clearToasts(desk)
await dlg.getByRole('button', { name: '确认认领' }).click()
msg = await toast(desk)
console.log(`  toast：${msg}`)
await dlg.locator('.rd-result').waitFor()
console.log('  结果：' + (await dlg.locator('.rd-result').innerText()).replace(/\s+/g, ' '))
check('拆分成功、流水剩余 0', msg.includes(`${ar3.code}、${ar4.code}`) && msg.endsWith('流水剩余 ¥0.00'))
await dlg.getByRole('button', { name: '完成' }).click()
await desk.waitForTimeout(500)
console.log('  流水行金额列：' + (await desk.locator('.el-table__row', { hasText: t3Key }).first().locator('td').nth(5).innerText()).replace(/\s+/g, ' '))

// ── ⑤ 发票挂应收 / 摘除 ──
head('⑤ 发票页挂应收 → 应收详情可见 → 摘除后消失')
await desk.goto(`${APP}/invoices`)
await searchList(desk, inv.invoiceNo)
let invRow = desk.locator('.el-table__row', { hasText: inv.invoiceNo }).first()
console.log('  挂之前「关联应收」列：' + (await invRow.locator('td').nth(2).innerText()).trim())
await invRow.getByRole('button', { name: '挂应收' }).click()
dlg = dialog(desk, '发票挂应收')
await dlg.waitFor()
await desk.waitForTimeout(500)
widthLog.push(['发票挂应收', 1440, await widths(desk)])
await pickOption(desk, dlg.locator('.el-select'), ar1.code)
await clearToasts(desk)
await dlg.getByRole('button', { name: '保存' }).click()
msg = await toast(desk)
console.log(`  toast：${msg}`)
await desk.waitForTimeout(600)
invRow = desk.locator('.el-table__row', { hasText: inv.invoiceNo }).first()
console.log('  挂之后「关联应收」列：' + (await invRow.locator('td').nth(2).innerText()).trim())
// 筛选「是否已挂应收」
const linkedTotal = (await api('GET', `/api/fin/invoices?company_id=${co.id}&linked=1`)).total
const unlinkedTotal = (await api('GET', `/api/fin/invoices?company_id=${co.id}&linked=0`)).total
check('筛选 linked=1 / 0 分别 1 / 0 张', linkedTotal === 1 && unlinkedTotal === 0, `${linkedTotal}/${unlinkedTotal}`)

await desk.goto(`${APP}/receivables`)
await searchList(desk, ar1.code)
await rowAction(desk, ar1.code, '详情')
drawer = desk.locator('.el-drawer:visible')
await drawer.locator('.ard-sec').first().waitFor()
await desk.waitForTimeout(600)
let invSec = (await drawer.locator('.ard-sec').first().innerText()).replace(/\s+/g, ' ')
console.log('  应收详情·关联发票：' + invSec)
check('应收详情能看到发票', invSec.includes(inv.invoiceNo))
console.log('  应收详情·收款构成：' + (await drawer.locator('.ard-sec').nth(1).innerText()).replace(/\s+/g, ' '))
await desk.screenshot({ path: `${OUT}/1440-ar-drawer.png` })

await desk.goto(`${APP}/invoices`)
await searchList(desk, inv.invoiceNo)
await desk.locator('.el-table__row', { hasText: inv.invoiceNo }).first().getByRole('button', { name: '改挂 / 摘除' }).click()
dlg = dialog(desk, '发票挂应收')
await clearToasts(desk)
await dlg.getByRole('button', { name: '摘除' }).click()
msg = await toast(desk)
console.log(`  toast：${msg}`)
await desk.goto(`${APP}/receivables`)
await searchList(desk, ar1.code)
await rowAction(desk, ar1.code, '详情')
drawer = desk.locator('.el-drawer:visible')
await drawer.locator('.ard-sec').first().waitFor()
await desk.waitForTimeout(600)
invSec = (await drawer.locator('.ard-sec').first().innerText()).replace(/\s+/g, ' ')
console.log('  摘除后·关联发票：' + invSec)
check('摘除后应收详情不再有该发票', !invSec.includes(inv.invoiceNo))

// ── ⑦ 应收表单里多选发票（销项 + 红字）──
head('⑦ 应收「编辑」里多选发票：价税合计 / 已开票合计 / 未开票差额')
const inv2 = await api('POST', '/api/fin/invoices', { companyId: co.id, invoiceNo: `S3V${ts}02`, type: 'SALES', issueDate: '2026-11-03', amount: '3000', taxAmount: '0', totalAmount: '3000', buyerName: cust.name, customerId: cust.id })
const inv3 = await api('POST', '/api/fin/invoices', { companyId: co.id, invoiceNo: `S3V${ts}03`, type: 'RED', issueDate: '2026-11-03', amount: '-500', taxAmount: '0', totalAmount: '-500', buyerName: cust.name, customerId: cust.id })
await desk.goto(`${APP}/receivables`)
await searchList(desk, ar2.code)
await rowAction(desk, ar2.code, '编辑')
dlg = dialog(desk, '编辑应收款')
await dlg.waitFor()
await desk.waitForTimeout(500)
const invSel = dlg.locator('.el-form-item', { hasText: '发票' }).filter({ has: desk.locator('.el-select') }).first().locator('.el-select')
await pickOption(desk, invSel, inv2.invoiceNo)
await desk.keyboard.press('Escape') // 多选选完一张下拉不收起，先关掉再点开搜下一张
await desk.waitForTimeout(300)
await pickOption(desk, invSel, inv3.invoiceNo)
await desk.keyboard.press('Escape')
const sumText = (await dlg.locator('.ip-sum').innerText()).replace(/\s+/g, ' ')
console.log('  表单汇总：' + sumText)
check('汇总 = 价税合计 3000 / 红字 500 / 已开票 2500 / 差额 500', sumText.includes('价税合计 ¥3,000.00') && sumText.includes('红字冲减 ¥500.00') && sumText.includes('已开票合计 ¥2,500.00') && sumText.includes('未开票差额 ¥500.00'))
await clearToasts(desk)
await dlg.getByRole('button', { name: '保存' }).click()
await desk.waitForTimeout(1200)
console.log('  toast：' + (await desk.locator('.el-message').allInnerTexts()).join(' / '))
const det = await api('GET', `/api/fin/receivables/${ar2.id}`)
console.log('  接口回读：' + JSON.stringify({ invoices: det.invoices.map((i) => `${i.invoiceNo}/${i.type}/${i.totalAmount}`), invoiceSummary: det.invoiceSummary }))
check('保存后两张发票挂上', det.invoices.length === 2 && det.invoiceSummary.invoicedTotal === '2500.00')

// ── ⑥ 375 ──
head('⑥ 375 宽：三个弹窗不横向溢出、按钮 ≥44px、完成一次认领')
const mob = await newPage(375, 812, true)
await mob.goto(`${APP}/receivables`)
await searchList(mob, ar6.code)
await rowAction(mob, ar6.code, '认领流水')
dlg = dialog(mob, '认领流水')
await dlg.waitFor()
await dlg.getByPlaceholder('搜索对方名称 / 流水号 / 备注').fill(t6.code)
await dlg.getByRole('button', { name: '查询' }).click()
await mob.waitForTimeout(600)
widthLog.push(['认领流水·选流水', 375, await widths(mob)])
await mob.screenshot({ path: `${OUT}/375-receipt-pick.png` })
await dlg.locator('.m-card', { hasText: t6.code }).click()
await dlg.getByRole('button', { name: '下一步' }).click()
widthLog.push(['认领流水·确认金额', 375, await widths(mob)])
await mob.screenshot({ path: `${OUT}/375-receipt-confirm.png` })
await clearToasts(mob)
await dlg.getByRole('button', { name: '确认认领' }).click()
msg = await toast(mob)
console.log(`  375 认领 toast：${msg}`)
check('375 完成一次认领', msg === `已认领 ¥1,200.00 到 ${ar6.code}`)

// 拆分弹窗：再造一笔流水
const t7 = await mkTxn(600, `银行导入 手机拆分 ${ts}`)
await mob.goto(`${APP}/transactions`)
await searchList(mob, t7.code)
await mob.locator('.m-card', { hasText: t7.code }).first().getByRole('button', { name: '认领到应收' }).click()
dlg = dialog(mob, '认领到应收')
await dlg.locator('.rd-row').first().waitFor()
await dlg.getByRole('button', { name: '再拆一笔' }).click()
await mob.waitForTimeout(300)
widthLog.push(['认领到应收（拆分）', 375, await widths(mob)])
await mob.screenshot({ path: `${OUT}/375-reconcile.png` })
await dlg.getByRole('button', { name: '取消' }).click()

await mob.goto(`${APP}/invoices`)
await searchList(mob, inv.invoiceNo)
await mob.locator('.m-card', { hasText: inv.invoiceNo }).first().getByRole('button', { name: '挂应收' }).click()
dlg = dialog(mob, '发票挂应收')
await dlg.waitFor()
await mob.waitForTimeout(500)
widthLog.push(['发票挂应收', 375, await widths(mob)])
await mob.screenshot({ path: `${OUT}/375-invoice-link.png` })

head('宽度检查（scrollWidth == innerWidth；弹窗 / 遮罩无横向滚动；底部按钮高度）')
for (const [name, w, r] of widthLog) {
  const btnOk = w !== 375 || r.footerBtnHeights.every((h) => h >= 44)
  check(`${w} ${name}`, okWidth(r) && btnOk, JSON.stringify(r))
}

await browser.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败；截图在 ${OUT}`)
process.exit(fail ? 1 : 0)
