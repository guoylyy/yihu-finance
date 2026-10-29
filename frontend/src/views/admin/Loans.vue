<template>
  <CrudTable
    ref="tableRef"
    :api="api.loans"
    title="借贷与公司间往来"
    subtitle="公司借给个人、个人借给公司、公司间拆借与代付，还款可自动生成流水"
    entity-name="借款"
    add-text="登记借款"
    :columns="columns"
    :form-fields="formFields"
    :filters="filters"
    :default-form="{ direction: 'COMPANY_TO_PERSON', status: 'OPEN', principal: 0 }"
    :can-manage="can('loan.manage')"
    :action-width="170"
    search-placeholder="搜索编号 / 对方名称"
  >
    <template #stats>
      <div class="stat-grid">
        <div class="stat-card is-accent">
          <div class="label">未还本金合计</div>
          <div class="value">¥{{ money(summary.outstanding) }}</div>
          <div class="foot">{{ summary.count || 0 }} 笔未结清</div>
        </div>
        <div class="stat-card is-danger">
          <div class="label">已逾期</div>
          <div class="value">¥{{ money(summary.overdueAmount) }}</div>
          <div class="foot">{{ summary.overdueCount || 0 }} 笔已过到期日</div>
        </div>
      </div>
    </template>

    <template #col-principal="{ row }">
      <div class="money">{{ money(row.principal) }}</div>
      <div class="muted" style="font-size: 12px">已还 {{ money(row.repaidAmount) }}</div>
    </template>

    <template #row-actions="{ row }">
      <el-button v-if="can('loan.manage') && row.status !== 'CLOSED'" link type="primary" @click="openRepay(row)">登记还款</el-button>
    </template>
  </CrudTable>

  <el-dialog v-model="repayVisible" title="登记还款" width="460px">
    <el-alert v-if="current" type="info" :closable="false" style="margin-bottom: 14px"
              :title="`${current.counterpartyName}｜本金 ¥${money(current.principal)}｜已还 ¥${money(current.repaidAmount)}`" />
    <el-form :model="repay" label-width="110px">
      <el-form-item label="还款金额" required>
        <el-input-number v-model="repay.amount" :precision="2" :min="0" style="width: 100%" inputmode="decimal" :controls="!isMobile" />
      </el-form-item>
      <el-form-item label="还款日期">
        <el-date-picker v-model="repay.repayDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item label="同时记流水">
        <el-switch v-model="repay.createTransaction" />
      </el-form-item>
      <el-form-item v-if="repay.createTransaction" label="资金账户">
        <el-select v-model="repay.accountId" style="width: 100%">
          <el-option v-for="a in accountsOf(current?.companyId)" :key="a.id" :label="a.name" :value="a.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="repay.remark" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="repayVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submitRepay">确认</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import CrudTable from '@/components/CrudTable.vue'
import api from '@/api'
import { can } from '@/api/permissions'
import { companies, persons, accountsOf, loadMeta, loadPersons } from '@/composables/useMeta'
import { LOAN_DIRECTIONS, LOAN_STATUS } from '@/constants'
import { money } from '@/utils/format'
import { useViewport } from '@/composables/useViewport'

const { isMobile } = useViewport()

const tableRef = ref(null)
const summary = ref({})
const repayVisible = ref(false)
const saving = ref(false)
const current = ref(null)
const repay = ref({})
const companyOptions = () => companies.value.map((c) => ({ value: String(c.id), label: c.code }))

const columns = [
  { prop: 'code', label: '编号', width: 130 },
  { prop: 'company.code', label: '公司', width: 100 },
  { prop: 'direction', label: '类型', width: 130, type: 'enum', tagList: LOAN_DIRECTIONS },
  { prop: 'counterpartyName', label: '对方', width: 150 },
  { prop: 'principal', label: '本金 / 已还', width: 130, align: 'right' },
  { prop: 'startDate', label: '借出日', width: 105, type: 'date' },
  { prop: 'dueDate', label: '到期日', width: 105, type: 'date' },
  { prop: 'status', label: '状态', width: 100, type: 'tag', tagList: LOAN_STATUS },
  { prop: 'remark', label: '备注', minWidth: 140, ellipsis: true }
]

const filters = [
  { prop: 'company_id', label: '全部公司', type: 'select', width: 120, options: () => companyOptions() },
  { prop: 'direction', label: '借贷类型', type: 'select', width: 150, options: LOAN_DIRECTIONS },
  { prop: 'status', label: '状态', type: 'select', width: 120, options: LOAN_STATUS }
]

const formFields = [
  { prop: 'companyId', label: '所属公司', type: 'select', required: true, options: () => companyOptions() },
  { prop: 'direction', label: '借贷类型', type: 'select', required: true, options: LOAN_DIRECTIONS },
  { prop: 'counterpartyName', label: '对方名称', required: true },
  { prop: 'personId', label: '关联员工', type: 'select', options: () => persons.value.map((p) => ({ value: String(p.id), label: p.name })) },
  { prop: 'principal', label: '本金', type: 'money', required: true },
  { prop: 'interestRate', label: '年利率(%)', type: 'number' },
  { prop: 'startDate', label: '借出日期', type: 'date' },
  { prop: 'dueDate', label: '到期日期', type: 'date' },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

function openRepay(row) {
  current.value = row
  repay.value = {
    amount: Number(row.principal) - Number(row.repaidAmount),
    repayDate: new Date().toISOString().slice(0, 10),
    createTransaction: true,
    accountId: accountsOf(row.companyId)[0]?.id
  }
  repayVisible.value = true
}

async function submitRepay() {
  saving.value = true
  try {
    await api.loans.repay(current.value.id, repay.value)
    ElMessage.success('还款已登记')
    repayVisible.value = false
    tableRef.value?.reload()
    loadSummary()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function loadSummary() {
  try { summary.value = await api.loans.summary() } catch { /* 忽略 */ }
}

onMounted(async () => { await loadMeta(); await loadPersons(); loadSummary() })
</script>
