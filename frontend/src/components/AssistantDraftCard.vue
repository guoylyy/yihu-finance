<!--
  录入助手的草稿卡：字段表格 + 缺失高亮 + 候选选择
  「填入表单」打开对应页面的弹窗预填；「确认提交」直接调该模块现有的创建/更新接口（权限、审计、余额重算照旧）
-->
<template>
  <div class="draft" :class="{ done: submitted }">
    <div class="draft-head">
      <span class="kind">{{ page.label }}草稿</span>
      <el-tag size="small" effect="plain" :type="draft.mode === 'update' ? 'warning' : 'success'">
        {{ draft.mode === 'update' ? `修改 #${draft.id}` : '新增' }}
      </el-tag>
      <el-tag v-if="submitted" size="small" type="success">已提交</el-tag>
    </div>

    <table class="fields">
      <tr v-for="f in rows" :key="f.key" :class="{ missing: isMissing(f.key) }">
        <th>{{ f.label }}</th>
        <td>
          <el-select v-if="draft.candidates?.[f.key]?.length && !submitted" :model-value="draft.payload[f.key]"
                     size="small" placeholder="请选择" style="width: 100%" @change="(v) => choose(f.key, v)">
            <el-option v-for="c in draft.candidates[f.key]" :key="c.id" :label="`${c.label}（#${c.id}）`" :value="c.id" />
          </el-select>
          <span v-else-if="isMissing(f.key)" class="need">待补充</span>
          <span v-else :class="{ money: f.type === 'money' }">{{ display(f) }}</span>
        </td>
      </tr>
    </table>

    <div v-if="draft.warnings?.length" class="warns">
      <div v-for="(w, i) in draft.warnings" :key="i">⚠ {{ w }}</div>
    </div>

    <div v-if="actionable" class="draft-actions">
      <el-button size="small" :disabled="submitted" @click="fillForm">填入表单</el-button>
      <el-tooltip :disabled="canSubmit" :content="submitBlockReason" placement="top">
        <span>
          <el-button size="small" type="primary" :disabled="!canSubmit" :loading="saving" @click="submit">确认提交</el-button>
        </span>
      </el-tooltip>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api'
import { can } from '@/api/permissions'
import { loadMeta } from '@/composables/useMeta'
import { ACCOUNT_TYPE_LABEL, BIZ_LABEL, CONFIDENCE, INVOICE_TYPES, labelOf } from '@/constants'
import { money } from '@/utils/format'
import { useAssistantStore, DRAFT_PAGES, DRAFT_ROUTES } from '@/stores/assistant'

const props = defineProps({ draft: { type: Object, required: true } })
const store = useAssistantStore()
const route = useRoute()
const router = useRouter()
const saving = ref(false)
const submitted = ref(false)

const DIRECTION = { IN: '收入', OUT: '支出' }
const FIELDS = {
  account: [
    ['companyId', '所属公司', 'ref'], ['name', '账户名称'], ['type', '账户类型', 'enum', (v) => ACCOUNT_TYPE_LABEL[v]],
    ['bankName', '开户机构'], ['accountNo', '账号'], ['currency', '币种'],
    ['initialBalance', '期初余额', 'money'], ['initialDate', '期初基准日'], ['remark', '备注']
  ],
  receivable: [
    ['companyId', '收款公司', 'ref'], ['customerId', '客户', 'ref'], ['projectId', '项目', 'ref'],
    ['contractNo', '合同号'], ['title', '款项说明'], ['amount', '应收金额', 'money'], ['expectDate', '预计收款日'],
    ['confidence', '把握度', 'enum', (v) => labelOf(CONFIDENCE, v)], ['remark', '备注']
  ],
  invoice: [
    ['companyId', '所属公司', 'ref'], ['type', '发票类型', 'enum', (v) => labelOf(INVOICE_TYPES, v)],
    ['invoiceNo', '发票号码'], ['invoiceCode', '发票代码'], ['issueDate', '开票日期'],
    ['sellerName', '开票方'], ['buyerName', '受票方'], ['amount', '不含税金额', 'money'],
    ['taxAmount', '税额', 'money'], ['totalAmount', '价税合计', 'money'], ['customerId', '客户', 'ref'], ['remark', '备注']
  ],
  transaction: [
    ['companyId', '公司', 'ref'], ['accountId', '账户', 'ref'], ['txnDate', '交易日期'],
    ['direction', '收支方向', 'enum', (v) => DIRECTION[v]], ['amount', '金额', 'money'], ['counterparty', '对方名称'],
    ['remark', '摘要'], ['bizType', '业务类型', 'enum', (v) => BIZ_LABEL[v]], ['projectId', '项目', 'ref']
  ]
}
const API = { account: api.accounts, receivable: api.receivables, invoice: api.invoices, transaction: api.transactions }
const MANAGE = { account: 'account.manage', receivable: 'receivable.manage', invoice: 'invoice.manage', transaction: 'transaction.manage' }

