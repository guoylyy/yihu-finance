// <el-pagination> 的就地替换：桌面原样渲染；手机端简化为「上一页 / 第 x / y 页 / 下一页」，按钮 ≥44px
// 透传 v-model:current-page、v-model:page-size、@change、@current-change
import { h, defineComponent } from 'vue'
import { ElPagination, ElButton, ElIcon } from 'element-plus'
import { ArrowLeft, ArrowRight } from '@element-plus/icons-vue'
import { useViewport } from '@/composables/useViewport'

const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase())

export default defineComponent({
  name: 'ResponsivePager',
  inheritAttrs: false,
  setup(_, { attrs }) {
    const { isMobile } = useViewport()
    return () => {
      if (!isMobile.value) return h(ElPagination, attrs)
      const a = {}
      for (const [k, v] of Object.entries(attrs)) a[camel(k)] = v
      const total = Number(a.total || 0)
      const size = Number(a.pageSize || a.defaultPageSize || 10)
      const cur = Number(a.currentPage || 1)
      const pages = Math.max(1, Math.ceil(total / size))
      const go = (p) => {
        if (p < 1 || p > pages || p === cur) return
        a['onUpdate:currentPage']?.(p)
        a.onCurrentChange?.(p)
        a.onChange?.(p, size)
      }
      return h('div', { class: 'm-pager' }, [
        h(ElButton, { disabled: cur <= 1, onClick: () => go(cur - 1) }, () => [h(ElIcon, () => h(ArrowLeft)), '上一页']),
        h('span', { class: 'm-pager-info' }, [h('b', cur), ` / ${pages} 页`, h('span', { class: 'muted' }, ` · 共 ${total} 条`)]),
        h(ElButton, { disabled: cur >= pages, onClick: () => go(cur + 1) }, () => ['下一页', h(ElIcon, () => h(ArrowRight))])
      ])
    }
  }
})
