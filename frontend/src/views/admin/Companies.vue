<template>
  <CrudTable
    :api="api.companies"
    title="公司管理"
    subtitle="以公司为第一管理维度，集团各公司在此维护"
    entity-name="公司"
    add-text="新增公司"
    :columns="columns"
    :form-fields="formFields"
    :default-form="{ status: 'ACTIVE', sortOrder: 99 }"
    :can-manage="can('company.manage')"
    search-placeholder="搜索简称 / 全称 / 税号"
  >
    <template #row-actions="{ row }">
      <el-button link type="primary" @click="showOverview(row)">概览</el-button>
    </template>
  </CrudTable>

  <el-dialog v-model="visible" :title="`${current?.code} 财务概览`" width="620px">
    <div v-if="ov.company">
      <div class="stat-grid">
        <div class="stat-card is-accent">
          <div class="label">账户余额</div>
          <div class="value">¥{{ money(ov.balanceByCurrency?.CNY) }}</div>
          <div class="foot" v-if="ov.balanceByCurrency?.USD">$ {{ money(ov.balanceByCurrency.USD) }}</div>
        </div>
        <div class="stat-card is-success">
          <div class="label">本月收入</div><div class="value">¥{{ money(ov.income) }}</div>
        </div>
        <div class="stat-card is-danger">
          <div class="label">本月支出</div><div class="value">¥{{ money(ov.expense) }}</div>
        </div>
      </div>
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="待收款">¥{{ money(ov.pendingReceivable) }}</el-descriptions-item>
        <el-descriptions-item label="待付款">¥{{ money(ov.pendingPayment) }}</el-descriptions-item>
        <el-descriptions-item label="净现金流">¥{{ money(ov.netCashFlow) }}</el-descriptions-item>
        <el-descriptions-item label="待核对流水">{{ ov.unreconciledCount }} 笔</el-descriptions-item>
      </el-descriptions>
      <div class="section-title">账户</div>
      <el-table :data="ov.accounts" size="small">
        <el-table-column prop="name" label="账户" />
        <el-table-column prop="currency" label="币种" width="70" />
        <el-table-column label="余额" align="right">
          <template #default="{ row }"><span class="money">{{ money(row.balance) }}</span></template>
        </el-table-column>
      </el-table>
    </div>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import CrudTable from '@/components/CrudTable.vue'
import api from '@/api'
import { can } from '@/api/permissions'
import { money } from '@/utils/format'

const visible = ref(false)
const current = ref(null)
const ov = ref({})

const columns = [
  { prop: 'code', label: '简称', width: 120 },
  { prop: 'name', label: '公司全称', minWidth: 200 },
  { prop: 'taxNo', label: '统一社会信用代码', width: 190 },
  { prop: 'legalPerson', label: '法定代表人', width: 110 },
  { prop: 'sharePercent', label: '持股比例', width: 100, formatter: (r) => (r.sharePercent ? `${Number(r.sharePercent)}%` : '—') },
  { prop: 'capital', label: '注册资本', width: 120, align: 'right', type: 'money' },
  { prop: 'mainBusiness', label: '主营业务', minWidth: 160, ellipsis: true },
  { prop: 'status', label: '状态', width: 80, type: 'tag', tagList: [{ value: 'ACTIVE', label: '启用', tag: 'success' }, { value: 'DISABLED', label: '停用', tag: 'info' }] }
]

const formFields = [
  { prop: 'code', label: '简称', required: true, placeholder: '如：云帆科技' },
  { prop: 'name', label: '公司全称', required: true },
  { prop: 'taxNo', label: '统一社会信用代码' },
  { prop: 'legalPerson', label: '法定代表人' },
  { prop: 'mainBusiness', label: '主营业务' },
  { prop: 'sharePercent', label: '持股比例(%)', type: 'number' },
  { prop: 'capital', label: '注册资本', type: 'money' },
  { prop: 'sortOrder', label: '排序', type: 'number' },
  { prop: 'status', label: '状态', type: 'select', options: [{ value: 'ACTIVE', label: '启用' }, { value: 'DISABLED', label: '停用' }] },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

async function showOverview(row) {
  current.value = row
  try {
    ov.value = await api.companies.overview(row.id)
    visible.value = true
  } catch (e) {
    ElMessage.error(e.message)
  }
}
</script>
