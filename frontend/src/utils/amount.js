// 金额输入校验（v1.4 认领 / 拆分 / 新建流水共用）：组件层先拦一道，后端仍会再校验
// 一律换算成「分」的整数比较，避免 0.1 + 0.2 这类浮点误差
const RE = /^\d+(\.\d{1,2})?$/

export const toCents = (v) => Math.round(Number(v || 0) * 100)
export const fromCents = (c) => (c / 100).toFixed(2)

/**
 * 校验一个金额输入，返回错误文案（通过返回空串）
 * @param {string|number} v      输入值
 * @param {object}        opt    { max: 上限（元，可选）, maxLabel: 超上限时的提示, label: 字段名 }
 */
export function amountError(v, { max, maxLabel, label = '金额' } = {}) {
  const s = String(v ?? '').trim()
  if (!s) return `请填写${label}`
  if (s.startsWith('-')) return `${label}不能是负数`
  if (!RE.test(s)) return /^\d+\.\d{3,}$/.test(s) ? `${label}最多两位小数` : `${label}格式不对`
  if (toCents(s) <= 0) return `${label}必须大于 0`
  if (max != null && toCents(s) > toCents(max)) return maxLabel || `${label}不能超过 ¥${fromCents(toCents(max))}`
  return ''
}
