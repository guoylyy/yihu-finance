// v1.4 切片 2 接口验收：在本地 dev 库自建两家公司（S2V-<时间戳>-A/B）造数，逐项打印接口返回与 SQL 原文
// 用法（backend/ 下）：set -a; source .env.local; set +a; node scripts/verify-v140-s2.mjs --base http://127.0.0.1:3029
// 只连 DATABASE_URL 指向的库；库名不是 *_dev 直接退出，防止误打到平台库 / 生产
import { PrismaClient } from '@prisma/client'

const argv = process.argv.slice(2)
const BASE = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'http://127.0.0.1:3029'
const db = new PrismaClient()
const dbName = (await db.$queryRawUnsafe('SELECT DATABASE() AS d'))[0].d
if (!/_dev$/.test(dbName)) { console.error(`✘ 当前库 ${dbName} 不是 dev 库，拒绝运行`); process.exit(2) }

const j = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x))
let token
async function call(method, url, body, tk = token) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}
async function must(method, url, body, tk) {
  const r = await call(method, url, body, tk)
  if (r.code !== 0) throw new Error(`${method} ${url} → ${r.code} ${r.message}`)
  return r.data
}
let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? `  ${extra}` : ''}`)
}
const sql = (q) => db.$queryRawUnsafe(q)
const show = (rows) => rows.forEach((r) => console.log('    ' + j(r)))
const head = (t) => console.log(`\n━━ ${t} ━━`)

token = (await must('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, '')).token
const ts = Date.now().toString().slice(-7)
const coA = await must('POST', '/api/fin/companies', { code: `S2V-${ts}-A`, name: `切片2验收A-${ts}` })
const coB = await must('POST', '/api/fin/companies', { code: `S2V-${ts}-B`, name: `切片2验收B-${ts}` })
const accA = await must('POST', '/api/fin/accounts', { companyId: coA.id, name: `A基本户-${ts}`, type: 'BANK' })
const accB = await must('POST', '/api/fin/accounts', { companyId: coB.id, name: `B基本户-${ts}`, type: 'BANK' })
const cust = await must('POST', '/api/fin/customers', { companyId: coA.id, name: `客户甲${ts}` })
console.log(`库 ${dbName}｜公司 A=${coA.id}（${coA.code}） B=${coB.id}｜账户 A=${accA.id} B=${accB.id}｜客户 ${cust.id}`)

const mkAR = (amount, title) => must('POST', '/api/fin/receivables', { companyId: coA.id, customerId: cust.id, title, amount: String(amount) })
const mkTxn = (amount, { co = coA, acc = accA, dir = 'IN', date = '2026-11-02', cp = cust.name, remark } = {}) =>
  must('POST', '/api/fin/transactions', { companyId: co.id, accountId: acc.id, txnDate: date, direction: dir, amount: String(amount), counterparty: cp, remark })
const txnCount = async () => Number((await sql(`SELECT COUNT(*) n FROM transactions WHERE company_id=${coA.id} AND deleted_at IS NULL`))[0].n)
const arRow = (id) => sql(`SELECT id, code, amount, received_amount, status, actual_date FROM receivables WHERE id=${id}`)
const txnRow = (id) => sql(`SELECT id, code, amount, ref_type, ref_id, status, deleted_at FROM transactions WHERE id=${id}`)
const rcpRows = (where) => sql(`SELECT id, receivable_id, transaction_id, amount, source, txn_status_before, active_flag, deleted_at FROM receipts WHERE ${where} ORDER BY id`)

// ─── 1 ───
head('1. 先有流水后认领（不新建流水）')
{
  const ar = await mkAR(10000, '场景1 先有流水')
  const t = await mkTxn(10000, { remark: '银行导入：客户甲货款' })
  const n0 = await txnCount()
  const d = await must('POST', `/api/fin/receivables/${ar.id}/receipt`, { transactionId: t.id, amount: '10000' })
  const n1 = await txnCount()
  console.log(`  流水总数 认领前 ${n0} → 认领后 ${n1}；响应 transaction.id=${d.transaction.id}（=造的流水 ${t.id}） receipt.source=${d.receipt.source} prepayment=${j(d.prepayment)}`)
  show(await arRow(ar.id)); show(await txnRow(t.id)); show(await rcpRows(`receivable_id=${ar.id}`))
  const [a] = await arRow(ar.id); const [tx] = await txnRow(t.id); const rs = await rcpRows(`receivable_id=${ar.id}`)
  check('流水总数不变', n0 === n1)
  check('响应 data.transaction 是被认领的那笔', String(d.transaction.id) === String(t.id))
  check('receipts 1 行 source=LINK', rs.length === 1 && rs[0].source === 'LINK' && rs[0].txn_status_before === 'UNRECONCILED')
  check('应收 received=10000 RECEIVED', Number(a.received_amount) === 10000 && a.status === 'RECEIVED')
  check('流水 refType=RECEIVABLE refId=应收 status=RECONCILED', tx.ref_type === 'RECEIVABLE' && String(tx.ref_id) === String(ar.id) && tx.status === 'RECONCILED')
}

// ─── 2 ───
head('2. 没流水时新建（回归，不传 transactionId）')
{
  const ar = await mkAR(8000, '场景2 新建流水')
  const n0 = await txnCount()
  const d = await must('POST', `/api/fin/receivables/${ar.id}/receipt`, { accountId: accA.id, amount: '3000', receiptDate: '2026-11-03' })
  const n1 = await txnCount()
  console.log(`  流水总数 ${n0} → ${n1}；data.transaction=${j({ id: d.transaction.id, code: d.transaction.code, bizType: d.transaction.bizType, refType: d.transaction.refType, status: d.transaction.status, remark: d.transaction.remark })}`)
  show(await arRow(ar.id)); show(await rcpRows(`receivable_id=${ar.id}`))
  const [a] = await arRow(ar.id); const rs = await rcpRows(`receivable_id=${ar.id}`)
  check('新建 1 笔流水', n1 === n0 + 1)
  check('流水字段与 v1.3.2 一致（SALES_RECEIPT / RECEIVABLE / RECONCILED / 「AR 回款」备注）', d.transaction.bizType === 'SALES_RECEIPT' && d.transaction.refType === 'RECEIVABLE' && d.transaction.status === 'RECONCILED' && d.transaction.remark === `${ar.code} 回款`)
  check('receipts 1 行 source=AUTO', rs.length === 1 && rs[0].source === 'AUTO')
  check('receivedAmount=3000 PARTIAL', Number(a.received_amount) === 3000 && a.status === 'PARTIAL')
}

// ─── 3 ───
head('3. 一笔流水拆两笔应收（POST /transactions/:id/reconcile）')
{
  const ar1 = await mkAR(12000, '场景3 AR1')
  const ar2 = await mkAR(8000, '场景3 AR2')
  const t = await mkTxn(20000)
  const half = await must('POST', `/api/fin/transactions/${t.id}/reconcile`, { items: [{ receivableId: ar1.id, amount: '12000' }, { receivableId: ar2.id, amount: '5000' }] })
  console.log(`  响应：allocatedAmount=${half.allocatedAmount} remainingAmount=${half.remainingAmount}`)
  half.results.forEach((r) => console.log(`    ${r.receivable.code} 本次 ${r.amount} 入应收 ${r.receiptAmount} → ${r.receivable.status} 已收 ${r.receivable.receivedAmount}`))
  const cand = await must('GET', `/api/fin/receivables/${ar2.id}/receipt-candidates?amount=3000`)
  const c = cand.list.find((x) => x.id === String(t.id))
  console.log(`  候选里这笔流水：${j(c && { code: c.code, amount: c.amount, claimedAmount: c.claimedAmount, remainingAmount: c.remainingAmount, allocations: c.allocations.map((a) => `${a.receivableCode}:${a.amount}`), match: c.match })}`)
  const rest = await must('POST', `/api/fin/transactions/${t.id}/reconcile`, { items: [{ receivableId: ar2.id, amount: '3000' }] }).catch((e) => e.message)
  console.log(`  再对 AR2 认领 3000（同流水×同应收已有一条有效认领）→ ${typeof rest === 'string' ? rest : 'OK'}`)
  const ar3 = await mkAR(3000, '场景3 AR3')
  const r3 = await must('POST', `/api/fin/transactions/${t.id}/reconcile`, { items: [{ receivableId: ar3.id, amount: '3000' }] })
  console.log(`  剩余 3000 给 AR3 → remainingAmount=${r3.remainingAmount}`)
  const over = await call('POST', `/api/fin/transactions/${t.id}/reconcile`, { items: [{ receivableId: ar2.id, amount: '0.01' }] })
  console.log(`  流水已认领满，再认领 0.01 → code=${over.code} ${over.message}`)
  show(await txnRow(t.id)); show(await rcpRows(`transaction_id=${t.id}`)); show(await arRow(ar1.id)); show(await arRow(ar2.id)); show(await arRow(ar3.id))
  const rs = await rcpRows(`transaction_id=${t.id} AND deleted_at IS NULL`)
  const [tx] = await txnRow(t.id)
  check('第一次拆分：两条 Receipt、流水剩余 3000', half.results.length === 2 && half.remainingAmount === '3000.00')
  check('候选里剩余可认领 = 3000、已认领 = 17000', c?.remainingAmount === '3000.00' && c?.claimedAmount === '17000.00')
  check('同流水×同应收重复认领被拒', typeof rest === 'string' && rest.includes('已认领过'))
  check('流水 RECEIVABLE_MULTI、3 条有效 Receipt 合计 20000', tx.ref_type === 'RECEIVABLE_MULTI' && rs.length === 3 && rs.reduce((s, r) => s + Number(r.amount), 0) === 20000)
  check('超出流水剩余 → 400', over.code === 9002)
}

// ─── 4 ───
head('4. 一笔应收收两次（两笔流水各认领一部分）')
{
  const ar = await mkAR(20000, '场景4 分两次收')
  const t1 = await mkTxn(12000, { date: '2026-11-01' })
  const t2 = await mkTxn(8000, { date: '2026-11-03' })
  const d1 = await must('POST', `/api/fin/receivables/${ar.id}/receipt`, { transactionId: t1.id, amount: '12000' })
  console.log(`  第一次后：${d1.receivable.status} 已收 ${d1.receivable.receivedAmount}`)
  const d2 = await must('POST', `/api/fin/receivables/${ar.id}/receipt`, { transactionId: t2.id, amount: '8000' })
  console.log(`  第二次后：${d2.receivable.status} 已收 ${d2.receivable.receivedAmount} actualDate ${String(d2.receivable.actualDate).slice(0, 10)}`)
  show(await arRow(ar.id)); show(await rcpRows(`receivable_id=${ar.id}`))
  check('PARTIAL 12000 → RECEIVED 20000', d1.receivable.status === 'PARTIAL' && Number(d1.receivable.receivedAmount) === 12000 && d2.receivable.status === 'RECEIVED' && Number(d2.receivable.receivedAmount) === 20000)
  check('actualDate = 第二笔流水日期 2026-11-03', String(d2.receivable.actualDate).startsWith('2026-11-03'))
}

// ─── 5 ───
let s5 = {}
head('5. 超收转预收：应收剩 2000，认领 5000')
{
  const ar = await mkAR(10000, '场景5 超收')
  const t0 = await mkTxn(8000, { date: '2026-11-01' })
  await must('POST', `/api/fin/receivables/${ar.id}/receipt`, { transactionId: t0.id, amount: '8000' })
  const t = await mkTxn(5000, { date: '2026-11-04' })
  const d = await must('POST', `/api/fin/receivables/${ar.id}/receipt`, { transactionId: t.id, amount: '5000' })
  console.log(`  响应 receivable：${d.receivable.status} 已收 ${d.receivable.receivedAmount}｜receipt.amount=${d.receipt.amount}｜overpaidAmount=${d.overpaidAmount}`)
  console.log(`  响应 prepayment：${j({ id: d.prepayment?.id, code: d.prepayment?.code, amount: d.prepayment?.amount, source: d.prepayment?.source, status: d.prepayment?.status, transactionId: d.prepayment?.transactionId, receivableId: d.prepayment?.receivableId, receiptId: d.prepayment?.receiptId, remark: d.prepayment?.remark })}`)
  console.log('  SQL 两条记录：')
  show(await sql(`SELECT id, receivable_id, transaction_id, amount, source FROM receipts WHERE id=${d.receipt.id}`))
  show(await sql(`SELECT id, code, company_id, customer_id, amount, used_amount, prepay_date, account_id, transaction_id, receivable_id, receipt_id, source, status, remark FROM prepayments WHERE id=${d.prepayment.id}`))
  show(await arRow(ar.id)); show(await txnRow(t.id))
  const list = await must('GET', `/api/fin/prepayments?company_id=${coA.id}`)
  console.log(`  GET /prepayments 客户维度：${j(list.byCustomer)} 合计余额 ${list.balanceTotal}`)
  check('应收结清 RECEIVED 10000', d.receivable.status === 'RECEIVED' && Number(d.receivable.receivedAmount) === 10000)
  check('Receipt 2000 + Prepayment 3000（OVERPAY，挂同一流水）', Number(d.receipt.amount) === 2000 && Number(d.prepayment.amount) === 3000 && d.prepayment.source === 'OVERPAY' && String(d.prepayment.transactionId) === String(t.id))
  check('响应带 prepayment 字段', !!d.prepayment && d.overpaidAmount === '3000.00')
  check('客户维度余额 3000', list.byCustomer.some((x) => x.customerId === String(cust.id) && x.balance === '3000.00'))
  s5 = { ar, t, d }

  // 不传 transactionId 的老路径同样超收转预收
  const ar2 = await mkAR(1000, '场景5b 新建流水超收')
  const d2 = await must('POST', `/api/fin/receivables/${ar2.id}/receipt`, { accountId: accA.id, amount: '1500', receiptDate: '2026-11-04' })
  console.log(`  5b 不传 transactionId，应收 1000 收 1500：流水 ${d2.transaction.code} ${d2.transaction.amount}｜receipt ${d2.receipt.amount}｜prepayment ${d2.prepayment?.code} ${d2.prepayment?.amount}｜应收 ${d2.receivable.status}`)
  check('5b 新建流水路径：流水 1500、Receipt 1000、预收 500', Number(d2.transaction.amount) === 1500 && Number(d2.receipt.amount) === 1000 && Number(d2.prepayment?.amount) === 500)
}

// ─── 6 ───
head('6. 撤销认领 DELETE /receipts/:id')
{
  const { ar, t, d } = s5
  console.log('  撤销前：'); show(await arRow(ar.id)); show(await txnRow(t.id)); show(await rcpRows(`id=${d.receipt.id}`))
  const r = await must('DELETE', `/api/fin/receipts/${d.receipt.id}`)
  console.log(`  响应：voidedTransaction=${r.voidedTransaction} revokedPrepayments=${r.revokedPrepayments.map((p) => p.code).join(',')}｜应收 ${r.receivable.status} 已收 ${r.receivable.receivedAmount}｜流水 ${r.transaction.refType}/${r.transaction.status}`)
  console.log('  撤销后：'); show(await arRow(ar.id)); show(await txnRow(t.id)); show(await rcpRows(`id=${d.receipt.id}`))
  show(await sql(`SELECT id, code, amount, deleted_at IS NOT NULL AS deleted FROM prepayments WHERE id=${d.prepayment.id}`))
  const [a] = await arRow(ar.id); const [tx] = await txnRow(t.id); const [rc] = await rcpRows(`id=${d.receipt.id}`)
  check('应收已收回退 10000 → 8000，PARTIAL', Number(a.received_amount) === 8000 && a.status === 'PARTIAL')
  check('流水状态恢复 UNRECONCILED、refType 清空、未作废', tx.status === 'UNRECONCILED' && tx.ref_type === null && tx.deleted_at === null)
  check('receipt 软删 + activeFlag=NULL', rc.deleted_at !== null && rc.active_flag === null)
  check('同次认领转出的预收一并撤销', r.revokedPrepayments.length === 1)
  const again = await call('DELETE', `/api/fin/receipts/${d.receipt.id}`)
  check('重复撤销 → 404', again.code !== 0, `${again.code} ${again.message}`)

  // AUTO 撤销：流水一并作废、余额回退
  const ar2 = await mkAR(500, '场景6b AUTO 撤销')
  const bal0 = Number((await sql(`SELECT balance FROM accounts WHERE id=${accA.id}`))[0].balance)
  const d2 = await must('POST', `/api/fin/receivables/${ar2.id}/receipt`, { accountId: accA.id, amount: '500', receiptDate: '2026-11-04' })
  const bal1 = Number((await sql(`SELECT balance FROM accounts WHERE id=${accA.id}`))[0].balance)
  const r2 = await must('DELETE', `/api/fin/receipts/${d2.receipt.id}`)
  const bal2 = Number((await sql(`SELECT balance FROM accounts WHERE id=${accA.id}`))[0].balance)
  console.log(`  6b AUTO 撤销：voidedTransaction=${r2.voidedTransaction}；账户余额 ${bal0} → 回款后 ${bal1} → 撤销后 ${bal2}`)
  check('6b AUTO 撤销：流水作废、余额回退', r2.voidedTransaction && bal1 === bal0 + 500 && bal2 === bal0)
}

// ─── 7 ───
head('7. 候选过滤：已挂付款单 / OUT / 别家公司 / 借款还款 / 认领满的')
{
  const ar = await mkAR(6666, '场景7 候选过滤')
  const ok1 = await mkTxn(6666, { remark: 'S7 应出现' })
  const tOut = await mkTxn(6666, { dir: 'OUT', remark: 'S7 OUT' })
  const tB = await mkTxn(6666, { co: coB, acc: accB, remark: 'S7 别家公司' })
  const tPay = await mkTxn(6666, { remark: 'S7 挂付款单' })
  const pay = await db.payment.create({ data: { code: `PAY-S2V-${ts}`, companyId: BigInt(coA.id), accountId: BigInt(accA.id), payType: 'OTHER', payeeName: 'S7', amount: 6666, status: 'APPROVED' } })
  const link = await must('POST', `/api/fin/payments/${pay.id}/link-transaction`, { transactionId: tPay.id })
  const tLoan = await mkTxn(6666, { remark: 'S7 挂借款还款' })
  const loan = await db.loan.create({ data: { code: `LN-S2V-${ts}`, companyId: BigInt(coA.id), direction: 'COMPANY_TO_COMPANY', principal: 6666, counterpartyName: 'S7' } })
  await db.loanRepayment.create({ data: { loanId: loan.id, repayDate: new Date('2026-11-02'), amount: 6666, transactionId: BigInt(tLoan.id) } })
  const tFull = await mkTxn(6666, { remark: 'S7 认领满' })
  const arF = await mkAR(6666, '场景7 吃满')
  await must('POST', `/api/fin/receivables/${arF.id}/receipt`, { transactionId: tFull.id, amount: '6666' })
  console.log(`  付款单 ${pay.code} 关联流水 ${tPay.code} → payments.transaction_id=${link.transactionId ?? (await db.payment.findUnique({ where: { id: pay.id } })).transactionId}`)

  const cand = await must('GET', `/api/fin/receivables/${ar.id}/receipt-candidates?amount=6666&keyword=S7`)
  const candAll = await must('GET', `/api/fin/receivables/${ar.id}/receipt-candidates?amount=6666&keyword=S7&includeUsed=1`)
  const ids = cand.list.map((x) => x.id)
  console.log(`  候选（keyword=S7）total=${cand.total}：${cand.list.map((x) => `${x.code}「${x.remark}」剩余 ${x.remainingAmount} match=${j(x.match)}`).join('；')}`)
  console.log(`  includeUsed=1 total=${candAll.total}：${candAll.list.map((x) => `${x.code}「${x.remark}」剩余 ${x.remainingAmount}`).join('；')}`)
  const expect = [[ok1, true, 'IN 未认领'], [tOut, false, 'OUT 方向'], [tB, false, '别家公司'], [tPay, false, '已挂付款单'], [tLoan, false, '已挂借款还款'], [tFull, false, '已认领满（默认不出现）']]
  for (const [t, want, why] of expect) {
    const hit = ids.includes(String(t.id))
    check(`${t.code}（${why}）${want ? '命中' : '排除'}`, hit === want, hit ? '→ 在候选里' : '→ 不在候选里')
  }
  check('includeUsed=1 时认领满的出现、其余排除项仍不出现', candAll.list.some((x) => x.id === String(tFull.id)) && ![tOut, tB, tPay, tLoan].some((t) => candAll.list.some((x) => x.id === String(t.id))))
  // 直接拿被排除的流水去认领，也应被拒
  for (const [t, why] of [[tOut, 'OUT'], [tPay, '付款单'], [tLoan, '借款还款'], [tB, '别家公司']]) {
    const r = await call('POST', `/api/fin/receivables/${ar.id}/receipt`, { transactionId: t.id, amount: '1' })
    check(`直接认领 ${why} 流水被拒`, r.code !== 0, `${r.code} ${r.message}`)
  }
}

// ─── 8 ───
head('8. 发票挂应收 + 红字冲减')
{
  const ar = await mkAR(10000, '场景8 发票')
  const ar2 = await mkAR(500, '场景8 另一笔')
  const mkInv = (no, type, total, co = coA) => must('POST', '/api/fin/invoices', { companyId: co.id, invoiceNo: `S2V${ts}${no}`, type, issueDate: '2026-11-02', amount: String(total), taxAmount: '0', totalAmount: String(total), buyerName: cust.name, customerId: co === coA ? cust.id : undefined })
  const i1 = await mkInv('01', 'SALES', 6000)
  const i2 = await mkInv('02', 'SALES', 4000)
  const iRed = await mkInv('03', 'RED', -1000)
  const iPur = await mkInv('04', 'PURCHASE', 100)
  const iB = await mkInv('05', 'SALES', 100, coB)
  for (const i of [i1, i2, iRed]) {
    const r = await must('PATCH', `/api/fin/invoices/${i.id}`, { receivableId: ar.id })
    console.log(`  PATCH ${i.invoiceNo}（${i.type} ${i.totalAmount}）→ receivable=${r.receivable?.code} warnings=${j(r.warnings)} 汇总=${j(r.invoiceSummary[String(ar.id)])}`)
  }
  const lst = await must('GET', `/api/fin/invoices?receivableId=${ar.id}`)
  console.log(`  GET /invoices?receivableId=${ar.id} → total=${lst.total}：${lst.list.map((x) => `${x.invoiceNo}/${x.type}/${x.totalAmount}`).join('，')}`)
  const det = await must('GET', `/api/fin/receivables/${ar.id}`)
  console.log(`  GET /receivables/${ar.id} invoiceSummary=${j(det.invoiceSummary)}；应收金额仍为 ${det.amount}`)
  check('GET ?receivableId= 只返回这 3 张', lst.total === 3 && lst.list.every((x) => String(x.receivableId) === String(ar.id)))
  check('红字冲减：6000+4000−1000 = 已开票 9000，未开票 1000，应收金额不变', det.invoiceSummary.invoicedTotal === '9000.00' && det.invoiceSummary.redTotal === '1000.00' && det.invoiceSummary.uninvoicedAmount === '1000.00' && Number(det.amount) === 10000)
  const mv = await must('PATCH', `/api/fin/invoices/${i2.id}`, { receivableId: ar2.id })
  console.log(`  改挂 ${i2.invoiceNo} → ${ar2.code}：warnings=${j(mv.warnings)} 汇总=${j(mv.invoiceSummary)}`)
  const un = await must('PATCH', `/api/fin/invoices/${i2.id}`, { receivableId: null })
  console.log(`  摘除 ${i2.invoiceNo}：receivableId=${un.receivableId}`)
  const det2 = await must('GET', `/api/fin/receivables/${ar.id}`)
  check('改挂后原应收已开票 5000（6000−1000）', det2.invoiceSummary.invoicedTotal === '5000.00')
  check('摘除后 receivableId=null', un.receivableId === null)
  const rPur = await call('PATCH', `/api/fin/invoices/${iPur.id}`, { receivableId: ar.id })
  const rB = await call('PATCH', `/api/fin/invoices/${iB.id}`, { receivableId: ar.id })
  check('进项发票挂应收被拒', rPur.code === 9002, rPur.message)
  check('别家公司发票挂应收被拒', rB.code === 9002, rB.message)
}

// ─── 加验：关账 / 权限 / 并发 ───
head('加验：关账月份流水不能认领 / 并发认领同一流水 / 权限与数据范围')
{
  const ar = await mkAR(30000, '加验')
  const tOld = await mkTxn(100, { date: '2026-09-15' })
  await db.closePeriod.create({ data: { companyId: BigInt(coA.id), period: '2026-09', status: 'CLOSED' } })
  const rLock = await call('POST', `/api/fin/receivables/${ar.id}/receipt`, { transactionId: tOld.id, amount: '100' })
  check('关账月份的流水认领 → 400', rLock.code === 9002, rLock.message)
  const t = await mkTxn(20000)
  const [x, y] = await Promise.all([
    call('POST', `/api/fin/receivables/${ar.id}/receipt`, { transactionId: t.id, amount: '15000' }),
    call('POST', `/api/fin/transactions/${t.id}/reconcile`, { items: [{ receivableId: ar.id, amount: '15000' }] })
  ])
  console.log(`  并发两个 15000：${x.code} ${x.message} ｜ ${y.code} ${y.message}`)
  check('并发：只成功一个', [x, y].filter((r) => r.code === 0).length === 1)
  const rs = await sql(`SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE transaction_id=${t.id} AND deleted_at IS NULL`)
  check('并发后流水已认领 15000（未超认）', Number(rs[0].s) === 15000)
  const rPut = await call('PUT', `/api/fin/transactions/${t.id}`, { amount: '100' })
  check('改流水金额低于已认领 → 400', rPut.code === 9002, rPut.message)

  // 权限 / 数据范围：VIEWER 没有 manage；只能看 B 公司的 FINANCE 碰不到 A 公司的应收 / 流水 / 认领
  const pw = 'S2v-pass-123'
  await must('POST', '/api/fin/users', { username: `s2v_viewer_${ts}`, password: pw, name: 'S2V只读', role: 'VIEWER' })
  await must('POST', '/api/fin/users', { username: `s2v_finb_${ts}`, password: pw, name: 'S2V财务B', role: 'FINANCE', companyScope: [coB.id] })
  const tkV = (await must('POST', '/api/auth/login', { username: `s2v_viewer_${ts}`, password: pw }, '')).token
  const tkB = (await must('POST', '/api/auth/login', { username: `s2v_finb_${ts}`, password: pw }, '')).token
  const t2 = await mkTxn(10)
  const rcp = (await sql(`SELECT id FROM receipts WHERE transaction_id=${t.id} AND deleted_at IS NULL LIMIT 1`))[0].id
  const cases = [
    ['VIEWER GET receipt-candidates', 'GET', `/api/fin/receivables/${ar.id}/receipt-candidates`, null, tkV],
    ['VIEWER POST 认领', 'POST', `/api/fin/receivables/${ar.id}/receipt`, { transactionId: t2.id, amount: '1' }, tkV],
    ['VIEWER POST reconcile', 'POST', `/api/fin/transactions/${t2.id}/reconcile`, { items: [{ receivableId: ar.id, amount: '1' }] }, tkV],
    ['VIEWER DELETE receipt', 'DELETE', `/api/fin/receipts/${rcp}`, null, tkV],
    ['VIEWER PATCH invoice', 'PATCH', `/api/fin/invoices/1`, { receivableId: null }, tkV],
    ['VIEWER POST prepayments', 'POST', `/api/fin/prepayments`, { companyId: coA.id, amount: '1', prepayDate: '2026-11-01' }, tkV],
    ['B 财务 GET A 公司应收候选', 'GET', `/api/fin/receivables/${ar.id}/receipt-candidates`, null, tkB],
    ['B 财务 认领 A 公司流水到 A 应收', 'POST', `/api/fin/receivables/${ar.id}/receipt`, { transactionId: t2.id, amount: '1' }, tkB],
    ['B 财务 reconcile A 公司流水', 'POST', `/api/fin/transactions/${t2.id}/reconcile`, { items: [{ receivableId: ar.id, amount: '1' }] }, tkB],
    ['B 财务 撤销 A 公司认领', 'DELETE', `/api/fin/receipts/${rcp}`, null, tkB],
    ['B 财务 登记 A 公司预收', 'POST', `/api/fin/prepayments`, { companyId: coA.id, amount: '1', prepayDate: '2026-11-01' }, tkB]
  ]
  for (const [name, m, url, body, tk] of cases) {
    const r = await call(m, url, body, tk)
    check(`${name} → 拒绝`, r.code !== 0, `${r.code} ${r.message}`)
  }
  const lst = await must('GET', `/api/fin/prepayments?company_id=${coA.id}`, null, tkB)
  check('B 财务 GET /prepayments?company_id=A → 空（范围过滤）', lst.total === 0, `total=${lst.total}`)
}

// 全局一致性：本次造的应收 received_amount 与 receipts 汇总一致
const bad = await sql(`SELECT r.code, r.received_amount, IFNULL(s.t,0) t FROM receivables r
  LEFT JOIN (SELECT receivable_id, SUM(amount) t FROM receipts WHERE deleted_at IS NULL GROUP BY receivable_id) s ON s.receivable_id=r.id
  WHERE r.company_id IN (${coA.id},${coB.id}) AND r.deleted_at IS NULL AND r.received_amount <> IFNULL(s.t,0)`)
head('一致性')
check('本次造的应收 received_amount 全部 = receipts 汇总', bad.length === 0, j(bad))
const over = await sql(`SELECT t.code, t.amount, IFNULL(r.s,0)+IFNULL(p.s,0) claimed FROM transactions t
  LEFT JOIN (SELECT transaction_id, SUM(amount) s FROM receipts WHERE deleted_at IS NULL GROUP BY transaction_id) r ON r.transaction_id=t.id
  LEFT JOIN (SELECT transaction_id, SUM(amount) s FROM prepayments WHERE deleted_at IS NULL GROUP BY transaction_id) p ON p.transaction_id=t.id
  WHERE t.company_id=${coA.id} AND IFNULL(r.s,0)+IFNULL(p.s,0) > t.amount`)
check('没有流水被超额认领', over.length === 0, j(over))

console.log(`\n合计：通过 ${pass}，失败 ${fail}（测试公司 ${coA.code} / ${coB.code} 保留在 dev 库供查看）`)
await db.$disconnect()
process.exit(fail ? 1 : 0)
