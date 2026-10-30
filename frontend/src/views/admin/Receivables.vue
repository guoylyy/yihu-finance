<template>
  <CrudTable
    ref="tableRef"
    :api="api.receivables"
    title="应收与收款"
    subtitle="已经收到的钱：新增时勾「已收到款」并选账户；还没到账的：先登记应收，收到后点「登记回款」"
    entity-name="应收款"
    add-text="登记应收款"
    :columns="columns"
    :form-fields="formFields"
    :filters="filters"
    :default-form="{ status: 'PENDING', confidence: 'HIGH', amount: 0, received: false, receiptDate: today }"
    :can-manage="can('receivable.manage')"
    :action-width="200"
    pin-type="receivable"
    :pin-label="(r) => `${r.code} ${r.title}`"
    draft-kind="receivable"
    search-placeholder="搜索编号 / 标题 / 合同号"
    :before-save="beforeSave"
    :after-save="afterSave"
    @loaded="onLoaded"
  >
    <template #form-extra="{ form }">
      <el-divider content-position="left" style="margin: 4px 0 16px">
        <span class="muted" style="font-size: 12px">钱是否已经到账</span>
      </el-divider>
      <el-form-item label="已收到款">
        <el-switch v-model="form.received" :disabled="!!form.id" />
        <div class="muted" style="font-size: 12px; line-height: 1.6">
          不勾选 = 只登记「预计要收的钱」，不影响账户余额；
          勾选 = 同时记一笔收入流水，选中账户的余额立刻增加。
          <span v-if="form.id">已登记的应收款请用列表里的「登记回款」。</span>
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
      <el-button v-if="can('receivable.manage') && ['PENDING', 'PARTIAL'].includes(row.status)"
                 link type="primary" @click="openReceipt(row)">登记回款</el-button>
    </template>
  </CrudTable>

  <el-dialog v-model="receiptVisible" title="登记回款" width="460px">
    <el-alert v-if="current" type="info" :closable="false" style="margin-bottom: 14px"
              :title="`${current.title}｜应收 ¥${money(current.amount)}｜已收 ¥${money(current.receivedAmount)}`" />
    <el-form :model="receipt" label-width="100px">
      <el-form-item label="收款账户" required>
        <el-select v-model="receipt.accountId" style="width: 100%">
          <el-option v-for="a in accountsOf(current?.companyId)" :key="a.id" :label="`${a.name}（${a.currency}）`" :value="a.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="本次收款" required>
        <el-input-number v-model="receipt.amount" :precision="2" :min="0" :step="1000" style="width: 100%" inputmode="decimal" :controls="!isMobile" />
      </el-form-item>
      <el-form-item label="收款日期">
        <el-date-picker v-model="receipt.receiptDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="receipt.remark" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="receiptVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submitReceipt">确认收款</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import CrudTable from '@/components/CrudTable.vue'
import PinButton from '@/components/PinButton.vue'
import api from '@/api'
import { can } from '@/api/permissions'
import { companies, accountsOf, loadMeta } from '@/composables/useMeta'
import { RECEIVABLE_STATUS, CONFIDENCE } from '@/constants'
import { money } from '@/utils/format'
import { useViewport } from '@/composables/useViewport'
import { useDraftReceiver } from '@/stores/assistant'

const { isMobile } = useViewport()

const tableRef = ref(null)
const today = new Date().toISOString().slice(0, 10)
const receiptVisible = ref(false)
const saving = ref(false)
const current = ref(null)
const overdue = ref({})
const customers = ref([])
const receipt = ref({})

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

// 新增时勾了「已收到款」，紧接着登记一笔全额回款（生成收入流水并更新账户余额）
async function afterSave(row, form, isCreate) {
  if (!isCreate || !form.received) return
  if (!form.receiptAccountId) throw new Error('请选择收款账户')
  await api.receivables.receipt(row.id, {
    accountId: form.receiptAccountId,
    amount: form.amount,
    receiptDate: form.receiptDate || today
  })
  await loadMeta(true)   // 账户余额变了，刷新缓存
  ElMessage.success('已记一笔收入流水，账户余额同步更新')
}

function onLoaded(data) {
  overdue.value.pendingTotal = data.list
    .filter((r) => ['PENDING', 'PARTIAL'].includes(r.status))
    .reduce((s, r) => s + Number(r.amount) - Number(r.receivedAmount), 0)
}

function openReceipt(row) {
  current.value = row
  receipt.value = {
    amount: Number(row.amount) - Number(row.receivedAmount),
    receiptDate: new Date().toISOString().slice(0, 10),
    accountId: accountsOf(row.companyId)[0]?.id
  }
  receiptVisible.value = true
}

// 录入助手的回款草稿「填入表单」：打开这笔应收的登记回款弹窗，带上草稿里的账户 / 金额 / 日期
async function openReceiptPrefill(p) {
  if (!p.payload.refId) return ElMessage.warning('请先在草稿卡上选要冲减的应收')
  try {
    openReceipt(await api.receivables.get(p.payload.refId))
    const { accountId, amount, txnDate, remark } = p.payload
    receipt.value = {
      ...receipt.value,
      ...(accountId ? { accountId } : {}),
      ...(amount ? { amount: Number(amount) } : {}),
      ...(txnDate ? { receiptDate: txnDate } : {}),
      ...(remark ? { remark } : {})
    }
  } catch (e) {
    ElMessage.error(e.message)
  }
}
useDraftReceiver('receipt', { onPrefill: openReceiptPrefill })

async function submitReceipt() {
  saving.value = true
  try {
    await api.receivables.receipt(current.value.id, receipt.value)
    ElMessage.success('回款已登记，并生成了一笔收入流水')
    receiptVisible.value = false
    tableRef.value?.reload()
    loadOverdue()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

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
