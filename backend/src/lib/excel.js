// 银行流水导入解析 + 通用导出
// 支持 CSV / XLS / XLSX，列名自动识别（各行的表头位置不固定，先扫描定位表头行）
import XLSX from 'xlsx'
import crypto from 'crypto'
import dayjs from 'dayjs'
import { parseAmount, round2 } from './money.js'

// 列名候选词典 —— 覆盖工行/农行/建行/招行/支付宝/微信导出的常见叫法
// 每个字段的候选列名，**按优先级从高到低**排列：
// 先拿词典里靠前的词去所有列里找，找到就定下来，避免「交易类型」抢了「摘要」的位置
const COLS = {
  date: ['交易日期', '交易日', '记账日期', '入账日期', '交易时间', '日期', 'date'],
  amount: ['交易金额', '发生金额', '发生额', '金额', 'amount'],
  income: ['收入金额', '贷方发生额', '贷方金额', '存入金额', '收入(元)', '收入'],
  expense: ['支出金额', '借方发生额', '借方金额', '支取金额', '支出(元)', '支出'],
  balance: ['账户余额', '当前余额', '余额(元)', '余额'],
  counterparty: [
    '对方户名', '对方名称', '对方账户名称', '对方单位名称', '对手户名', '交易对方',
    '收(付)方名称', '收付方名称', '收款人姓名', '收款人名称', '付款方名称', '方名称'
  ],
  counterAccount: ['对方账号', '对方卡号', '对方账户', '收(付)方账号', '收付方账号', '对方account'],
  summary: ['摘要', '交易摘要', '摘要说明', '用途', '附言', '商品说明', '交易类型', '备注']
}

function norm(v) {
  return String(v ?? '').replace(/\s|　/g, '').toLowerCase()
}

function matchCol(cell, keys) {
  const c = norm(cell)
  if (!c) return false
  return keys.some((k) => c.includes(norm(k)))
}

/** 在前 15 行里找出最像表头的那一行 */
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i] || []
    const hasDate = row.some((c) => matchCol(c, COLS.date))
    const hasMoney = row.some(
      (c) => matchCol(c, COLS.amount) || matchCol(c, COLS.income) || matchCol(c, COLS.expense)
    )
    if (hasDate && hasMoney) return i
  }
  return -1
}

// 收入/支出双列要先认，否则「收入金额」会被通用词「金额」抢去当成单列金额
const FIELD_ORDER = ['date', 'income', 'expense', 'amount', 'balance', 'counterparty', 'counterAccount', 'summary']

function buildColumnMap(header) {
  const map = {}
  const taken = new Set()
  for (const key of FIELD_ORDER) {
    for (const word of COLS[key]) {
      const idx = header.findIndex((cell, i) => {
        if (taken.has(i) || !matchCol(cell, [word])) return false
        // 单列金额不能落在「收入金额 / 支出金额 / 借方 / 贷方」这种分列表头上
        if (key === 'amount' && /收入|支出|借方|贷方|存入|支取/.test(String(cell))) return false
        return true
      })
      if (idx >= 0) { map[key] = idx; taken.add(idx); break }
    }
  }
  // 「金额」与「收入/支出」同时命中时，以收入/支出双列为准
  if (map.income !== undefined && map.expense !== undefined) delete map.amount
  return map
}

function parseDate(v) {
  if (v == null || v === '') return null
  if (v instanceof Date) return dayjs(v).format('YYYY-MM-DD')
  if (typeof v === 'number') {
    // Excel 日期序列号；太小的数字是笔数、金额之类，不是日期
    if (v < 20000 || v > 60000) return null
    const d = XLSX.SSF.parse_date_code(v)
    if (d) return dayjs(`${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`).format('YYYY-MM-DD')
    return null
  }
  const raw = String(v).trim()
  // 关键防线：银行导出末尾常有「总收入笔数 / 1 / 20」这类汇总行，
  // 裸数字被 dayjs 解析成 2001-01-01 会凭空多出几笔流水
  const looksLikeDate = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(raw) || /^\d{8}$/.test(raw)
  if (!looksLikeDate) return null
  const s = raw.replace(/[年月]/g, '-').replace(/日/g, '')
  const d = dayjs(/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s)
  if (!d.isValid()) return null
  const year = d.year()
  if (year < 2000 || year > 2100) return null
  return d.format('YYYY-MM-DD')
}

