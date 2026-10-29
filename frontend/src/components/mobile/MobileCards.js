// 手机端「表格 → 卡片」的渲染器：每行一张卡，标题行 + `标签: 值` 两列 + 底部操作区
// fields: [{ key, label, role: 'title'|'amount'|'badge'|'actions'|'full'|'hide', strong, render(row, index) }]
//   title  ：卡片标题（不传则取第一个普通字段）
//   amount ：标题右侧的主金额（加粗）
//   badge  ：标题下方的状态标签
//   actions：操作区，按钮全宽/并排，≥44px
//   strong ：值加粗（金额）
// 选择：selectable 时卡片左上角出现复选框，rowSelectable(row, i) 决定能否勾选；变化时 emit('selection-change', rows)
import { h, ref, watch, defineComponent } from 'vue'
import { ElCheckbox, ElButton } from 'element-plus'

export default defineComponent({
  name: 'MobileCards',
  props: {
    data: { type: Array, default: () => [] },
    fields: { type: Array, default: () => [] },
    emptyText: { type: String, default: '暂无数据' },
    error: { type: String, default: '' },
    selectable: Boolean,
    rowSelectable: Function,
    rowClass: [Function, String],
    rowKey: [Function, String]
  },
  emits: ['selection-change', 'row-click', 'retry'],
  setup(props, { emit, slots, expose }) {
    const selected = ref(new Set())
    // 数据换了就把已不存在的行从选择里去掉
    watch(() => props.data, (list) => {
      const next = new Set([...selected.value].filter((r) => list.includes(r)))
      if (next.size !== selected.value.size) { selected.value = next; emitSel() }
    })
    const emitSel = () => emit('selection-change', props.data.filter((r) => selected.value.has(r)))
    function toggle(row, on) {
      const next = new Set(selected.value)
      if (on ?? !next.has(row)) next.add(row)
      else next.delete(row)
      selected.value = next
      emitSel()
    }
    const canSelect = (row, i) => !props.rowSelectable || props.rowSelectable(row, i)
    const allOn = () => props.data.length && props.data.every((r, i) => !canSelect(r, i) || selected.value.has(r))
    function toggleAll() {
      const on = !allOn()
      selected.value = new Set(on ? props.data.filter((r, i) => canSelect(r, i)) : [])
      emitSel()
    }
    expose({
      clearSelection: () => { selected.value = new Set(); emitSel() },
      toggleRowSelection: (row, on) => toggle(row, on),
      toggleAllSelection: toggleAll,
      getSelectionRows: () => props.data.filter((r) => selected.value.has(r))
    })

    const keyOf = (row, i) => (typeof props.rowKey === 'function' ? props.rowKey(row) : props.rowKey ? row[props.rowKey] : row.id ?? i)
    // 「—」是桌面表格的占位符，卡片里直接省掉这一行，少占高度
    const isEmpty = (v) => v == null || v === '' || v === '—' || (Array.isArray(v) && !v.length)

    return () => {
      if (props.error) {
        return h('div', { class: 'm-cards' }, h('div', { class: 'm-state m-state-error' }, [
          h('div', props.error),
          h(ElButton, { size: 'small', onClick: () => emit('retry') }, () => '重试')
        ]))
      }
      if (!props.data.length) {
        return h('div', { class: 'm-cards' }, h('div', { class: 'm-state' }, slots.empty?.() || props.emptyText))
      }
      const title = props.fields.find((f) => f.role === 'title') || props.fields.find((f) => !f.role)
      const amount = props.fields.find((f) => f.role === 'amount')
      const badges = props.fields.filter((f) => f.role === 'badge')
      const actions = props.fields.filter((f) => f.role === 'actions')
      const body = props.fields.filter((f) => f !== title && !['amount', 'badge', 'actions', 'hide'].includes(f.role))

      const head = props.selectable
        ? h('div', { class: 'm-cards-bar' }, [
          h(ElCheckbox, { modelValue: !!allOn(), onChange: toggleAll }, () => '全选本页'),
          h('span', { class: 'muted' }, `已选 ${selected.value.size} / ${props.data.length}`)
        ])
        : null

      const cards = props.data.map((row, i) => {
        const cls = typeof props.rowClass === 'function' ? props.rowClass({ row, rowIndex: i }) : props.rowClass
        const bodyRows = body.map((f) => {
          const v = f.render(row, i)
          if (isEmpty(v)) return null
          return h('div', { class: ['m-field', f.role === 'full' && 'is-full'] }, [
            h('span', { class: 'm-label' }, f.label),
            h('span', { class: ['m-value', f.strong && 'is-strong'] }, v)
          ])
        })
        const acts = actions.map((f) => f.render(row, i)).filter((v) => !isEmpty(v))
        return h('div', {
          key: keyOf(row, i),
          class: ['m-card', cls, selected.value.has(row) && 'is-selected'],
          onClick: () => emit('row-click', row)
        }, [
          h('div', { class: 'm-card-head' }, [
            props.selectable
              ? h('span', { class: 'm-check', onClick: (e) => e.stopPropagation() },
                h(ElCheckbox, { modelValue: selected.value.has(row), disabled: !canSelect(row, i), onChange: (on) => toggle(row, on) }))
              : null,
            h('div', { class: 'm-card-main' }, [
              h('div', { class: 'm-card-title' }, title ? title.render(row, i) : `#${i + 1}`),
              badges.length ? h('div', { class: 'm-card-badges' }, badges.map((f) => f.render(row, i))) : null
            ]),
            amount ? h('div', { class: 'm-card-amount' }, [h('div', amount.render(row, i)), h('div', { class: 'm-label' }, amount.label)]) : null
          ]),
          bodyRows.some(Boolean) ? h('div', { class: 'm-card-body' }, bodyRows) : null,
          acts.length ? h('div', { class: 'm-card-actions', onClick: (e) => e.stopPropagation() }, acts) : null
        ])
      })
      return h('div', { class: 'm-cards' }, [head, ...cards])
    }
  }
})
