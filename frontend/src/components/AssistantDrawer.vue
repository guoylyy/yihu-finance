<!-- 右侧录入助手：上下文（当前页面 + @ 引用）、对话、草稿卡。助手只生成草稿，写入由用户确认 -->
<template>
  <aside class="assistant-pane" :style="{ width: store.width + 'px' }">
    <div class="resizer" title="拖动调整宽度" @mousedown.prevent="startResize" />

    <div class="a-head">
      <div class="a-title">
        录入助手
        <el-tag v-if="store.status.stub" size="small" type="info" effect="plain">STUB</el-tag>
      </div>
      <el-tooltip content="清空对话" placement="bottom">
        <el-button text circle size="small" :disabled="!store.messages.length || sending" @click="store.messages = []">
          <el-icon><Delete /></el-icon>
        </el-button>
      </el-tooltip>
      <el-button text circle size="small" @click="store.open = false"><el-icon><Close /></el-icon></el-button>
    </div>
    <div class="a-hint">助手只生成草稿，提交前请核对</div>

    <div class="a-context">
      <el-tag size="small" effect="plain" class="ctx-page">
        <el-icon style="vertical-align: -2px"><Location /></el-icon> {{ route.meta.title || route.path }}
        <span v-if="!draftPage" class="muted">（只读问答）</span>
      </el-tag>
      <el-tag v-for="p in store.pinned" :key="`${p.type}:${p.id}`" size="small" closable class="ctx-pin"
              @close="store.unpin(p)">
        @{{ TYPE_LABEL[p.type] || p.type }} {{ p.label }}
      </el-tag>
      <span v-if="!store.pinned.length" class="muted ctx-empty">在列表行上点「@」引用记录</span>
    </div>

    <div ref="listRef" class="a-messages">
      <div v-if="!store.messages.length" class="a-empty">
        <p>说一句话，我来填表单，例如：</p>
        <p class="eg" @click="input = EXAMPLES[draftKind] || EXAMPLES.receivable">「{{ EXAMPLES[draftKind] || EXAMPLES.receivable }}」</p>
      </div>
      <div v-for="(m, i) in store.messages" :key="i" class="msg" :class="m.role">
        <div v-if="m.content" class="bubble">{{ m.content }}</div>
        <AssistantDraftCard v-for="(d, j) in m.drafts || []" :key="j" :draft="d" />
        <div v-if="m.warnings?.length" class="msg-warn">
          <div v-for="(w, j) in m.warnings" :key="j">⚠ {{ w }}</div>
        </div>
      </div>
      <div v-if="sending" class="msg assistant"><div class="bubble muted">思考中…</div></div>
    </div>

    <div class="a-input">
      <el-input v-model="input" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" resize="none"
                placeholder="Enter 发送，Shift+Enter 换行" :disabled="sending" @keydown="onKeydown" />
      <el-button type="primary" size="small" :loading="sending" :disabled="!input.trim()" @click="send">发送</el-button>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/api'
import AssistantDraftCard from '@/components/AssistantDraftCard.vue'
import { useAssistantStore, DRAFT_PAGES, MIN_WIDTH, MAX_WIDTH } from '@/stores/assistant'

const store = useAssistantStore()
const route = useRoute()
const input = ref('')
const sending = ref(false)
const listRef = ref(null)

const TYPE_LABEL = { company: '公司', customer: '客户', project: '项目', account: '账户', receivable: '应收', invoice: '发票', transaction: '流水' }
const EXAMPLES = {
  receivable: '录一笔应收：客户 12，金额 128000，月底到期',
  invoice: '录一张进项发票：发票号 12345678，金额 10600，税额 600，今天开的',
  transaction: '记一笔支出：金额 3200，对方 某某物业，摘要 10 月物业费',
  account: '新开一个账户：叫 招行基本户，开户行 招商银行，期初 0'
}
const draftKind = computed(() => Object.entries(DRAFT_PAGES).find(([, p]) => p.route === route.path)?.[0])
const draftPage = computed(() => !!draftKind.value)

function onKeydown(e) {
  // 输入法组字中的 Enter 不算发送
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}

const scrollToEnd = () => nextTick(() => { if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight })

async function send() {
  const text = input.value.trim()
  if (!text || sending.value) return
  store.messages.push({ role: 'user', content: text })
  input.value = ''
  sending.value = true
  scrollToEnd()
  try {
    const data = await api.assistant.chat({
      messages: store.messages.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content })),
      // label 只用于显示，不发给服务端：服务端按 type + id 重新查库
      context: { route: route.path, pinned: store.pinned.map(({ type, id }) => ({ type, id })), filters: { ...route.query } }
    })
    if (data.available === false) {
      store.status = { available: false, reason: data.reason }
      store.messages.push({ role: 'assistant', content: `助手不可用：${data.reason}` })
    } else {
      store.messages.push({ role: 'assistant', content: data.reply, drafts: data.drafts, warnings: data.warnings })
    }
  } catch (e) {
    store.messages.push({ role: 'assistant', content: '', warnings: [e.message] })
  } finally {
    sending.value = false
    scrollToEnd()
  }
}

// 拖左边缘调宽度
function startResize() {
  const move = (e) => { store.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX)) }
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.userSelect = '' }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
  stopResize = up
}
let stopResize = null
onBeforeUnmount(() => stopResize?.())
</script>

<style scoped>
.assistant-pane {
  position: relative; flex-shrink: 0; height: 100vh;
  background: var(--surface); border-left: 1px solid var(--border);
  display: flex; flex-direction: column; min-width: 0;
}
.resizer { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 2; }
.resizer:hover { background: var(--border-strong); }
.a-head { display: flex; align-items: center; gap: 2px; height: 56px; padding: 0 10px 0 16px; border-bottom: 1px solid var(--border); }
.a-title { flex: 1; font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 6px; }
.a-hint { font-size: 12px; color: var(--text-muted); padding: 6px 16px; background: #fcfbfa; border-bottom: 1px solid var(--border); }
.a-context { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--border); align-items: center; }
.ctx-pin { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.ctx-empty { font-size: 12px; }
.a-messages { flex: 1; overflow-y: auto; padding: 12px 14px; }
.a-empty { color: var(--text-muted); font-size: 13px; line-height: 1.8; }
.a-empty .eg { color: var(--accent); cursor: pointer; }
.msg { margin-bottom: 12px; display: flex; flex-direction: column; }
.msg.user { align-items: flex-end; }
.bubble { max-width: 92%; padding: 7px 11px; border-radius: 10px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.msg.user .bubble { background: var(--text); color: #faf9f7; }
.msg.assistant .bubble { background: #f4f2ef; }
.msg-warn { font-size: 12px; color: var(--warning); margin-top: 4px; line-height: 1.6; }
.a-input { border-top: 1px solid var(--border); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
</style>