/** 依次用 UTF-8 / GBK 解码，返回第一种能定位到表头的网格 */
function readGrid(buffer, locate) {
  let fallback = { grid: [], headerRow: -1 }
  for (const codepage of [65001, 936]) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, codepage })
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' })
    const headerRow = locate(grid)
    if (headerRow >= 0) return { grid, headerRow }
    if (!fallback.grid.length) fallback = { grid, headerRow }
  }
  return fallback
}

/**
 * 解析银行流水文件
 * @returns {{ rows: Array, headerRow: number, columns: object, rawCount: number }}
 */
/**
 * 没有表头的导出文件（不少网银的"明细查询列表"直接就是数据），
 * 按数据形态猜列：能解析成日期的 → 日期列；数字最多的 → 金额列；
 * 文字最长的 → 对方名称；次长的 → 摘要。猜完仍要让用户在界面上确认。
 */
function inferColumns(grid) {
  const sample = grid.slice(0, Math.min(grid.length, 30)).filter((r) => r.some((c) => c !== '' && c != null))
  if (!sample.length) return null
  const width = Math.max(...sample.map((r) => r.length))
  const score = []

  for (let c = 0; c < width; c++) {
    const cells = sample.map((r) => r[c]).filter((v) => v !== '' && v != null)
    if (!cells.length) { score.push(null); continue }
    const dates = cells.filter((v) => parseDate(v)).length
    const nums = cells.filter((v) => parseAmount(v) != null && String(v).replace(/[^\d.]/g, '').length <= 12).length
    const texts = cells.filter((v) => typeof v === 'string' && /[^\d\s\-:.\/]/.test(v))
    const avgLen = texts.length ? texts.reduce((s, v) => s + String(v).length, 0) / texts.length : 0
    const distinct = new Set(cells.map(String)).size
    score.push({ col: c, dateRatio: dates / cells.length, numRatio: nums / cells.length, textRatio: texts.length / cells.length, avgLen, distinct })
  }

  const valid = score.filter(Boolean)
  const dateCol = valid.filter((s) => s.dateRatio > 0.8).sort((a, b) => a.col - b.col)[0]
  // 账号那种超长数字不是金额，用长度和小数点过滤掉
  const amountCol = valid
    .filter((s) => s.numRatio > 0.8 && s.textRatio < 0.2 && s.avgLen < 14)
    .sort((a, b) => b.distinct - a.distinct)[0]
  const textCols = valid.filter((s) => s.textRatio > 0.5 && s.avgLen >= 2).sort((a, b) => b.avgLen - a.avgLen)

  if (!dateCol || !amountCol) return null
  return {
    date: dateCol.col,
    amount: amountCol.col,
    counterparty: textCols[0]?.col,
    summary: textCols.find((t) => t.col !== textCols[0]?.col)?.col
  }
}

/**
 * 解析银行流水文件
 * @param {Buffer} buffer 文件内容
 * @param {string} fileName
 * @param {object} [mapping] 手工指定的列映射，形如
 *        { date, amount, income, expense, counterparty, counterAccount, summary, direction }
 *        direction: 'SIGN'(按金额正负，默认) | 'ALL_IN'(全部计收入) | 'ALL_OUT'(全部计支出)
 */
