<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">操作日志</div>
        <div class="page-sub">付款、月结、导入等关键动作全部留痕，可追溯到人</div>
      </div>
    </div>

    <FilterBar :active="(q.entity ? 1 : 0) + (q.action ? 1 : 0)" @done="reload">
      <template v-if="isMobile" #bar>
        <el-input v-model="q.keyword" placeholder="搜索操作人 / 摘要" clearable enterkeyhint="search" @keyup.enter="reload" @clear="reload" />
      </template>
      <el-select v-model="q.entity" placeholder="全部对象" clearable style="width: 150px" @change="reload">
        <el-option v-for="e in ENTITIES" :key="e.value" :label="e.label" :value="e.value" />
      </el-select>
      <el-select v-model="q.action" placeholder="全部动作" clearable style="width: 130px" @change="reload">
        <el-option v-for="a in ACTIONS" :key="a.value" :label="a.label" :value="a.value" />
      </el-select>
      <el-input v-if="!isMobile" v-model="q.keyword" placeholder="搜索操作人 / 摘要" clearable style="width: 200px" @keyup.enter="reload" @clear="reload" />
      <el-button v-if="!isMobile" type="primary" @click="reload">查询</el-button>
    </FilterBar>

    <div class="table-card">
      <ResponsiveTable :data="list" v-loading="loading" size="small">
        <el-table-column label="时间" width="150">
          <template #default="{ row }">{{ datetime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="userName" label="操作人" width="100" />
        <el-table-column label="动作" width="100" mobile="badge">
          <template #default="{ row }">
            <el-tag size="small" :type="ACTION_TAG[row.action] || 'info'" effect="plain">
              {{ labelOf(ACTIONS, row.action) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对象" width="120">
          <template #default="{ row }">{{ labelOf(ENTITIES, row.entity) }}</template>
        </el-table-column>
        <el-table-column prop="summary" label="摘要" min-width="280" show-overflow-tooltip mobile="title" />
        <el-table-column prop="ip" label="IP" width="140" />
      </ResponsiveTable>
      <div class="pager">
        <ResponsivePager v-model:current-page="page" :page-size="30" :total="total" layout="total, prev, pager, next" @change="load" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onActivated } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api'
import { labelOf } from '@/constants'
import { datetime } from '@/utils/format'
import ResponsiveTable from '@/components/mobile/ResponsiveTable'
import ResponsivePager from '@/components/mobile/ResponsivePager'
import FilterBar from '@/components/mobile/FilterBar.vue'
import { useViewport } from '@/composables/useViewport'

const { isMobile } = useViewport()

const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const q = reactive({ entity: '', action: '', keyword: '' })

const ENTITIES = [
  { value: 'transaction', label: '流水' }, { value: 'payment', label: '付款单' },
  { value: 'receivable', label: '应收款' }, { value: 'payable', label: '应付款' },
  { value: 'payroll', label: '工资' }, { value: 'reimbursement', label: '报销' },
  { value: 'invoice', label: '发票' }, { value: 'loan', label: '借款' },
  { value: 'account', label: '账户' }, { value: 'company', label: '公司' },
  { value: 'closePeriod', label: '月结' }, { value: 'user', label: '用户' },
  { value: 'transfer', label: '内部转账' }, { value: 'attachment', label: '附件' },
  { value: 'assistant', label: '录入助手' }
]
const ACTIONS = [
  { value: 'CREATE', label: '新增' }, { value: 'UPDATE', label: '修改' }, { value: 'DELETE', label: '作废' },
  { value: 'APPROVE', label: '审批' }, { value: 'REJECT', label: '驳回' }, { value: 'SUBMIT', label: '提交' },
  { value: 'PAY', label: '付款' }, { value: 'IMPORT', label: '导入' },
  { value: 'CLOSE', label: '月结' }, { value: 'REOPEN', label: '解锁' }, { value: 'CANCEL', label: '取消' },
  { value: 'assistant.chat', label: '助手对话' }
]
const ACTION_TAG = { CREATE: 'success', DELETE: 'danger', PAY: 'warning', APPROVE: 'success', REJECT: 'danger', CLOSE: 'warning', REOPEN: 'danger' }

async function load() {
  loading.value = true
  try {
    const data = await api.auditLogs.list({ ...q, page: page.value, page_size: 30 })
    list.value = data.list
    total.value = data.total
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function reload() { page.value = 1; load() }
onActivated(() => load())
onMounted(load)
</script>
