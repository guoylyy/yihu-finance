<template>
  <div class="page guide">
    <div class="page-head">
      <div>
        <div class="page-title">使用手册</div>
        <div class="page-sub">操作方法、每月固定动作、踩过的坑与更新日志</div>
      </div>
      <el-input v-model="keyword" placeholder="搜索手册内容" clearable style="width: 220px" :prefix-icon="Search" />
    </div>

    <div class="guide-body">
      <!-- 左侧目录 -->
      <aside class="toc">
        <div v-for="d in filteredDocs" :key="d.key" class="toc-doc">
          <div class="toc-title" :class="{ active: current === d.key }" @click="select(d.key)">
            {{ d.title }}
          </div>
          <div v-if="current === d.key && d.sections.length" class="toc-sections">
            <a v-for="sec in d.sections" :key="sec.id" :href="`#${sec.id}`"
               :class="{ on: activeSection === sec.id }" @click.prevent="goSection(sec.id)">
              {{ sec.text }}
            </a>
          </div>
        </div>
        <div v-if="!filteredDocs.length" class="muted" style="padding: 10px; font-size: 13px">
          没有匹配的内容
        </div>
      </aside>

      <!-- 正文 -->
      <div class="doc-main">
        <!-- 月度 SOP 的进度条 -->
        <div v-if="isSop" class="sop-bar">
          <div class="sop-left">
            <el-select v-model="sopPeriod" size="small" style="width: 120px">
              <el-option v-for="p in periods" :key="p" :label="p" :value="p" />
            </el-select>
            <span class="muted" style="font-size: 13px">的执行进度</span>
          </div>
          <div class="sop-right">
            <el-progress :percentage="sopPercent" :stroke-width="10" :color="sopPercent === 100 ? '#2e7d4f' : '#d2521e'"
                         style="width: 220px" />
            <span class="num">{{ sopDone }} / {{ sopTotal }}</span>
            <el-button size="small" text @click="resetSop">清空本月勾选</el-button>
          </div>
        </div>

        <article ref="articleRef" class="markdown" v-html="html" @change="onCheck"></article>

        <div class="doc-foot muted">
          内容存放在 <code>frontend/src/docs/</code>，直接改 Markdown 文件即可；
          勾选进度保存在本机浏览器，不会上传。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { marked } from 'marked'
import { Search } from '@element-plus/icons-vue'
import { currentPeriod, periodOptions } from '@/utils/format'

// 文档源文件：加 NN- 前缀控制顺序，文件名即标题
const raw = import.meta.glob('../../docs/*.md', { query: '?raw', import: 'default', eager: true })

const docs = Object.entries(raw)
  .map(([path, content]) => {
    const file = path.split('/').pop().replace(/\.md$/, '')
    return { key: file, title: file.replace(/^\d+[-.]\s*/, ''), content }
  })
  .sort((a, b) => a.key.localeCompare(b.key, 'zh'))

const current = ref(docs[0]?.key)
const keyword = ref('')
const activeSection = ref('')
const articleRef = ref(null)
const sopPeriod = ref(currentPeriod())
const periods = periodOptions(12)
const sopState = ref({})

const doc = computed(() => docs.find((d) => d.key === current.value) || docs[0])
const isSop = computed(() => /SOP/i.test(doc.value?.key || ''))

