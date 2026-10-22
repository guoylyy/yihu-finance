<template>
  <CrudTable
    ref="tableRef"
    :api="api.reimbursements"
    title="报销管理"
    subtitle="提交 → 审批 → 生成付款单 → 付款后自动回写状态"
    entity-name="报销单"
    add-text="提交报销"
    selectable
    :columns="columns"
    :form-fields="formFields"
    :filters="filters"
    :default-form="{ status: 'PENDING', category: '交通', amount: 0, expenseDate: today }"
    :can-manage="can('reimburse.submit')"
    :action-width="180"
    search-placeholder="搜索编号 / 报销人 / 事由"
  >
    <template #toolbar="{ selection, reload }">
      <el-button v-if="can('reimburse.approve')" :disabled="!selection.length"
                 @click="generatePayments(selection, reload)">
        生成付款单（{{ selection.length }}）
      </el-button>
    </template>

    <template #row-actions="{ row, reload }">
      <el-button v-if="can('reimburse.approve') && ['PENDING', 'DRAFT'].includes(row.status)"
                 link type="primary" @click="approve(row, reload)">通过</el-button>
      <el-button v-if="can('reimburse.approve') && ['PENDING', 'DRAFT'].includes(row.status)"
                 link type="danger" @click="reject(row, reload)">驳回</el-button>
    </template>
  </CrudTable>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import CrudTable from '@/components/CrudTable.vue'
import api from '@/api'
import { can } from '@/api/permissions'
import { companies, persons, loadMeta, loadPersons } from '@/composables/useMeta'
import { REIMBURSE_STATUS } from '@/constants'
import { money } from '@/utils/format'

const tableRef = ref(null)
const today = new Date().toISOString().slice(0, 10)
const CATEGORIES = ['交通', '餐饮', '差旅', '办公', '通讯', '业务招待', '快递', '其他'].map((v) => ({ value: v, label: v }))
const companyOptions = () => companies.value.map((c) => ({ value: String(c.id), label: c.code }))

const columns = [
  { prop: 'code', label: '编号', width: 140 },
  { prop: 'company.code', label: '公司', width: 100 },
  { prop: 'applicantName', label: '报销人', width: 100 },
  { prop: 'category', label: '费用分类', width: 100 },
  { prop: 'amount', label: '金额', width: 110, align: 'right', type: 'money' },
  { prop: 'expenseDate', label: '费用日期', width: 110, type: 'date' },
  { prop: 'reason', label: '事由', minWidth: 180, ellipsis: true },
  { prop: 'status', label: '状态', width: 100, type: 'tag', tagList: REIMBURSE_STATUS }
]

const filters = [
  { prop: 'company_id', label: '全部公司', type: 'select', width: 120, options: () => companyOptions() },
  { prop: 'status', label: '状态', type: 'select', width: 120, options: REIMBURSE_STATUS },
  { prop: 'category', label: '费用分类', type: 'select', width: 120, options: CATEGORIES },
  { prop: 'daterange', type: 'daterange' }
]

const formFields = [
  { prop: 'companyId', label: '所属公司', type: 'select', required: true, options: () => companyOptions() },
  { prop: 'personId', label: '报销人', type: 'select', options: () => persons.value.map((p) => ({ value: String(p.id), label: `${p.name}` })),
    onChange: (form) => {
      const p = persons.value.find((x) => String(x.id) === String(form.personId))
      if (p) form.applicantName = p.name
    } },
  { prop: 'applicantName', label: '报销人姓名', required: true },
  { prop: 'category', label: '费用分类', type: 'select', options: CATEGORIES },
  { prop: 'amount', label: '报销金额', type: 'money', required: true },
  { prop: 'expenseDate', label: '费用日期', type: 'date' },
  { prop: 'reason', label: '事由', type: 'textarea' }
]

async function approve(row, reload) {
  try {
    await api.reimbursements.approve(row.id)
    ElMessage.success('已通过，可生成付款单')
    reload()
  } catch (e) { ElMessage.error(e.message) }
}

async function reject(row, reload) {
  const { value } = await ElMessageBox.prompt('请填写驳回原因', '驳回报销', { inputPlaceholder: '原因' })
  try {
    await api.reimbursements.reject(row.id, { remark: value })
    ElMessage.success('已驳回')
    reload()
  } catch (e) { ElMessage.error(e.message) }
}

async function generatePayments(selection, reload) {
  const rows = selection.filter((r) => r.status === 'APPROVED')
  if (!rows.length) return ElMessage.warning('只有「待付款」状态的报销单可以生成付款单')
  await ElMessageBox.confirm(
    `将为 ${rows.length} 笔报销（合计 ¥${money(rows.reduce((s, r) => s + Number(r.amount), 0))}）生成付款单，同一人多笔会合并成一张。`,
    '生成付款单', { type: 'info' }
  )
  try {
    const r = await api.reimbursements.generatePayments({ ids: rows.map((x) => x.id), merge: true })
    ElMessage.success(`已生成 ${r.count} 张付款单，去「付款管理」提交审批`)
    reload()
  } catch (e) { ElMessage.error(e.message) }
}

onMounted(async () => { await loadMeta(); await loadPersons() })
</script>
