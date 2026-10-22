<template>
  <CrudTable
    ref="tableRef"
    :api="api.payments"
    title="付款管理"
    subtitle="草稿 → 待审批 → 待付款 → 已付款 → 已核对；付款与审批是两个独立权限"
    entity-name="付款单"
    add-text="新建付款单"
    selectable
    :columns="columns"
    :form-fields="formFields"
    :filters="filters"
    :default-form="{ status: 'DRAFT', payType: 'SUPPLIER', amount: 0 }"
    :can-manage="can('payment.manage')"
    :action-width="230"
    search-placeholder="搜索编号 / 收款方 / 用途"
  >
    <template #toolbar="{ selection, reload }">
      <el-button @click="exportPlan"><el-icon><Download /></el-icon>导出付款清单</el-button>
      <el-button v-if="can('payment.approve')" :disabled="!selection.length"
                 @click="batchApprove(selection, reload)">
        批量审批（{{ selection.length }}）
      </el-button>
    </template>

    <template #row-actions="{ row, reload }">
      <el-button v-if="can('payment.manage') && ['DRAFT', 'REJECTED'].includes(row.status)"
                 link type="primary" @click="act('submit', row, reload)">提交审批</el-button>
      <el-button v-if="can('payment.approve') && row.status === 'PENDING_APPROVAL'"
                 link type="primary" @click="act('approve', row, reload)">通过</el-button>
      <el-button v-if="can('payment.approve') && row.status === 'PENDING_APPROVAL'"
                 link type="danger" @click="act('reject', row, reload)">驳回</el-button>
      <el-button v-if="can('payment.pay') && row.status === 'APPROVED'"
                 link type="primary" @click="openPay(row)">标记已付</el-button>
    </template>
  </CrudTable>

  <el-dialog v-model="payVisible" title="标记已付款" width="460px">
    <el-alert v-if="current" type="warning" :closable="false" style="margin-bottom: 14px"
              :title="`将向「${current.payeeName}」支付 ¥${money(current.amount)}，并自动生成一笔支出流水`" />
    <el-form :model="payForm" label-width="100px">
      <el-form-item label="付款账户" required>
        <el-select v-model="payForm.accountId" style="width: 100%">
          <el-option v-for="a in accountsOf(current?.companyId)" :key="a.id"
                     :label="`${a.name}（余额 ${money(a.balance)}）`" :value="a.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="实际付款日">
        <el-date-picker v-model="payForm.paidDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="payForm.remark" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="payVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submitPay">确认已付款</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import CrudTable from '@/components/CrudTable.vue'
import api, { download } from '@/api'
import { can } from '@/api/permissions'
import { companies, accountsOf, loadMeta } from '@/composables/useMeta'
import { PAYMENT_STATUS, PAY_TYPES } from '@/constants'
import { money } from '@/utils/format'

const tableRef = ref(null)
const payVisible = ref(false)
const saving = ref(false)
const current = ref(null)
const payForm = ref({})

const companyOptions = () => companies.value.map((c) => ({ value: String(c.id), label: c.code }))

const columns = [
  { prop: 'code', label: '付款编号', width: 140 },
  { prop: 'company.code', label: '付款公司', width: 100 },
  { prop: 'payeeName', label: '收款方', minWidth: 180, ellipsis: true },
  { prop: 'payType', label: '类型', width: 100, type: 'enum', tagList: PAY_TYPES },
  { prop: 'amount', label: '金额', width: 120, align: 'right', type: 'money' },
  { prop: 'purpose', label: '付款用途', minWidth: 150, ellipsis: true },
  { prop: 'planDate', label: '计划付款', width: 105, type: 'date' },
  { prop: 'paidDate', label: '实际付款', width: 105, type: 'date' },
  { prop: 'approverName', label: '审批人', width: 90 },
  { prop: 'status', label: '状态', width: 100, type: 'tag', tagList: PAYMENT_STATUS }
]

const filters = [
  { prop: 'company_id', label: '全部公司', type: 'select', width: 120, options: () => companyOptions() },
  { prop: 'status', label: '状态', type: 'select', width: 130, options: PAYMENT_STATUS },
  { prop: 'pay_type', label: '付款类型', type: 'select', width: 130, options: PAY_TYPES },
  { prop: 'daterange', type: 'daterange' }
]

const formFields = [
  { prop: 'companyId', label: '付款公司', type: 'select', required: true, options: () => companyOptions() },
  { prop: 'payType', label: '付款类型', type: 'select', required: true, options: PAY_TYPES },
  { prop: 'payeeName', label: '收款方', required: true },
  { prop: 'payeeAccountNo', label: '收款账号' },
  { prop: 'payeeBankName', label: '开户行' },
  { prop: 'amount', label: '金额', type: 'money', required: true },
  { prop: 'purpose', label: '付款用途' },
  { prop: 'planDate', label: '计划付款日', type: 'date' },
  { prop: 'accountId', label: '付款账户', type: 'select', options: (form) => accountsOf(form?.companyId).map((a) => ({ value: String(a.id), label: a.name })) },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

async function act(action, row, reload) {
  const labels = { submit: '提交审批', approve: '审批通过', reject: '驳回', cancel: '取消' }
  let body
  if (action === 'reject') {
    const { value } = await ElMessageBox.prompt('请填写驳回原因', '驳回付款单', { inputPlaceholder: '原因' })
    body = { remark: value }
  }
  try {
    await api.payments[action](row.id, body)
    ElMessage.success(`${labels[action]}成功`)
    reload()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function batchApprove(selection, reload) {
  const rows = selection.filter((r) => r.status === 'PENDING_APPROVAL')
  if (!rows.length) return ElMessage.warning('选中的付款单里没有「待审批」状态的')
  await ElMessageBox.confirm(`确认批量审批通过 ${rows.length} 笔，合计 ¥${money(rows.reduce((s, r) => s + Number(r.amount), 0))}？`, '批量审批', { type: 'warning' })
  try {
    const r = await api.payments.batchApprove(rows.map((x) => x.id))
    ElMessage.success(`已审批 ${r.count} 笔`)
    reload()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

function openPay(row) {
  current.value = row
  payForm.value = {
    accountId: row.accountId ? String(row.accountId) : accountsOf(row.companyId)[0]?.id,
    paidDate: new Date().toISOString().slice(0, 10)
  }
  payVisible.value = true
}

async function submitPay() {
  saving.value = true
  try {
    await api.payments.pay(current.value.id, payForm.value)
    ElMessage.success('已标记付款，并生成了支出流水')
    payVisible.value = false
    tableRef.value?.reload()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function exportPlan() {
  try {
    await download(api.payments.planUrl, { export: 1 }, 'payment-plan.xlsx')
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(loadMeta)
</script>