// 目录：取每篇的二级标题
function sectionsOf(content) {
  return [...content.matchAll(/^##\s+(.+)$/gm)].map((m, i) => ({
    id: `sec-${i}`,
    text: m[1].replace(/[*`]/g, '').trim()
  }))
}
const docsWithSections = docs.map((d) => ({ ...d, sections: sectionsOf(d.content) }))

const filteredDocs = computed(() => {
  if (!keyword.value.trim()) return docsWithSections
  const k = keyword.value.trim().toLowerCase()
  return docsWithSections.filter((d) => d.title.toLowerCase().includes(k) || d.content.toLowerCase().includes(k))
})

const html = computed(() => {
  if (!doc.value) return ''
  let i = 0
  const renderer = new marked.Renderer()
  // 给二级标题打锚点，配合左侧目录跳转
  renderer.heading = ({ text, depth }) => {
    const id = depth === 2 ? ` id="sec-${i++}"` : ''
    const plain = text.replace(/<[^>]+>/g, '')
    return `<h${depth}${id}>${plain}</h${depth}>`
  }
  return marked.parse(doc.value.content, { renderer, gfm: true, breaks: false })
})

// ── SOP 勾选进度：按月份存本机 ──
const storeKey = computed(() => `fin_sop_${sopPeriod.value}`)

function loadSop() {
  try {
    sopState.value = JSON.parse(localStorage.getItem(storeKey.value) || '{}')
  } catch {
    sopState.value = {}
  }
}
function saveSop() {
  try {
    localStorage.setItem(storeKey.value, JSON.stringify(sopState.value))
  } catch { /* 隐私模式下写不了，忽略 */ }
}

const sopTotal = computed(() => (doc.value?.content.match(/^\s*-\s\[[ x]\]/gm) || []).length)
const sopDone = computed(() => Object.values(sopState.value).filter(Boolean).length)
const sopPercent = computed(() => (sopTotal.value ? Math.round((sopDone.value / sopTotal.value) * 100) : 0))

/** 把 marked 渲染出来的只读复选框变成可点的，并回填进度 */
function hydrateCheckboxes() {
  const el = articleRef.value
  if (!el || !isSop.value) return
  el.querySelectorAll('input[type=checkbox]').forEach((box, idx) => {
    box.disabled = false
    box.dataset.idx = idx
    box.checked = !!sopState.value[idx]
    box.closest('li')?.classList.toggle('done', box.checked)
  })
}

function onCheck(e) {
  const box = e.target
  if (box?.type !== 'checkbox') return
  sopState.value = { ...sopState.value, [box.dataset.idx]: box.checked }
  box.closest('li')?.classList.toggle('done', box.checked)
  saveSop()
}

function resetSop() {
  sopState.value = {}
  saveSop()
  hydrateCheckboxes()
}

function select(key) {
  current.value = key
  activeSection.value = ''
  nextTick(() => {
    document.querySelector('.doc-main')?.scrollTo({ top: 0 })
    hydrateCheckboxes()
  })
}

function goSection(id) {
  activeSection.value = id
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

watch(sopPeriod, () => { loadSop(); hydrateCheckboxes() })
watch(html, () => nextTick(hydrateCheckboxes))

onMounted(() => {
  loadSop()
  nextTick(hydrateCheckboxes)
})
</script>

<style scoped>
.guide-body { display: flex; gap: 16px; align-items: flex-start; }

.toc {
  width: 210px; flex-shrink: 0; position: sticky; top: 0;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--card-radius); padding: 8px;
}
.toc-title {
  padding: 8px 10px; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 500;
}
.toc-title:hover { background: #faf9f7; }
.toc-title.active { background: #fdf5f1; color: var(--accent); font-weight: 600; }
.toc-sections { padding: 2px 0 6px 12px; border-left: 1px solid var(--border); margin-left: 12px; }
.toc-sections a {
  display: block; padding: 4px 8px; font-size: 12.5px; color: var(--text-secondary);
  border-radius: 4px; line-height: 1.5;
}
.toc-sections a:hover { color: var(--accent); }
.toc-sections a.on { color: var(--accent); font-weight: 600; }

.doc-main {
  flex: 1; min-width: 0;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--card-radius); padding: 22px 28px;
}

.sop-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  background: #fdf5f1; border: 1px solid #f0d9cd; border-radius: 8px;
  padding: 10px 14px; margin-bottom: 18px;
}
.sop-left, .sop-right { display: flex; align-items: center; gap: 10px; }
.sop-right .num { font-weight: 600; font-size: 14px; }

.doc-foot { font-size: 12px; margin-top: 26px; padding-top: 12px; border-top: 1px solid var(--border); }
.doc-foot code { background: #faf9f7; padding: 1px 5px; border-radius: 4px; }
</style>

<style>
/* markdown 正文样式（不加 scoped，v-html 内容才吃得到） */
.markdown { font-size: 14px; line-height: 1.85; color: var(--text); }
.markdown h1 { font-size: 22px; margin: 0 0 16px; letter-spacing: -0.01em; }
.markdown h2 {
  font-size: 17px; margin: 30px 0 12px; padding-left: 10px;
  border-left: 3px solid var(--accent); line-height: 1.4;
}
.markdown h3 { font-size: 15px; margin: 20px 0 8px; }
.markdown p { margin: 10px 0; }
.markdown ul, .markdown ol { margin: 10px 0; padding-left: 22px; }
.markdown li { margin: 5px 0; }
.markdown li.done { color: var(--text-muted); text-decoration: line-through; }
.markdown li input[type=checkbox] {
  margin-right: 8px; width: 15px; height: 15px; cursor: pointer;
  accent-color: var(--accent); vertical-align: -2px;
}
.markdown ul:has(> li > input) { list-style: none; padding-left: 4px; }
.markdown code {
  background: #f5f3f0; padding: 2px 6px; border-radius: 4px;
  font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.markdown pre {
  background: #1c1917; color: #faf9f7; padding: 14px 16px; border-radius: 8px;
  overflow-x: auto; margin: 14px 0; line-height: 1.6;
}
.markdown pre code { background: none; color: inherit; padding: 0; font-size: 12.5px; }
.markdown blockquote {
  border-left: 3px solid var(--border-strong); padding: 2px 0 2px 14px;
  margin: 14px 0; color: var(--text-secondary); background: #faf9f7;
  border-radius: 0 6px 6px 0;
}
.markdown table { border-collapse: collapse; margin: 14px 0; width: 100%; font-size: 13px; }
.markdown th, .markdown td { border: 1px solid var(--border); padding: 7px 11px; text-align: left; }
.markdown th { background: #faf9f7; color: var(--text-muted); font-weight: 600; }
.markdown hr { border: none; border-top: 1px solid var(--border); margin: 26px 0; }
.markdown strong { font-weight: 600; }
.markdown a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
</style>
