// 期间/日期工具
// 注意：@db.Date 字段一律按 UTC 零点存取。若用本地零点，东八区会被 MySQL 存成前一天，
// 出现「填 9-10 存成 9-09」的经典时区错位。
import dayjs from 'dayjs'

export const nowPeriod = () => dayjs().format('YYYY-MM')

/** 'YYYY-MM-DD' → UTC 零点的 Date */
export function toDate(v) {
  if (!v) return null
  const d = dayjs(v)
  if (!d.isValid()) return null
  return new Date(`${d.format('YYYY-MM-DD')}T00:00:00.000Z`)
}

export function periodRange(period) {
  const start = new Date(`${period}-01T00:00:00.000Z`)
  const d = dayjs(`${period}-01`)
  const end = new Date(`${d.endOf('month').format('YYYY-MM-DD')}T23:59:59.999Z`)
  return { start, end, label: period }
}

export function fmtDate(v) {
  return v ? dayjs(v).format('YYYY-MM-DD') : ''
}

// 最近 n 个月的期间列表（含当月），从旧到新
export function lastPeriods(n = 12, from = dayjs()) {
  return Array.from({ length: n }, (_, i) => dayjs(from).subtract(n - 1 - i, 'month').format('YYYY-MM'))
}
