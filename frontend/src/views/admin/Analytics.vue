<template>
  <div class="page" v-loading="loading">
    <div class="page-head">
      <div>
        <div class="page-title">经营分析</div>
        <div class="page-sub">收支趋势、费用排名、人力成本与项目收支</div>
      </div>
      <div>
        <el-select v-model="companyId" placeholder="集团合计" clearable style="width: 140px" @change="load">
          <el-option v-for="c in companies" :key="c.id" :label="c.code" :value="c.id" />
        </el-select>
        <el-select v-model="months" style="width: 120px; margin-left: 8px" @change="load">
          <el-option :value="6" label="近 6 个月" /><el-option :value="12" label="近 12 个月" />
          <el-option :value="24" label="近 24 个月" />
        </el-select>
      </div>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :lg="16">
        <div class="section-title">收支趋势</div>
        <div class="chart-card"><div ref="trendRef" class="chart"></div></div>
      </el-col>
      <el-col :xs="24" :lg="8">
        <div class="section-title">各公司净现金流</div>
        <div class="chart-card"><div ref="companyRef" class="chart"></div></div>
      </el-col>
    </el-row>

    <el-row :gutter="14">
      <el-col :xs="24" :lg="12">
        <div class="section-title">人力成本（工资 / 劳务费 / 报销）</div>
        <div class="chart-card"><div ref="laborRef" class="chart"></div></div>
      </el-col>
      <el-col :xs="24" :lg="12">
        <div class="section-title">支出分类排名</div>
        <div class="chart-card">
          <el-table :data="categoryList" size="small" max-height="320">
            <el-table-column label="分类" min-width="140">
              <template #default="{ row }">{{ row.categoryName || BIZ_LABEL[row.bizType] || row.bizType }}</template>
            </el-table-column>
            <el-table-column prop="count" label="笔数" width="70" align="right" />
            <el-table-column label="金额" width="130" align="right">
              <template #default="{ row }"><span class="money">{{ money(row.total) }}</span></template>
            </el-table-column>
            <el-table-column label="占比" width="120">
              <template #default="{ row }">
                <el-progress :percentage="pct(row.total)" :stroke-width="8" :show-text="false" color="#d2521e" />
                <span class="muted" style="font-size: 12px">{{ pct(row.total) }}%</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="14">
      <el-col :xs="24" :lg="12">
        <div class="section-title">支出对手方 TOP 15</div>
        <div class="chart-card">
          <el-table :data="topList" size="small" max-height="360">
            <el-table-column type="index" width="50" />
            <el-table-column prop="name" label="收款方" min-width="180" show-overflow-tooltip />
            <el-table-column prop="count" label="笔数" width="70" align="right" />
            <el-table-column label="金额合计" width="130" align="right">
              <template #default="{ row }"><span class="money">{{ money(row.total) }}</span></template>
            </el-table-column>
          </el-table>
        </div>
      </el-col>
      <el-col :xs="24" :lg="12">
        <div class="section-title">项目收支</div>
        <div class="chart-card">
          <el-table :data="projectList" size="small" max-height="360">
            <el-table-column prop="name" label="项目" min-width="160" />
            <el-table-column label="收入" width="120" align="right">
              <template #default="{ row }"><span class="money money-in">{{ money(row.income) }}</span></template>
            </el-table-column>
            <el-table-column label="支出" width="120" align="right">
              <template #default="{ row }"><span class="money money-out">{{ money(row.expense) }}</span></template>
            </el-table-column>
            <el-table-column label="净额" width="120" align="right">
              <template #default="{ row }">
                <span class="money" :class="row.net >= 0 ? 'money-in' : 'money-out'">{{ money(row.net) }}</span>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!projectList.length" description="还没有给流水打项目标签" :image-size="60" />
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick, onActivated } from 'vue'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts'
import api from '@/api'
import { companies, loadMeta } from '@/composables/useMeta'
import { BIZ_LABEL } from '@/constants'
import { money } from '@/utils/format'

