<template>
  <CrudTable
    ref="tableRef"
    :api="api.invoices"
    title="发票台账"
    subtitle="销项 / 进项 / 费用 / 红字发票，支持 Excel 导入与发票号查重"
    entity-name="发票"
    add-text="录入发票"
    :columns="columns"
    :form-fields="formFields"
    :filters="filters"
    :default-form="{ type: 'PURCHASE', status: 'PENDING', amount: 0, taxAmount: 0, totalAmount: 0 }"
    :can-manage="can('invoice.manage')"
    search-placeholder="搜索发票号 / 开票方 / 受票方"
    :action-width="170"
    pin-type="invoice"
    :pin-label="(r) => `发票 ${r.invoiceNo}`"
    draft-kind="invoice"
  >
    <template #toolbar="{ reload }">
      <el-upload v-if="can('invoice.manage')" :auto-upload="false" :show-file-list="false"
                 :on-change="(f) => importFile(f, reload)" style="display: inline-block; margin-right: 10px">
        <el-button><el-icon><Upload /></el-icon>Excel 导入</el-button>
      </el-upload>
      <el-button @click="showDuplicates">
        查重<el-badge v-if="stats.duplicateNos?.length" :value="stats.duplicateNos.length" style="margin-left: 4px" />
      </el-button>
    </template>

    <template #stats>
      <div class="stat-grid">
        <div v-for="t in stats.byType || []" :key="t.type" class="stat-card">
          <div class="label">{{ labelOf(INVOICE_TYPES, t.type) }}</div>
          <div class="value">¥{{ money(t.total) }}</div>
          <div class="foot">{{ t.count }} 张｜税额 {{ money(t.tax) }}</div>
        </div>
        <div class="stat-card is-accent">
          <div class="label">待处理</div>
          <div class="value">{{ stats.pendingCount || 0 }}</div>
          <div class="foot">未入账发票</div>
        </div>
      </div>
    </template>
  </CrudTable>

  <el-dialog v-model="dupVisible" title="重复发票号" width="720px">
    <el-alert type="warning" :closable="false" style="margin-bottom: 12px"
              title="同一公司下发票号重复，通常是重复录入或重复报销，请核实后作废其中一条" />
    <el-table :data="dupList" size="small">
      <el-table-column prop="invoiceNo" label="发票号码" width="180" />
      <el-table-column prop="company.code" label="公司" width="110" />
      <el-table-column label="类型" width="100">
        <template #default="{ row }">{{ labelOf(INVOICE_TYPES, row.type) }}</template>
      </el-table-column>
      <el-table-column label="开票日期" width="110">
        <template #default="{ row }">{{ date(row.issueDate) }}</template>
      </el-table-column>
      <el-table-column label="价税合计" align="right" width="120">
        <template #default="{ row }"><span class="money">{{ money(row.totalAmount) }}</span></template>
      </el-table-column>
      <el-table-column prop="sellerName" label="开票方" min-width="150" />
    </el-table>
  </el-dialog>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import CrudTable from '@/components/CrudTable.vue'
import api from '@/api'
import { can } from '@/api/permissions'
import { companies, loadMeta } from '@/composables/useMeta'
import { INVOICE_TYPES, INVOICE_STATUS, labelOf } from '@/constants'
import { money, date } from '@/utils/format'

const tableRef = ref(null)
const stats = ref({})
const dupVisible = ref(false)
const dupList = ref([])
const companyOptions = () => companies.value.map((c) => ({ value: String(c.id), label: c.code }))

const columns = [
  { prop: 'invoiceNo', label: '发票号码', width: 160 },
  { prop: 'company.code', label: '公司', width: 100 },
  { prop: 'type', label: '类型', width: 100, type: 'enum', tagList: INVOICE_TYPES },
  { prop: 'issueDate', label: '开票日期', width: 110, type: 'date' },
  { prop: 'sellerName', label: '开票方', minWidth: 160, ellipsis: true },
  { prop: 'buyerName', label: '受票方', minWidth: 160, ellipsis: true },
  { prop: 'amount', label: '金额', width: 110, align: 'right', type: 'money' },
  { prop: 'taxAmount', label: '税额', width: 100, align: 'right', type: 'money' },
  { prop: 'totalAmount', label: '价税合计', width: 120, align: 'right', type: 'money' },
  { prop: 'status', label: '状态', width: 90, type: 'tag', tagList: INVOICE_STATUS }
]

const filters = [
  { prop: 'company_id', label: '全部公司', type: 'select', width: 120, options: () => companyOptions() },
  { prop: 'type', label: '发票类型', type: 'select', width: 120, options: INVOICE_TYPES },
  { prop: 'status', label: '状态', type: 'select', width: 110, options: INVOICE_STATUS },
  { prop: 'daterange', type: 'daterange' }
]

const formFields = [
  { prop: 'companyId', label: '所属公司', type: 'select', required: true, options: () => companyOptions() },
  { prop: 'type', label: '发票类型', type: 'select', required: true, options: INVOICE_TYPES },
  { prop: 'invoiceNo', label: '发票号码', required: true },
  { prop: 'invoiceCode', label: '发票代码' },
  { prop: 'issueDate', label: '开票日期', type: 'date' },
  { prop: 'sellerName', label: '开票方' },
  { prop: 'buyerName', label: '受票方' },
  { prop: 'amount', label: '不含税金额', type: 'money' },
  { prop: 'taxAmount', label: '税额', type: 'money' },
  { prop: 'totalAmount', label: '价税合计', type: 'money', hint: '三个金额填两个，第三个会自动补齐' },
  { prop: 'status', label: '状态', type: 'select', options: INVOICE_STATUS },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

async function loadStats() {
  try { stats.value = await api.invoices.stats() } catch { /* 统计失败不影响列表 */ }
}

async function importFile(f, reload) {
  const fd = new FormData()
  fd.append('file', f.raw)
  fd.append('companyId', companies.value[0]?.id)
  fd.append('type', 'PURCHASE')
  try {
    const r = await api.invoices.importFile(fd)
    ElMessage.success(`导入成功 ${r.success} 张${r.skipped.length ? `，跳过 ${r.skipped.length} 张` : ''}`)
    reload(); loadStats()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function showDuplicates() {
  try {
    const d = await api.invoices.duplicates()
    dupList.value = d.list
    if (!d.count) return ElMessage.success('没有发现重复发票号')
    dupVisible.value = true
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(async () => { await loadMeta(); loadStats() })
</script>
