<template>
  <CrudTable
    ref="tableRef"
    :api="api.receivables"
    title="应收与收款"
    subtitle="已经收到的钱：新增时勾「已收到款」并选账户；还没到账的：先登记应收，钱到了点「认领流水」从流水里选那笔（找不到再新建）"
    entity-name="应收款"
    add-text="登记应收款"
    :columns="columns"
    :form-fields="formFields"
    :filters="filters"
    :default-form="{ status: 'PENDING', confidence: 'HIGH', amount: 0, received: false, receiptDate: today }"
    :can-manage="can('receivable.manage')"
    :action-width="250"
    pin-type="receivable"
    :pin-label="(r) => `${r.code} ${r.title}`"
    draft-kind="receivable"
    search-placeholder="搜索编号 / 标题 / 合同号"
    :before-save="beforeSave"
    :after-save="afterSave"
    @loaded="onLoaded"
  >
    <template #form-extra="{ form }">
      <ReceivableInvoicePicker :form="form" :customers="customers" />
      <el-divider content-position="left" style="margin: 4px 0 16px">
        <span class="muted" style="font-size: 12px">钱是否已经到账</span>
      </el-divider>
      <el-form-item label="已收到款">
        <el-switch v-model="form.received" :disabled="!!form.id" />
        <div class="muted" style="font-size: 12px; line-height: 1.6">
          不勾选 = 只登记「预计要收的钱」，不影响账户余额；
          勾选 = 同时记一笔收入流水，选中账户的余额立刻增加。
          <span v-if="form.id">已登记的应收款请用列表里的「认领流水」。</span>
        </div>
      </el-form-item>
      <template v-if="form.received && !form.id">
        <el-form-item label="收款账户" required>
          <el-select v-model="form.receiptAccountId" style="width: 100%" placeholder="钱收到哪个账户">
            <el-option v-for="a in accountsOf(form.companyId)" :key="a.id"
                       :label="`${a.name}（${a.currency}｜余额 ${money(a.balance)}）`" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="收款日期">
          <el-date-picker v-model="form.receiptDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
      </template>
    </template>
    <template #stats>
      <div class="stat-grid">
        <div class="stat-card is-accent">
          <div class="label">未收合计（全部）</div>
          <div class="value">¥{{ money(overdue.pendingTotal) }}</div>
        </div>
        <div class="stat-card is-danger">
          <div class="label">逾期未收</div>
          <div class="value">¥{{ money(overdue.total) }}</div>
          <div class="foot">{{ overdue.count || 0 }} 笔已过预计收款日</div>
        </div>
      </div>
    </template>

    <template #[`col-customer.name`]="{ row }">
      <template v-if="row.customer">
        {{ row.customer.name }}
        <PinButton type="customer" :id="row.customer.id" :label="row.customer.name" />
      </template>
      <span v-else>—</span>
    </template>

    <template #col-amount="{ row }">
      <div class="money">{{ money(row.amount) }}</div>
      <div class="muted" style="font-size: 12px">已收 {{ money(row.receivedAmount) }}</div>
    </template>

    <template #row-actions="{ row }">
      <el-button link type="primary" @click="drawerRef?.open(row.id)">详情</el-button>
      <el-button v-if="can('receivable.manage') && ['PENDING', 'PARTIAL'].includes(row.status)"
                 link type="primary" @click="openReceipt(row)">认领流水</el-button>
    </template>
  </CrudTable>

  <ReceiptDialog ref="receiptRef" @done="onReceiptDone" />
  <ReceivableDrawer ref="drawerRef" @claim="openReceipt" @changed="refresh" />

</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import CrudTable from '@/components/CrudTable.vue'
import PinButton from '@/components/PinButton.vue'
import ReceiptDialog from '@/components/ReceiptDialog.vue'
import ReceivableDrawer from '@/components/ReceivableDrawer.vue'
import ReceivableInvoicePicker from '@/components/ReceivableInvoicePicker.vue'
import api from '@/api'
import { can } from '@/api/permissions'
import { companies, accountsOf, loadMeta } from '@/composables/useMeta'
import { RECEIVABLE_STATUS, CONFIDENCE } from '@/constants'
import { money } from '@/utils/format'
import { useDraftReceiver } from '@/stores/assistant'
import { receiptToast } from '@/utils/receipt'

const tableRef = ref(null)
const receiptRef = ref(null)
const drawerRef = ref(null)
const today = new Date().toISOString().slice(0, 10)
const overdue = ref({})
const customers = ref([])

const companyOptions = () => companies.value.map((c) => ({ value: String(c.id), label: c.code }))
const customerOptions = () => customers.value.map((c) => ({ value: String(c.id), label: c.name }))