export function parseBankFile(buffer, fileName = '', mapping = null) {
  // CSV 的中文编码不统一：网银导出多是 GBK，手工另存多是 UTF-8。
  // 两种都试一遍，哪种能认出表头就用哪种（xlsx/xls 是二进制，codepage 不影响解析）。
  const { grid, headerRow } = readGrid(buffer, findHeaderRow)

  let columns
  let dataStart
  let headerMode

  if (mapping && (mapping.amount != null || (mapping.income != null && mapping.expense != null))) {
    // 用户在界面上指定的列优先
    columns = { ...mapping }
    dataStart = mapping.headerRow != null ? Number(mapping.headerRow) + 1 : headerRow >= 0 ? headerRow + 1 : 0
    headerMode = 'MANUAL'
  } else if (headerRow >= 0) {
    columns = buildColumnMap(grid[headerRow])
    dataStart = headerRow + 1
    headerMode = 'HEADER'
  } else {
    const guess = inferColumns(grid)
    if (!guess) {
      throw new Error('没认出这个文件的列。请在下一步「手工指定列」里选出日期列和金额列')
    }
    columns = guess
    dataStart = 0
    headerMode = 'INFERRED'
  }

  const directionMode = mapping?.direction || 'SIGN'
  const rows = []

  for (let i = dataStart; i < grid.length; i++) {
    const r = grid[i] || []
    if (r.every((c) => c === '' || c == null)) continue

    const date = parseDate(r[columns.date])
    if (!date) continue

    let direction = null
    let amount = null
    if (columns.amount !== undefined && columns.amount !== null) {
      const a = parseAmount(r[columns.amount])
      if (a == null || a === 0) continue
      direction = directionMode === 'ALL_IN' ? 'IN' : directionMode === 'ALL_OUT' ? 'OUT' : a > 0 ? 'IN' : 'OUT'
      amount = Math.abs(a)
    } else {
      const income = parseAmount(r[columns.income])
      const expense = parseAmount(r[columns.expense])
      if (income) {
        direction = 'IN'
        amount = Math.abs(income)
      } else if (expense) {
        direction = 'OUT'
        amount = Math.abs(expense)
      } else continue
    }

    rows.push({
      rowNo: i + 1,
      txnDate: date,
      direction,
      amount: round2(amount),
      counterparty: String(r[columns.counterparty] ?? '').trim() || null,
      counterpartyAccount: String(r[columns.counterAccount] ?? '').trim() || null,
      summary: String(r[columns.summary] ?? '').trim() || null,
      balance: columns.balance !== undefined ? parseAmount(r[columns.balance]) : null
    })
  }

  return {
    rows,
    headerRow,
    headerMode,
    columns,
    // 给前端画「手工指定列」用：前 8 行原始数据
    sample: grid.slice(0, 8).map((r) => r.slice(0, 20).map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c ?? '')))),
    columnCount: Math.max(...grid.slice(0, 30).map((r) => r.length), 0),
    rawCount: grid.length - dataStart,
    fileName
  }
}

/** 导入查重指纹：同账户 + 同日期 + 同方向金额 + 同对方 + 同摘要 视为重复 */
export function dedupHash(accountId, row) {
  const key = [accountId, row.txnDate, row.direction, row.amount, row.counterparty || '', row.summary || ''].join('|')
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)
}

/**
 * 规则猜业务类型：导入后可批量改，先给一个可用的初值
 * 返回 { bizType, categoryName }
 */
/**
 * 规则猜业务类型
 * @param {object} row 解析出来的流水行
 * @param {object} [ctx] { employees: string[], contractors: string[] } 已知员工/劳务人员姓名，
 *        银行流水里对方户名是人名时，据此判为工资或劳务费，比只看摘要准得多
 */
export function guessBizType(row, ctx = {}) {
  const text = `${row.summary || ''} ${row.counterparty || ''}`
  const hit = (...words) => words.some((w) => text.includes(w))
  const name = (row.counterparty || '').trim()

  if (row.direction === 'OUT' && name) {
    const isPerson = (list) => (list || []).some((n) => n && (name === n || name.includes(n)))
    if (isPerson(ctx.employees)) return { bizType: 'SALARY', categoryName: '工资' }
    if (isPerson(ctx.contractors)) return { bizType: 'LABOR', categoryName: '劳务费' }
  }
  if (hit('代发工资', '代发薪', '工资代发')) return { bizType: 'SALARY', categoryName: '工资' }
  // 银行自己收的各种小费用，要在「工资/服务费」规则之前拦下来：
  // 「批量代发付费」含"代发"会被判成工资，「网上企业银行服务费」含"服务费"会被判成服务费
  if (hit('手续费', '代发付费', '账户管理费', '工本费', '各项费用', '费用外收',
          '银行服务费', '网上企业银行', '企业银行服务', '短信费', '年费')) {
    return { bizType: 'OTHER_OUT', categoryName: '银行手续费' }
  }
  if (hit('扣税', '国库', '税务')) return { bizType: 'TAX', categoryName: '税费' }

  if (row.direction === 'IN') {
    if (hit('还款', '归还')) return { bizType: 'REPAY', categoryName: '借款收回' }
    if (hit('借款')) return { bizType: 'LOAN', categoryName: '借入款项' }
    if (hit('退款', '退回')) return { bizType: 'OTHER_IN', categoryName: '退款' }
    if (hit('利息')) return { bizType: 'OTHER_IN', categoryName: '利息收入' }
    if (hit('转账', '内部')) return { bizType: 'TRANSFER', categoryName: '内部转账' }
    return { bizType: 'SALES_RECEIPT', categoryName: '客户回款' }
  }
  if (hit('工资', '代发', '薪资')) return { bizType: 'SALARY', categoryName: '工资' }
  if (hit('劳务')) return { bizType: 'LABOR', categoryName: '劳务费' }
  if (hit('报销')) return { bizType: 'REIMBURSE', categoryName: '报销' }
  if (hit('社保', '公积金')) return { bizType: 'SALARY', categoryName: '社保公积金' }
  if (hit('税', '税务', '增值税', '所得税')) return { bizType: 'TAX', categoryName: '税费' }
  if (hit('房租', '租金', '物业')) return { bizType: 'RENT', categoryName: '房租物业' }
  if (hit('阿里云', '腾讯云', '云服务', '服务器', '域名', '订阅', 'saas')) {
    return { bizType: 'SOFTWARE', categoryName: '软件和云服务' }
  }
  if (hit('手续费', '账户管理费', '工本费')) return { bizType: 'OTHER_OUT', categoryName: '银行手续费' }
  if (hit('采购', '货款')) return { bizType: 'PURCHASE', categoryName: '采购付款' }
  if (hit('服务费', '咨询费')) return { bizType: 'SERVICE', categoryName: '服务费' }
  if (hit('转账', '内部')) return { bizType: 'TRANSFER', categoryName: '内部转账' }
  return { bizType: 'OTHER_OUT', categoryName: '其他支出' }
}

