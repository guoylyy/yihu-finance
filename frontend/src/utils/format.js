export function money(v, withSign = false) {
  const n = Number(v || 0)
  const s = n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return withSign && n > 0 ? `+${s}` : s
}

export function moneyShort(v) {
  const n = Number(v || 0)
  const abs = Math.abs(n)
  if (abs >= 100000000) return (n / 100000000).toFixed(2) + ' 亿'
  if (abs >= 10000) return (n / 10000).toFixed(2) + ' 万'
  return money(n)
}

export function date(v) {
  return v ? String(v).slice(0, 10) : '—'
}

export function datetime(v) {
  if (!v) return '—'
  const d = new Date(v)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function currentPeriod() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 生成最近 n 个月的期间选项 */
export function periodOptions(n = 18) {
  const out = []
  const d = new Date()
  for (let i = 0; i < n; i++) {
    const t = new Date(d.getFullYear(), d.getMonth() - i, 1)
    out.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`)
  }
  return out
}
