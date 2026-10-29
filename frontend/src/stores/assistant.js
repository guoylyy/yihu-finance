// 录入助手的全局状态：抽屉开合/宽度、@ 引用、对话、「填入表单」的预填请求
// 任何页面都能 pin()；能接收草稿的页面用 useDraftReceiver() 接住预填
import { defineStore } from 'pinia'
import { ref, watch, onMounted, onActivated } from 'vue'
import { useRoute } from 'vue-router'

const UI_KEY = 'fin_assistant_ui'
export const MIN_WIDTH = 320
export const MAX_WIDTH = 640

// 草稿类型 → 页面路由 / 中文名
export const DRAFT_PAGES = {
  account: { route: '/accounts', label: '账户' },
  receivable: { route: '/receivables', label: '应收款' },
  invoice: { route: '/invoices', label: '发票' },
  transaction: { route: '/transactions', label: '流水' }
}
export const DRAFT_ROUTES = Object.values(DRAFT_PAGES).map((p) => p.route)

function loadUi() {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || 'null') } catch { return null }
}

export const useAssistantStore = defineStore('assistant', () => {
  const saved = loadUi()
  // 没存过偏好时：宽屏默认展开，窄屏（<1280）默认收起
  const open = ref(saved?.open ?? window.innerWidth >= 1280)
  const width = ref(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, saved?.width || 380)))
  const pinned = ref([])        // [{ type, id, label }]，label 只用于显示，服务端按 id 重查
  const messages = ref([])      // [{ role, content, drafts?, warnings? }]
  const status = ref({ available: true, reason: '' })
  const prefill = ref(null)     // { kind, mode, id, payload, nonce }
  const refreshTick = ref({})   // kind → 计数，确认提交后通知对应页面刷新

  watch([open, width], () => localStorage.setItem(UI_KEY, JSON.stringify({ open: open.value, width: width.value })))

  function pin(type, id, label) {
    if (id == null) return
    const key = `${type}:${id}`
    if (pinned.value.some((p) => `${p.type}:${p.id}` === key)) return
    pinned.value.push({ type, id: String(id), label: label || key })
    open.value = true
  }
  const unpin = (p) => { pinned.value = pinned.value.filter((x) => !(x.type === p.type && x.id === p.id)) }
  const isPinned = (type, id) => pinned.value.some((p) => p.type === type && p.id === String(id))

  function requestPrefill(draft) {
    prefill.value = { kind: draft.kind, mode: draft.mode, id: draft.id, payload: { ...draft.payload }, nonce: Date.now() }
  }
  function takePrefill(kind) {
    if (prefill.value?.kind !== kind) return null
    const p = prefill.value
    prefill.value = null
    return p
  }
  function notifyRefresh(kind) { refreshTick.value = { ...refreshTick.value, [kind]: (refreshTick.value[kind] || 0) + 1 } }

  return { open, width, pinned, messages, status, prefill, refreshTick, pin, unpin, isPinned, requestPrefill, takePrefill, notifyRefresh }
})

/**
 * 页面接收助手草稿：onPrefill(p) 打开对应弹窗并预填；onRefresh() 在「确认提交」后刷新列表
 * 页面被 keep-alive 缓存或刚懒加载出来时，挂载/激活时也会检查一次待处理的预填
 */
export function useDraftReceiver(kind, { onPrefill, onRefresh }) {
  const store = useAssistantStore()
  const route = useRoute()
  const here = DRAFT_PAGES[kind].route
  const consume = () => {
    if (route.path !== here) return
    const p = store.takePrefill(kind)
    if (p) onPrefill(p)
  }
  watch(() => store.prefill?.nonce, consume)
  onMounted(consume)
  onActivated(consume)
  if (onRefresh) watch(() => store.refreshTick[kind], (v) => v && onRefresh())
}
