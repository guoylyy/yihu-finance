// 资金预测（需求 §6.3）
//   预计期末余额 = 当前可用余额 + 预计收款 - 已审批待付款 - 固定周期支出
// 每一项都带置信度：CONFIRMED 已确认 / HIGH 高概率 / ESTIMATE 预估
import prisma from './prisma.js'
import dayjs from 'dayjs'
import { scopeWhere } from './auth.js'
import { round2 } from './money.js'

export async function forecast(user, { days = [30, 60, 90], companyId } = {}) {
  // 指定公司时也要和数据范围取交集，否则能指定别家公司
  const scope = companyId ? { AND: [scopeWhere(user), { companyId: BigInt(companyId) }] } : scopeWhere(user)
  const today = dayjs().startOf('day')
  const maxDay = Math.max(...days)
  const horizon = today.add(maxDay, 'day')

  const [accounts, receivables, payments, fixedItems] = await Promise.all([
    prisma.account.findMany({ where: { deletedAt: null, status: 'ACTIVE', currency: 'CNY', ...scope } }),
    prisma.receivable.findMany({
      where: { deletedAt: null, ...scope, status: { in: ['PENDING', 'PARTIAL'] } },
      include: { customer: { select: { name: true } } }
    }),
    prisma.payment.findMany({
      where: { deletedAt: null, ...scope, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } }
    }),
    prisma.forecastItem.findMany({ where: { deletedAt: null, status: 'ACTIVE', ...scope } })
  ])

  const available = round2(accounts.reduce((s, a) => s + Number(a.balance), 0))
  const events = []

  for (const r of receivables) {
    // 没填预计收款日的按 30 天后保守估计
    const date = r.expectDate ? dayjs(r.expectDate) : today.add(30, 'day')
    const remain = round2(Number(r.amount) - Number(r.receivedAmount))
    if (remain <= 0) continue
    events.push({
      date: (date.isBefore(today) ? today : date).format('YYYY-MM-DD'),
      direction: 'IN', amount: remain,
      title: `${r.customer?.name || r.title}（${r.code}）`,
      source: 'RECEIVABLE', confidence: r.confidence || 'HIGH',
      overdue: r.expectDate ? dayjs(r.expectDate).isBefore(today) : false
    })
  }

  for (const p of payments) {
    const date = p.planDate ? dayjs(p.planDate) : today.add(7, 'day')
    events.push({
      date: (date.isBefore(today) ? today : date).format('YYYY-MM-DD'),
      direction: 'OUT', amount: Number(p.amount),
      title: `${p.payeeName}（${p.code}）`,
      source: 'PAYMENT',
      confidence: p.status === 'APPROVED' ? 'CONFIRMED' : 'HIGH',
      overdue: p.planDate ? dayjs(p.planDate).isBefore(today) : false
    })
  }

  // 固定周期收支按月展开到预测窗口内
  for (const f of fixedItems) {
    if (f.frequency === 'ONCE') {
      if (!f.startDate) continue
      const d = dayjs(f.startDate)
      if (d.isAfter(horizon) || d.isBefore(today)) continue
      events.push({ date: d.format('YYYY-MM-DD'), direction: f.direction, amount: Number(f.amount), title: f.name, source: 'FIXED', confidence: f.confidence })
      continue
    }
    const step = f.frequency === 'QUARTERLY' ? 3 : 1
    let cursor = today.date(Math.min(f.dayOfMonth || 1, today.daysInMonth()))
    if (cursor.isBefore(today)) cursor = cursor.add(step, 'month')
    while (!cursor.isAfter(horizon)) {
      if ((!f.startDate || !cursor.isBefore(dayjs(f.startDate))) && (!f.endDate || !cursor.isAfter(dayjs(f.endDate)))) {
        events.push({
          date: cursor.format('YYYY-MM-DD'), direction: f.direction, amount: Number(f.amount),
          title: f.name, source: 'FIXED', confidence: f.confidence
        })
      }
      cursor = cursor.add(step, 'month')
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date))

  const windows = days.map((d) => {
    const limit = today.add(d, 'day')
    const inWindow = events.filter((e) => !dayjs(e.date).isAfter(limit))
    const inflow = round2(inWindow.filter((e) => e.direction === 'IN').reduce((s, e) => s + e.amount, 0))
    const outflow = round2(inWindow.filter((e) => e.direction === 'OUT').reduce((s, e) => s + e.amount, 0))
    const confirmedIn = round2(inWindow.filter((e) => e.direction === 'IN' && e.confidence === 'CONFIRMED').reduce((s, e) => s + e.amount, 0))
    const ending = round2(available + inflow - outflow)
    return {
      days: d, inflow, outflow, confirmedIn,
      endingBalance: ending,
      // 保守口径：只认已确认的收款
      conservativeEnding: round2(available + confirmedIn - outflow),
      gap: ending < 0 ? Math.abs(ending) : 0
    }
  })

  // 逐日余额曲线，用于画预测折线
  const curve = []
  let running = available
  for (let i = 0; i <= maxDay; i++) {
    const d = today.add(i, 'day').format('YYYY-MM-DD')
    for (const e of events.filter((x) => x.date === d)) {
      running = round2(running + (e.direction === 'IN' ? e.amount : -e.amount))
    }
    curve.push({ date: d, balance: running })
  }

  return { available, windows, events: events.slice(0, 200), curve, generatedAt: new Date().toISOString() }
}