const columns = [
  { prop: 'code', label: '编号', width: 130 },
  { prop: 'company.code', label: '公司', width: 100 },
  { prop: 'customer.name', label: '客户', width: 150 },
  { prop: 'title', label: '款项说明', minWidth: 180, ellipsis: true },
  { prop: 'amount', label: '应收 / 已收', width: 130, align: 'right' },
  { prop: 'expectDate', label: '预计收款', width: 110, type: 'date' },
  { prop: 'actualDate', label: '实际收款', width: 110, type: 'date' },
  { prop: 'confidence', label: '把握度', width: 90, type: 'tag', tagList: CONFIDENCE },
  { prop: 'status', label: '状态', width: 100, type: 'tag', tagList: RECEIVABLE_STATUS }
]

const filters = [
  { prop: 'company_id', label: '全部公司', type: 'select', width: 120, options: () => companyOptions() },
  { prop: 'status', label: '状态', type: 'select', width: 120, options: RECEIVABLE_STATUS },
  { prop: 'daterange', type: 'daterange' }
]

const formFields = [
  { prop: 'companyId', label: '收款公司', type: 'select', required: true, options: () => companyOptions() },
  { prop: 'customerId', label: '客户', type: 'select', options: () => customerOptions() },
  { prop: 'title', label: '款项说明', required: true, placeholder: '如：某某项目一期款' },
  { prop: 'contractNo', label: '合同号' },
  { prop: 'amount', label: '应收金额', type: 'money', required: true },
  { prop: 'expectDate', label: '预计收款日', type: 'date' },
  { prop: 'confidence', label: '把握度', type: 'select', options: CONFIDENCE, hint: '影响资金预测口径：已确认的收款才计入保守预测' },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

// 勾了「已收到款」却没选账户就别往下走了，免得建出一条没记账的应收款
function beforeSave(form) {
  if (!form.id && form.received && !form.receiptAccountId) {
    ElMessage.warning('请选择这笔钱收到哪个账户')
    return null
  }
  return form
}

// 保存后：① 按表单里选的发票逐张挂 / 摘；② 新增时勾了「已收到款」，紧接着登记一笔全额回款（生成收入流水并更新账户余额）
async function afterSave(row, form, isCreate) {
  await syncInvoices(row, form)
  if (!isCreate || !form.received) return
  if (!form.receiptAccountId) throw new Error('请选择收款账户')
  const r = await api.receivables.receipt(row.id, {
    accountId: form.receiptAccountId,
    amount: form.amount,
    receiptDate: form.receiptDate || today
  })
  await loadMeta(true)   // 账户余额变了，刷新缓存
  receiptToast(r, row.code, { newTxn: true })
}

// 发票整组对齐：新选的挂上、去掉的摘除（PATCH /invoices/:id），后端的提示（客户不一致等）原样弹出
async function syncInvoices(row, form) {
  if (!form.invoiceIds) return
  const orig = form._origInvoiceIds || []
  const add = form.invoiceIds.filter((id) => !orig.includes(id))
  const drop = orig.filter((id) => !form.invoiceIds.includes(id))
  const warns = []
  for (const id of add) warns.push(...((await api.invoices.linkReceivable(id, row.id)).warnings || []))
  for (const id of drop) await api.invoices.linkReceivable(id, null)
  if (add.length || drop.length) ElMessage.success(`发票已更新：挂上 ${add.length} 张，摘除 ${drop.length} 张`)
  if (warns.length) ElMessage({ type: 'warning', message: warns.join('；'), duration: 6000, showClose: true })
}

function onLoaded(data) {
  overdue.value.pendingTotal = data.list
    .filter((r) => ['PENDING', 'PARTIAL'].includes(r.status))
    .reduce((s, r) => s + Number(r.amount) - Number(r.receivedAmount), 0)
}

function openReceipt(row) {
  receiptRef.value?.open(row)
}

function refresh() {
  tableRef.value?.reload()
  loadOverdue()
}

function onReceiptDone() {
  refresh()
  drawerRef.value?.reload?.()
}

// 录入助手的回款草稿「填入表单」：打开这笔应收的认领弹窗「新建流水」页，带上草稿里的账户 / 金额 / 日期；
// 弹窗里可以「上一步」改为从已有流水里选，避免重复入账
async function openReceiptPrefill(p) {
  if (!p.payload.refId) return ElMessage.warning('请先在草稿卡上选要冲减的应收')
  try {
    const row = await api.receivables.get(p.payload.refId)
    const { accountId, amount, txnDate, remark } = p.payload
    receiptRef.value?.open(row, {
      mode: 'new',
      prefill: {
        ...(accountId ? { accountId } : {}),
        ...(amount ? { amount: Number(amount) } : {}),
        ...(txnDate ? { receiptDate: txnDate } : {}),
        ...(remark ? { remark } : {})
      }
    })
  } catch (e) {
    ElMessage.error(e.message)
  }
}
useDraftReceiver('receipt', { onPrefill: openReceiptPrefill })

async function loadOverdue() {
  try {
    const d = await api.receivables.overdue()
    overdue.value = { ...overdue.value, total: d.total, count: d.count }
  } catch { /* 非关键数据，失败就不显示 */ }
}

onMounted(async () => {
  await loadMeta()
  customers.value = (await api.customers.list({ page_size: 200 })).list
  loadOverdue()
})
</script>