const page = computed(() => DRAFT_PAGES[props.draft.kind])
const isMissing = (k) => props.draft.missing?.includes(k)
// 修改模式只列草稿里改到的字段；新增模式列有值的、缺的、待选的
const rows = computed(() => (FIELDS[props.draft.kind] || [])
  .map(([key, label, type, fmt]) => ({ key, label, type, fmt }))
  .filter((f) => props.draft.payload[f.key] != null || isMissing(f.key) || props.draft.candidates?.[f.key]?.length))

function display(f) {
  const v = props.draft.payload[f.key]
  if (v == null || v === '') return '—'
  if (f.type === 'money') return money(v)
  if (f.type === 'ref') return `${props.draft.labels?.[f.key] || ''}（#${v}）`
  if (f.type === 'enum') return f.fmt(v) || v
  return v
}

// 草稿按钮只在支持录入的四个页面出现
const actionable = computed(() => DRAFT_ROUTES.includes(route.path))
const canSubmit = computed(() => !submitted.value && !props.draft.missing?.length && can(MANAGE[props.draft.kind]))
const submitBlockReason = computed(() => {
  if (submitted.value) return '已提交'
  if (props.draft.missing?.length) return '还有待补充的字段，请先在对话里补充或「填入表单」手工补齐'
  return `需要「${MANAGE[props.draft.kind]}」权限`
})

function choose(key, id) {
  const c = props.draft.candidates[key].find((x) => x.id === id)
  props.draft.payload[key] = id
  props.draft.labels = { ...props.draft.labels, [key]: c?.label }
  props.draft.missing = (props.draft.missing || []).filter((k) => k !== key)
}

async function fillForm() {
  if (route.path !== page.value.route) await router.push(page.value.route)
  store.requestPrefill(props.draft)
}

async function submit() {
  const verb = props.draft.mode === 'update' ? `修改${page.value.label} #${props.draft.id}` : `新增这条${page.value.label}`
  try {
    await ElMessageBox.confirm(`确认${verb}？提交后按正常流程留痕${['account', 'transaction'].includes(props.draft.kind) ? '，账户余额会自动重算' : ''}。`, '确认提交', { type: 'warning' })
  } catch { return }
  saving.value = true
  try {
    const target = API[props.draft.kind]
    if (props.draft.mode === 'update') await target.update(props.draft.id, props.draft.payload)
    else await target.create(props.draft.payload)
    submitted.value = true
    ElMessage.success('已提交')
    if (['account', 'transaction'].includes(props.draft.kind)) await loadMeta(true)
    store.notifyRefresh(props.draft.kind)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.draft { border: 1px solid var(--border-strong); border-radius: 8px; background: #fff; margin-top: 8px; overflow: hidden; }
.draft.done { opacity: 0.75; }
.draft-head { display: flex; align-items: center; gap: 6px; padding: 7px 10px; background: #fcfbfa; border-bottom: 1px solid var(--border); }
.kind { font-weight: 600; font-size: 13px; margin-right: auto; }
.fields { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.fields th { width: 84px; text-align: left; font-weight: 400; color: var(--text-muted); padding: 4px 10px; vertical-align: top; }
.fields td { padding: 4px 10px 4px 0; word-break: break-all; }
.fields tr.missing th, .need { color: var(--danger); font-weight: 600; }
.fields tr.missing { background: #fdf0ee; }
.warns { font-size: 12px; color: var(--warning); padding: 6px 10px; border-top: 1px dashed var(--border); line-height: 1.6; }
.draft-actions { display: flex; justify-content: flex-end; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--border); }

/* 手机：字段单列（标签在上、值在下），提交按钮钉在消息区可视范围底部（sticky），不随键盘被顶走 */
@media (max-width: 768px) {
  .draft { overflow: visible; }
  .kind { font-size: 14px; }
  .fields, .fields tbody, .fields tr, .fields th, .fields td { display: block; width: auto; }
  .fields { font-size: 14px; }
  .fields tr { padding: 6px 12px; border-bottom: 1px solid var(--border); }
  .fields tr:last-child { border-bottom: none; }
  .fields th { padding: 0 0 2px; font-size: 13px; }
  .fields td { padding: 0; }
  .warns { font-size: 13px; }
  .draft-actions {
    position: sticky; bottom: 0; z-index: 1; background: #fff;
    padding: 8px 10px; border-radius: 0 0 8px 8px;
  }
  .draft-actions > * { flex: 1; }
  .draft-actions .el-button { width: 100%; min-height: 44px; margin: 0; }
}
</style>
