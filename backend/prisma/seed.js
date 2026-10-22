// 初始化演示数据：4 家虚构公司、账户余额、员工银行账号、收支分类、示例流水、系统账号
// ⚠️ 本文件所有公司、人员、卡号、金额均为虚构演示数据，仅用于快速体验系统；
//    生产环境请清空本文件内容或替换为自有初始化脚本。
import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import bcrypt from 'bcryptjs'
import prisma from '../src/lib/prisma.js'
import { Prisma } from '@prisma/client'
import { round2 } from '../src/lib/money.js'

const COMPANIES = [
  { code: '云帆科技', name: '上海云帆科技有限公司', sharePercent: 100, capital: 4200000, sortOrder: 1, mainBusiness: 'AI 员工与大模型应用交付' },
  { code: '星野教育', name: '上海星野教育科技有限公司', sharePercent: 100, capital: 500000, sortOrder: 2, mainBusiness: '教育信息服务' },
  { code: '拾光云', name: '拾光云科技有限公司', sharePercent: 18, capital: 980000, sortOrder: 3, mainBusiness: '云服务与软件开发' },
  { code: '青舟联创', name: '青舟联创（上海）科技有限公司', sharePercent: 30, capital: 980000, sortOrder: 4, mainBusiness: '云服务' }
]

const ACCOUNTS = [
  { company: '云帆科技', name: '基本户', type: 'BANK', bankName: '示例银行', currency: 'CNY', balance: 3561900.0, isPrimary: true },
  { company: '云帆科技', name: '备用户', type: 'BANK', bankName: '沿海商业银行', currency: 'CNY', balance: 48700.0 },
  { company: '星野教育', name: '基本户', type: 'BANK', bankName: '示例银行', currency: 'CNY', balance: 508600.0, isPrimary: true },
  { company: '星野教育', name: '美元账户', type: 'BANK', bankName: '示例银行', currency: 'USD', balance: 22100.0 },
  { company: '拾光云', name: '对公账户', type: 'BANK', currency: 'CNY', balance: 884200.0, isPrimary: true },
  { company: '青舟联创', name: '对公账户', type: 'BANK', currency: 'CNY', balance: 914600.0, isPrimary: true }
]

export const CATEGORIES = [
  ['IN', '客户回款'], ['IN', '其他收入'], ['IN', '利息收入'], ['IN', '退款'], ['IN', '借款收回'], ['IN', '借入款项'], ['IN', '内部转账'],
  ['OUT', '工资'], ['OUT', '劳务费'], ['OUT', '社保公积金'], ['OUT', '报销'], ['OUT', '采购付款'], ['OUT', '服务费'],
  ['OUT', '税费'], ['OUT', '房租物业'], ['OUT', '软件和云服务'], ['OUT', '银行手续费'], ['OUT', '公司间往来'],
  ['OUT', '日常开支'], ['OUT', '其他支出'], ['OUT', '内部转账']
]

// 演示员工与银行账号（卡号均为虚构格式，非真实账号）
const PERSONS = {
  '云帆科技': [
    ['张伟', '6222020200000000001'], ['李娜', '6222020200000000002'], ['王强', '6222020200000000003'],
    ['刘洋', '6222020200000000004'], ['陈静', '6222020200000000005'], ['杨帆', '6222020200000000006'],
    ['赵磊', '6222020200000000007'], ['孙婷', '6222020200000000008']
  ],
  '星野教育': [
    ['周杰', '6222020200000000011'], ['吴敏', '6222020200000000012'], ['郑浩', '6222020200000000013'],
    ['冯雪', '6222020200000000014'], ['陈晨', '6222020200000000015']
  ],
  '拾光云': [
    ['许阳', '6222030300000000021', '沿海商业银行上海普陀支行', '313290000001'],
    ['林悦', '6222030300000000022', '启明银行深圳新时代支行'],
    ['黄鹏', '6222030300000000023', '沿海商业银行上海宝山支行'],
    ['徐蕾', '6222030300000000024'], ['朱凯', '6222030300000000025']
  ]
}

const TRANSACTIONS = [
  ['云帆科技', '基本户', '2026-08-10', 'OUT', 79948.0, 'SALARY', '工资', '2026-07 工资发放'],
  ['云帆科技', '基本户', '2026-08-10', 'OUT', 2348.0, 'LABOR', '劳务费', '外部顾问劳务费'],
  ['云帆科技', '基本户', '2026-08-10', 'OUT', 1815.19, 'REIMBURSE', '报销', '交通/停车/加油等报销'],
  ['星野教育', '基本户', '2026-08-10', 'OUT', 25574.0, 'SALARY', '工资', '2026-07 工资发放'],
  ['星野教育', '基本户', '2026-08-10', 'OUT', 6846.34, 'REIMBURSE', '报销', '员工报销'],
  ['拾光云', '对公账户', '2026-08-10', 'OUT', 8975.7, 'REIMBURSE', '报销', '员工报销 44 笔'],
  ['拾光云', '对公账户', '2026-08-31', 'OUT', 3616.0, 'OTHER_OUT', '日常开支', '个人垫付日常开支，归属待确认']
]

const FORECAST_ITEMS = [
  { company: '云帆科技', name: '每月工资（含社保公积金）', direction: 'OUT', amount: 85000, dayOfMonth: 10, confidence: 'HIGH' },
  { company: '星野教育', name: '每月工资', direction: 'OUT', amount: 26000, dayOfMonth: 10, confidence: 'HIGH' }
]