const loading = ref(false)
const companyId = ref('')
const months = ref(12)
const categoryList = ref([])
const topList = ref([])
const projectList = ref([])
const trendRef = ref(null)
const companyRef = ref(null)
const laborRef = ref(null)
const charts = {}

const categoryTotal = () => categoryList.value.reduce((s, r) => s + r.total, 0)
const pct = (v) => (categoryTotal() ? Math.round((v / categoryTotal()) * 100) : 0)

function chart(refEl, key, option) {
  if (!refEl.value) return
  charts[key] = charts[key] || echarts.init(refEl.value)
  charts[key].setOption(option, true)
}

async function load() {
  loading.value = true
  const p = { company_id: companyId.value, months: months.value }
  try {
    const [trend, byCompany, labor, byCategory, top, byProject] = await Promise.all([
      api.analytics.trend(p),
      api.analytics.byCompany({ months: months.value }),
      api.analytics.laborCost(p),
      api.analytics.byCategory({ company_id: companyId.value, direction: 'OUT' }),
      api.analytics.topCounterparty(p),
      api.analytics.byProject()
    ])
    categoryList.value = byCategory.list
    topList.value = top.list
    projectList.value = byProject.list
    await nextTick()

    const axis = { axisLine: { lineStyle: { color: '#ddd9d2' } }, axisLabel: { color: '#8f8a82' } }
    const yAxis = { type: 'value', splitLine: { lineStyle: { color: '#f2f0eb' } }, axisLabel: { color: '#8f8a82', formatter: (v) => (Math.abs(v) >= 10000 ? v / 10000 + '万' : v) } }

    chart(trendRef, 'trend', {
      grid: { left: 58, right: 16, top: 34, bottom: 28 },
      tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + money(v) },
      legend: { right: 0, top: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
      xAxis: { type: 'category', data: trend.list.map((i) => i.period.slice(2)), ...axis },
      yAxis,
      series: [
        { name: '收入', type: 'bar', data: trend.list.map((i) => i.income), itemStyle: { color: '#2e7d4f', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 18 },
        { name: '支出', type: 'bar', data: trend.list.map((i) => i.expense), itemStyle: { color: '#c2362b', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 18 },
        { name: '净现金流', type: 'line', smooth: true, data: trend.list.map((i) => i.net), itemStyle: { color: '#d2521e' } }
      ]
    })

    chart(companyRef, 'company', {
      grid: { left: 70, right: 20, top: 20, bottom: 24 },
      tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + money(v) },
      xAxis: { type: 'value', ...axis, splitLine: { lineStyle: { color: '#f2f0eb' } }, axisLabel: { color: '#8f8a82', formatter: (v) => (Math.abs(v) >= 10000 ? v / 10000 + '万' : v) } },
      yAxis: { type: 'category', data: byCompany.list.map((i) => i.code), ...axis },
      series: [{
        type: 'bar', data: byCompany.list.map((i) => i.net), barMaxWidth: 20,
        itemStyle: { color: (p) => (p.value >= 0 ? '#2e7d4f' : '#c2362b'), borderRadius: 3 }
      }]
    })

    chart(laborRef, 'labor', {
      grid: { left: 58, right: 16, top: 34, bottom: 28 },
      tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + money(v) },
      legend: { right: 0, top: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
      xAxis: { type: 'category', data: labor.list.map((i) => i.period.slice(2)), ...axis },
      yAxis,
      series: ['salary', 'labor', 'reimburse'].map((k, idx) => ({
        name: ['工资', '劳务费', '报销'][idx],
        type: 'bar', stack: 'total', barMaxWidth: 22,
        data: labor.list.map((i) => i[k]),
        itemStyle: { color: ['#1c1917', '#8f8a82', '#d2521e'][idx] }
      }))
    })
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

onMounted(async () => { await loadMeta(); load() })
onActivated(() => { load(); Object.values(charts).forEach((c) => c.resize()) })
window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()))
</script>

<style scoped>
.chart-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--card-radius); padding: 14px; margin-bottom: 6px;
}
.chart { height: 300px; }
</style>
