// ECharts 统一封装：ResizeObserver 跟随容器尺寸（侧栏收起、助手开合、横竖屏都能自适应）；
// 手机端在原 option 上做减法：隐藏图例、收窄 grid、减少刻度、标签防重叠。桌面 option 原样使用。
import { watch, onBeforeUnmount } from 'vue'
import * as echarts from 'echarts'
import { useViewport } from './useViewport'

const arr = (v) => (Array.isArray(v) ? v : v ? [v] : [])
const one = (v, fn) => (Array.isArray(v) ? v.map(fn) : v ? fn(v) : v)

function tightAxis(ax) {
  const base = { ...ax, axisLabel: { ...(ax.axisLabel || {}), fontSize: 10, hideOverlap: true } }
  if (ax.type === 'value') base.splitNumber = 3
  return base
}

export function mobileOption(option) {
  const o = { ...option }
  if (o.legend) o.legend = one(o.legend, (l) => ({ ...l, show: false }))
  // 横向条形图（yAxis 是类目）左边要留类目名，其余只留数值刻度
  const horizontal = arr(o.yAxis).some((y) => y.type === 'category')
  if (o.grid) o.grid = one(o.grid, (g) => ({ ...g, left: horizontal ? 56 : 46, right: 10, top: 14, bottom: 24 }))
  if (o.xAxis) o.xAxis = one(o.xAxis, tightAxis)
  if (o.yAxis) o.yAxis = one(o.yAxis, tightAxis)
  if (o.series) o.series = arr(o.series).map((s) => (s.barMaxWidth ? { ...s, barMaxWidth: Math.min(s.barMaxWidth, 12) } : s))
  return o
}

export function useCharts() {
  const { isMobile } = useViewport()
  const items = new Map() // el → { chart, ro, option, notMerge }

  const apply = (it) => it.chart.setOption(isMobile.value ? mobileOption(it.option) : it.option, it.notMerge)

  function render(el, option, notMerge = false) {
    if (!el) return null
    let it = items.get(el)
    if (!it) {
      const chart = echarts.init(el)
      const ro = new ResizeObserver(() => chart.resize())
      ro.observe(el)
      it = { chart, ro }
      items.set(el, it)
    }
    Object.assign(it, { option, notMerge })
    apply(it)
    return it.chart
  }

  const resizeAll = () => items.forEach((it) => it.chart.resize())

  // 跨断点时整份重设（手机 ↔ 桌面 的 legend/grid 不同，必须 notMerge）
  watch(isMobile, () => items.forEach((it) => it.chart.setOption(isMobile.value ? mobileOption(it.option) : it.option, true)))
  onBeforeUnmount(() => items.forEach((it) => { it.ro.disconnect(); it.chart.dispose() }))

  return { render, resizeAll }
}