const USERS = [
  { username: 'admin', password: 'admin123', name: '管理员', role: 'ADMIN', remark: '管理者：全部公司数据 + 付款审批' },
  { username: 'finance', password: 'finance123', name: '财务', role: 'FINANCE', remark: '财务：流水/收付款/工资/报销/发票' },
  { username: 'staff', password: 'staff123', name: '业务员', role: 'STAFF', remark: '业务：提交报销、查看本人单据' }
]

async function main() {
  console.log('→ 写入公司…')
  const companyMap = {}
  for (const c of COMPANIES) {
    const row = await prisma.company.upsert({ where: { code: c.code }, create: c, update: c })
    companyMap[c.code] = row
  }

  console.log('→ 写入收支分类…')
  for (const [kind, name] of CATEGORIES) {
    await prisma.category.upsert({ where: { kind_name: { kind, name } }, create: { kind, name }, update: {} })
  }
  const categories = await prisma.category.findMany()
  const catId = (kind, name) => categories.find((c) => c.kind === kind && c.name === name)?.id || null

  console.log('→ 写入账户…')
  const accountMap = {}
  for (const a of ACCOUNTS) {
    const companyId = companyMap[a.company].id
    const key = `${a.company}/${a.name}`
    const exist = await prisma.account.findFirst({ where: { companyId, name: a.name, deletedAt: null } })
    const data = {
      companyId, name: a.name, type: a.type, bankName: a.bankName || null,
      currency: a.currency, isPrimary: !!a.isPrimary,
      balance: new Prisma.Decimal(a.balance), initialBalance: new Prisma.Decimal(a.balance),
      balanceAt: new Date('2026-08-31'), remark: '演示数据：期初余额为虚构数字'
    }
    accountMap[key] = exist
      ? await prisma.account.update({ where: { id: exist.id }, data })
      : await prisma.account.create({ data })
  }

  console.log('→ 写入员工与银行账号…')
  for (const [company, list] of Object.entries(PERSONS)) {
    for (const [name, bankAccount, bankBranch, cnaps] of list) {
      const companyId = companyMap[company].id
      const exist = await prisma.person.findFirst({ where: { companyId, name, deletedAt: null } })
      const bankName = !bankBranch ? '示例银行'
        : bankBranch.includes('沿海') ? '沿海商业银行'
        : bankBranch.includes('启明') ? '启明银行' : '示例银行'
      const data = {
        companyId, name, bankAccount, bankName,
        bankBranch: bankBranch || null, cnaps: cnaps || null, type: 'EMPLOYEE'
      }
      if (exist) await prisma.person.update({ where: { id: exist.id }, data })
      else await prisma.person.create({ data })
    }
  }

  console.log('→ 写入示例流水…')
  let seq = 0
  for (const [company, accountName, date, direction, amount, bizType, categoryName, remark] of TRANSACTIONS) {
    const account = accountMap[`${company}/${accountName}`]
    const code = `TXN-202608-${String(++seq).padStart(4, '0')}`
    const exist = await prisma.transaction.findUnique({ where: { code } })
    const data = {
      code, companyId: companyMap[company].id, accountId: account.id,
      txnDate: new Date(date), direction, amount: new Prisma.Decimal(amount),
      currency: 'CNY', bizType, categoryId: catId(direction, categoryName),
      status: 'RECONCILED', remark
    }
    if (exist) await prisma.transaction.update({ where: { code }, data })
    else await prisma.transaction.create({ data })
  }

  console.log('→ 校准账户期初余额（让当前余额等于设定值）…')
  for (const a of ACCOUNTS) {
    const account = accountMap[`${a.company}/${a.name}`]
    const rows = await prisma.transaction.groupBy({
      by: ['direction'], where: { accountId: account.id, deletedAt: null }, _sum: { amount: true }
    })
    const sum = (d) => Number(rows.find((r) => r.direction === d)?._sum.amount || 0)
    // 设定余额是「已含这些支出后」的结果，所以期初 = 设定余额 - 收入 + 支出
    const initial = round2(a.balance - sum('IN') + sum('OUT'))
    await prisma.account.update({
      where: { id: account.id },
      data: { initialBalance: new Prisma.Decimal(initial), balance: new Prisma.Decimal(a.balance) }
    })
  }

  console.log('→ 写入固定周期支出（用于资金预测）…')
  for (const f of FORECAST_ITEMS) {
    const companyId = companyMap[f.company].id
    const exist = await prisma.forecastItem.findFirst({ where: { companyId, name: f.name, deletedAt: null } })
    const data = {
      companyId, name: f.name, direction: f.direction,
      amount: new Prisma.Decimal(f.amount), frequency: 'MONTHLY',
      dayOfMonth: f.dayOfMonth, confidence: f.confidence
    }
    if (exist) await prisma.forecastItem.update({ where: { id: exist.id }, data })
    else await prisma.forecastItem.create({ data })
  }

  console.log('→ 写入系统账号…')
  for (const u of USERS) {
    const exist = await prisma.user.findFirst({ where: { username: u.username } })
    const data = {
      username: u.username, name: u.name, role: u.role, remark: u.remark,
      passwordHash: await bcrypt.hash(u.password, 10)
    }
    if (exist) await prisma.user.update({ where: { id: exist.id }, data })
    else await prisma.user.create({ data })
  }

  const [cc, ac, pc, tc] = await Promise.all([
    prisma.company.count(), prisma.account.count(), prisma.person.count(), prisma.transaction.count()
  ])
  console.log(`\n✅ 初始化完成：公司 ${cc} / 账户 ${ac} / 员工 ${pc} / 流水 ${tc}`)
  console.log('   登录账号：admin / admin123（管理者）、finance / finance123（财务）、staff / staff123（业务）')
}

// 被 bootstrap.js 引用 CATEGORIES 时不执行（seed 会重置默认账号密码，只能手动跑）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => prisma.$disconnect())
}
