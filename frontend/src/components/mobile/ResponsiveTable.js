// <el-table> 的就地替换：桌面原样渲染 el-table（属性、事件、插槽、ref 方法全部透传，不改样式）；
// 手机端读取子节点里的 <el-table-column>（含 #default 插槽），用 MobileCards 渲染成卡片。
// 列上可加 mobile="title|badge|actions|full|hide" 指定卡片里的位置；label 为「操作」的列自动进操作区，
// align="right" 的列（金额）值加粗。type="selection" → 卡片复选框；type="index" / "expand" 在卡片里省略。
import { h, ref, Fragment, Comment, defineComponent } from 'vue'
import { ElTable } from 'element-plus'
import MobileCards from './MobileCards'
import { useViewport } from '@/composables/useViewport'

const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase())
const getPath = (row, path) => String(path).split('.').reduce((o, k) => o?.[k], row)

function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    if (!n || n.type === Comment) continue
    if (n.type === Fragment) flatten(n.children, out)
    else if (n.type?.name === 'ElTableColumn') out.push(n)
  }
  return out
}

function toField(vnode) {
  const p = {}
  for (const [k, v] of Object.entries(vnode.props || {})) p[camel(k)] = v
  const slot = vnode.children?.default
  const column = { label: p.label, property: p.prop }
  const role = p.mobile || (p.label === '操作' ? 'actions' : undefined)
  return {
    type: p.type,
    selectable: p.selectable,
    label: p.label,
    role,
    strong: p.align === 'right',
    render: (row, i) => {
      if (slot) return slot({ row, column, $index: i })
      const v = p.prop ? getPath(row, p.prop) : undefined
      if (p.formatter) return p.formatter(row, column, v, i)
      return v ?? '—'
    }
  }
}

export default defineComponent({
  name: 'ResponsiveTable',
  inheritAttrs: false,
  setup(_, { attrs, slots, expose }) {
    const { isMobile } = useViewport()
    const tableRef = ref(null)
    const cardsRef = ref(null)
    const target = () => (isMobile.value ? cardsRef.value : tableRef.value)
    expose({
      clearSelection: () => target()?.clearSelection(),
      toggleRowSelection: (...a) => target()?.toggleRowSelection(...a),
      toggleAllSelection: () => target()?.toggleAllSelection(),
      getSelectionRows: () => target()?.getSelectionRows() || [],
      doLayout: () => tableRef.value?.doLayout?.()
    })

    return () => {
      if (!isMobile.value) return h(ElTable, { ...attrs, ref: tableRef }, slots)

      const a = {}
      for (const [k, v] of Object.entries(attrs)) a[camel(k)] = v
      const all = flatten(slots.default?.()).map(toField)
      const sel = all.find((f) => f.type === 'selection')
      const fields = all.filter((f) => !f.type)
      return h(MobileCards, {
        ref: cardsRef,
        class: a.class,
        data: a.data || [],
        fields,
        emptyText: a.emptyText || '暂无数据',
        selectable: !!sel,
        rowSelectable: sel?.selectable,
        rowClass: a.rowClassName,
        rowKey: a.rowKey,
        onSelectionChange: a.onSelectionChange,
        onRowClick: a.onRowClick
      }, slots.empty ? { empty: slots.empty } : undefined)
    }
  }
})
