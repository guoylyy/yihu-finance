<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">基础资料</div>
        <div class="page-sub">客户、供应商、员工、项目与收支分类，是流水与单据的公共字典</div>
      </div>
    </div>

    <el-tabs v-model="tab" class="party-tabs">
      <el-tab-pane label="员工 / 个人" name="persons">
        <CrudTable v-if="tab === 'persons'" :api="api.persons" title="员工 / 个人" entity-name="员工"
                   subtitle="工资与报销的收款人，银行账号在这里维护，工资表导入时自动匹配"
                   :columns="personCols" :form-fields="personFields" :filters="companyFilter"
                   :default-form="{ type: 'EMPLOYEE', status: 'ACTIVE' }" :can-manage="can('party.manage')"
                   search-placeholder="搜索姓名 / 卡号" />
      </el-tab-pane>
      <el-tab-pane label="客户" name="customers">
        <CrudTable v-if="tab === 'customers'" :api="api.customers" title="客户" entity-name="客户"
                   :columns="customerCols" :form-fields="customerFields" :filters="companyFilter"
                   :default-form="{ status: 'ACTIVE' }" :can-manage="can('party.manage')" />
      </el-tab-pane>
      <el-tab-pane label="供应商" name="suppliers">
        <CrudTable v-if="tab === 'suppliers'" :api="api.suppliers" title="供应商" entity-name="供应商"
                   :columns="supplierCols" :form-fields="supplierFields" :filters="companyFilter"
                   :default-form="{ status: 'ACTIVE' }" :can-manage="can('party.manage')" />
      </el-tab-pane>
      <el-tab-pane label="项目" name="projects">
        <CrudTable v-if="tab === 'projects'" :api="api.projects" title="项目" entity-name="项目"
                   subtitle="给流水打项目标签后，可以按项目看收入和支出；可用 npm run sync:fde 从 FDE 平台同步"
                   :columns="projectCols" :form-fields="projectFields" :filters="projectFilters"
                   :default-form="{ status: 'ACTIVE' }" :can-manage="can('party.manage')" />
      </el-tab-pane>
      <el-tab-pane label="收支分类" name="categories">
        <CrudTable v-if="tab === 'categories'" :api="api.categories" title="收支分类" entity-name="分类"
                   subtitle="费用科目，用于费用排名与经营分析"
                   :columns="categoryCols" :form-fields="categoryFields"
                   :filters="[{ prop: 'kind', label: '收/支', type: 'select', width: 110, options: [{ value: 'IN', label: '收入' }, { value: 'OUT', label: '支出' }] }]"
                   :default-form="{ kind: 'OUT', status: 'ACTIVE', sortOrder: 99 }" :can-manage="can('party.manage')" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import CrudTable from '@/components/CrudTable.vue'
import { can } from '@/api/permissions'
import { companies, loadMeta } from '@/composables/useMeta'
import { PERSON_TYPES } from '@/constants'
import api from '@/api'

const tab = ref('persons')
const customers = ref([])
const companyOptions = () => companies.value.map((c) => ({ value: String(c.id), label: c.code }))
const companyFilter = [{ prop: 'company_id', label: '全部公司', type: 'select', width: 130, options: () => companyOptions() }]

