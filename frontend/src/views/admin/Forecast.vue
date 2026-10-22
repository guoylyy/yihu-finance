<template>
  <div class="page" v-loading="loading">
    <div class="page-head">
      <div>
        <div class="page-title">资金预测</div>
        <div class="page-sub">预计期末余额 = 当前可用余额 + 预计收款 − 已审批待付款 − 固定周期支出</div>
      </div>
      <div>
        <el-select v-model="companyId" placeholder="集团合计" clearable style="width: 140px" @change="load">
          <el-option v-for="c in companies" :key="c.id" :label="c.code" :value="c.id" />
        </el-select>
        <el-button style="margin-left: 8px" @click="itemsVisible = true">固定周期收支</el-button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card is-accent">
        <div class="label">当前可用余额</div>
        <div class="value">¥{{ money(data.available) }}</div>
        <div class="foot">仅统计人民币活期账户</div>
      </div>
      <div v-for="w in data.windows || []" :key="w.days" class="stat-card" :class="w.gap ? 'is-danger' : ''">
        <div class="label">未来 {{ w.days }} 天期末</div>
        <div class="value">¥{{ money(w.endingBalance) }}</div>
        <div class="foot">
          流入 {{ money(w.inflow) }} · 流出 {{ money(w.outflow) }}
          <span v-if="w.gap" class="money-out">· 缺口 {{ money(w.gap) }}</span>
        </div>
      </div>
    </div>

    <div class="section-title">未来 90 天余额曲线</div>
    <div class="chart-card"><div ref="curveRef" class="chart"></div></div>

    <div class="section-title">预测事项明细</div>
    <div class="table-card">
      <el-table :data="data.events || []" size="small" max-height="460">
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column label="方向" width="70">
          <template #default="{ row }">
            <el-tag size="small" :type="row.direction === 'IN' ? 'success' : 'danger'" effect="plain">
              {{ row.direction === 'IN' ? '流入' : '流出' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="事项" min-width="240" show-overflow-tooltip />
        <el-table-column label="金额" width="130" align="right">
          <template #default="{ row }">
            <span class="money" :class="row.direction === 'IN' ? 'money-in' : 'money-out'">{{ money(row.amount) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="110">
          <template #default="{ row }">{{ SOURCE[row.source] || row.source }}</template>
        </el-table-column>
        <el-table-column label="把握度" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="tagOf(CONFIDENCE, row.confidence)">{{ labelOf(CONFIDENCE, row.confidence) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="提示" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.overdue" size="small" type="danger">已逾期</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-drawer v-model="itemsVisible" title="固定周期收支" size="720px">
      <CrudTable :api="api.forecast.items" title="" entity-name="固定收支"
                 subtitle="房租、社保、云服务等按月发生的固定项，用于把预测做准"
                 :columns="itemCols" :form-fields="itemFields"
                 :default-form="{ direction: 'OUT', frequency: 'MONTHLY', dayOfMonth: 1, confidence: 'HIGH', amount: 0 }"
                 :can-manage="can('forecast.manage')" :searchable="false" @loaded="load" />
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick, onActivated } from 'vue'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts'
import CrudTable from '@/components/CrudTable.vue'
import api from '@/api'
import { can } from '@/api/permissions'
import { companies, loadMeta } from '@/composables/useMeta'
import { CONFIDENCE, labelOf, tagOf } from '@/constants'
import { money } from '@/utils/format'

const loading = ref(false)
const companyId = ref('')
const data = ref({})
const itemsVisible = ref(false)
const curveRef = ref(null)
let curveChart = null

const SOURCE = { RECEIVABLE: '应收款', PAYMENT: '付款单', FIXED: '固定收支' }
const companyOptions = () => companies.value.map((c) => ({ value: String(c.id), label: c.code }))

const itemCols = [
  { prop: 'name', label: '名称', minWidth: 150 },
  { prop: 'company.code', label: '公司', width: 100 },
  { prop: 'direction', label: '方向', width: 80, type: 'enum', tagList: [{ value: 'IN', label: '流入' }, { value: 'OUT', label: '流出' }] },
  { prop: 'amount', label: '金额', width: 110, align: 'right', type: 'money' },
  { prop: 'frequency', label: '频率', width: 90, type: 'enum', tagList: [{ value: 'MONTHLY', label: '每月' }, { value: 'QUARTERLY', label: '每季' }, { value: 'ONCE', label: '一次性' }] },
  { prop: 'dayOfMonth', label: '发生日', width: 80 },
  { prop: 'confidence', label: '把握度', width: 90, type: 'tag', tagList: CONFIDENCE }
]

const itemFields = [
  { prop: 'companyId', label: '所属公司', type: 'select', required: true, options: () => companyOptions() },
  { prop: 'name', label: '名称', required: true, placeholder: '如：每月房租 / 社保公积金' },
  { prop: 'direction', label: '方向', type: 'select', options: [{ value: 'OUT', label: '流出' }, { value: 'IN', label: '流入' }] },
  { prop: 'amount', label: '金额', type: 'money', required: true },
  { prop: 'frequency', label: '频率', type: 'select', options: [{ value: 'MONTHLY', label: '每月' }, { value: 'QUARTERLY', label: '每季' }, { value: 'ONCE', label: '一次性' }] },
  { prop: 'dayOfMonth', label: '每月几号', type: 'number' },
  { prop: 'startDate', label: '开始日期', type: 'date' },
  { prop: 'endDate', label: '结束日期', type: 'date' },
  { prop: 'confidence', label: '把握度', type: 'select', options: CONFIDENCE },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

async function load() {
  loading.value = true
  try {
    data.value = await api.forecast.get({ company_id: companyId.value })
    await nextTick()
    renderCurve()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function renderCurve() {
  if (!curveRef.value) return
  curveChart = curveChart || echarts.init(curveRef.value)
  const curve = data.value.curve || []
  curveChart.setOption({
    grid: { left: 66, right: 20, top: 20, bottom: 30 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + money(v) },
    xAxis: {
      type: 'category', data: curve.map((c) => c.date),
      axisLabel: { color: '#8f8a82', formatter: (v) => v.slice(5) }, axisLine: { lineStyle: { color: '#ddd9d2' } }
    },
    yAxis: {
      type: 'value', scale: true, splitLine: { lineStyle: { color: '#f2f0eb' } },
      axisLabel: { color: '#8f8a82', formatter: (v) => (Math.abs(v) >= 10000 ? v / 10000 + '万' : v) }
    },
    series: [{
      type: 'line', smooth: true, showSymbol: false, data: curve.map((c) => c.balance),
      lineStyle: { color: '#d2521e', width: 2 },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(210,82,30,0.18)' }, { offset: 1, color: 'rgba(210,82,30,0.02)' }] } },
      markLine: { silent: true, data: [{ yAxis: 0 }], lineStyle: { color: '#c2362b', type: 'dashed' } }
    }]
  })
}

onActivated(() => load())
onMounted(async () => { await loadMeta(); load() })
window.addEventListener('resize', () => curveChart?.resize())
</script>

<style scoped>
.chart-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--card-radius); padding: 14px; margin-bottom: 6px;
}
.chart { height: 280px; }
</style>
