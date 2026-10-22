// 金额工具：一律以「元」为单位的字符串/Decimal 参与运算，四舍五入到分
import { Prisma } from '@prisma/client'

export function dec(v) {
  if (v == null || v === '') return new Prisma.Decimal(0)
  return new Prisma.Decimal(v)
}

export function toNumber(v) {
  if (v == null) return 0
  return Number(v)
}

// 保留两位小数（分），用于展示与导出
export function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100
}

// 解析各类银行流水里的金额文本：「¥1,234.56」「1,234.56元」「(1234.56)」
export function parseAmount(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return round2(raw)
  let s = String(raw).trim()
  let negative = false
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1) }
  s = s.replace(/[¥￥,\s元]/g, '')
  if (s.startsWith('-')) { negative = true; s = s.slice(1) }
  if (s === '' || Number.isNaN(Number(s))) return null
  const n = round2(Number(s))
  return negative ? -n : n
}

export function fmtMoney(v) {
  return Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