const personCols = [
  { prop: 'name', label: '姓名', width: 100 },
  { prop: 'company.code', label: '公司', width: 110 },
  { prop: 'type', label: '类型', width: 100, type: 'enum', tagList: PERSON_TYPES },
  { prop: 'bankAccount', label: '银行账号', minWidth: 180 },
  { prop: 'bankName', label: '开户行', width: 150 },
  { prop: 'bankBranch', label: '开户支行', width: 180 },
  { prop: 'phone', label: '电话', width: 120 },
  { prop: 'monthSalary', label: '月薪', width: 100, align: 'right', type: 'money' }
]
const personFields = [
  { prop: 'name', label: '姓名', required: true },
  { prop: 'companyId', label: '所属公司', type: 'select', options: () => companyOptions() },
  { prop: 'type', label: '类型', type: 'select', options: PERSON_TYPES },
  { prop: 'bankAccount', label: '银行账号', hint: '工资表导入时按姓名匹配，缺账号会在月结检查中报出来' },
  { prop: 'bankName', label: '开户行' },
  { prop: 'bankBranch', label: '开户支行' },
  { prop: 'cnaps', label: '联行号' },
  { prop: 'phone', label: '电话' },
  { prop: 'monthSalary', label: '月薪', type: 'money' },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

const customerCols = [
  { prop: 'name', label: '客户名称', minWidth: 200 },
  { prop: 'company.code', label: '归属公司', width: 110 },
  { prop: 'taxNo', label: '税号', width: 190 },
  { prop: 'contact', label: '联系人', width: 90 },
  { prop: 'phone', label: '电话', width: 120 },
  { prop: 'remark', label: '备注', minWidth: 200, ellipsis: true }
]
const customerFields = [
  { prop: 'name', label: '客户名称', required: true },
  { prop: 'companyId', label: '归属公司', type: 'select', options: () => companyOptions() },
  { prop: 'taxNo', label: '税号' },
  { prop: 'contact', label: '联系人' },
  { prop: 'phone', label: '电话' },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

const supplierCols = [...customerCols, { prop: 'bankAccount', label: '收款账号', width: 180 }]
const supplierFields = [
  ...customerFields.slice(0, 5),
  { prop: 'bankAccount', label: '收款账号' },
  { prop: 'bankName', label: '开户行' },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

const PROJECT_STATUS = [
  { value: 'ACTIVE', label: '进行中', tag: 'success' },
  { value: 'PROPOSAL', label: '商机', tag: 'warning' },
  { value: 'CLOSED', label: '已结束', tag: 'info' }
]

const projectCols = [
  { prop: 'name', label: '项目名称', minWidth: 180 },
  { prop: 'code', label: '编号', width: 130 },
  { prop: 'company.code', label: '公司', width: 100 },
  { prop: 'customer.name', label: '客户', width: 190, ellipsis: true },
  { prop: 'budget', label: '预算', width: 110, align: 'right', type: 'money' },
  { prop: 'status', label: '状态', width: 90, type: 'tag', tagList: PROJECT_STATUS },
  { prop: 'remark', label: '备注', minWidth: 200, ellipsis: true }
]

const projectFilters = [
  ...companyFilter,
  { prop: 'status', label: '全部状态', type: 'select', width: 120, options: PROJECT_STATUS }
]
const projectFields = [
  { prop: 'name', label: '项目名称', required: true },
  { prop: 'code', label: '项目编号' },
  { prop: 'companyId', label: '所属公司', type: 'select', required: true, options: () => companyOptions() },
  { prop: 'customerId', label: '客户', type: 'select', options: () => customers.value.map((c) => ({ value: String(c.id), label: c.name })) },
  { prop: 'budget', label: '预算', type: 'money' },
  { prop: 'status', label: '状态', type: 'select', options: PROJECT_STATUS },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

const categoryCols = [
  { prop: 'kind', label: '收/支', width: 90, type: 'enum', tagList: [{ value: 'IN', label: '收入' }, { value: 'OUT', label: '支出' }] },
  { prop: 'name', label: '分类名称', minWidth: 160 },
  { prop: 'sortOrder', label: '排序', width: 80 }
]
const categoryFields = [
  { prop: 'kind', label: '收/支', type: 'select', required: true, options: [{ value: 'IN', label: '收入' }, { value: 'OUT', label: '支出' }] },
  { prop: 'name', label: '分类名称', required: true },
  { prop: 'sortOrder', label: '排序', type: 'number' }
]

onMounted(async () => {
  await loadMeta()
  customers.value = (await api.customers.list({ page_size: 300 })).list
})
</script>

<style scoped>
.party-tabs :deep(.el-tabs__content) { overflow: visible; }
.party-tabs :deep(.page) { padding-top: 0; }
.party-tabs :deep(.page-head) { margin-bottom: 12px; }
</style>