/** 通用导出：[{列名: 值}] → xlsx Buffer */
export function toXlsxBuffer(rows, sheetName = 'Sheet1') {
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

/** 二维数组 → xlsx Buffer（用于自定义表头的银行模板） */
export function aoaToBuffer(aoa, sheetName = 'Sheet1', bookType = 'xlsx', cols) {
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  if (cols) ws['!cols'] = cols
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  return XLSX.write(wb, { type: 'buffer', bookType })
}

// ── 工资表 / 劳务费表解析 ──
const PAYROLL_COLS = {
  name: ['姓名', '员工姓名', '收款方户名'],
  gross: ['应发工资', '应发', '金额', '税前工资'],
  social: ['代扣社保金', '代扣社保', '社保', '社保金'],
  fund: ['代扣公积金', '公积金'],
  tax: ['代扣个调税', '代扣个税', '个调税', '个税'],
  net: ['实发工资数', '实发工资', '实发', '实发金额'],
  bankAccount: ['卡号', '银行卡号', '收款方账号', '账号'],
  phone: ['电话', '手机', '电话号码']
}

function findPayrollHeader(grid) {
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const row = grid[i] || []
    const hasName = row.some((c) => matchCol(c, PAYROLL_COLS.name))
    const hasMoney = row.some((c) => matchCol(c, PAYROLL_COLS.net) || matchCol(c, PAYROLL_COLS.gross))
    if (hasName && hasMoney) return i
  }
  return -1
}

export function parsePayrollFile(buffer, fileName = '') {
  const out = []
  for (const codepage of [65001, 936]) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, codepage })
    for (const sheetName of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' })
      const headerRow = findPayrollHeader(grid)
      if (headerRow < 0) continue

      const map = {}
      grid[headerRow].forEach((cell, idx) => {
        for (const [key, keys] of Object.entries(PAYROLL_COLS)) {
          if (map[key] === undefined && matchCol(cell, keys)) map[key] = idx
        }
      })

      for (let i = headerRow + 1; i < grid.length; i++) {
        const r = grid[i] || []
        const name = String(r[map.name] ?? '').trim()
        if (!name || /合计|小计|总计|备注|说明/.test(name)) continue
        const gross = parseAmount(r[map.gross]) || 0
        const net = parseAmount(r[map.net])
        const social = parseAmount(r[map.social]) || 0
        const fund = parseAmount(r[map.fund]) || 0
        const tax = parseAmount(r[map.tax]) || 0
        if (!gross && !net) continue
        out.push({
          name,
          gross: round2(gross || net || 0),
          deductSocial: round2(social),
          deductFund: round2(fund),
          deductTax: round2(tax),
          net: round2(net != null ? net : round2(gross - social - fund - tax)),
          bankAccount: String(r[map.bankAccount] ?? '').trim() || null,
          phone: String(r[map.phone] ?? '').trim() || null,
          sheet: sheetName
        })
      }
      if (out.length) break // 只取第一张有数据的表
    }
    if (out.length) break
  }
  if (!out.length) throw new Error('未能识别工资表：需要含有「姓名」列和「应发/实发」列')
  return { rows: out, fileName }
}
