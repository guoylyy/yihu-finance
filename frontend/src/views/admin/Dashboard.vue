<template>
  <div class="page" v-loading="loading">
    <div class="page-head">
      <div>
        <div class="page-title">管理驾驶舱</div>
        <div class="page-sub">集团资金全景 · 数据截至 {{ now }}</div>
      </div>
      <el-select v-model="period" style="width: 140px" @change="load">
        <el-option v-for="p in periods" :key="p" :label="p" :value="p" />
      </el-select>
    </div>

    <div class="stat-grid">
      <div class="stat-card is-accent">
        <div class="label">集团总余额（CNY）</div>
        <div class="value">¥{{ money(data.groupTotal?.CNY) }}</div>
        <div class="foot" v-if="data.groupTotal?.USD">另有 ${{ money(data.groupTotal.USD) }} 美元账户</div>
        <div class="foot" v-else>共 {{ data.companies?.length || 0 }} 家公司</div>
      </div>
      <div class="stat-card is-success">
        <div class="label">本月收入</div>
        <div class="value">¥{{ money(data.income) }}</div>
        <div class="foot">{{ data.incomeCount || 0 }} 笔</div>
      </div>
      <div class="stat-card is-danger">
        <div class="label">本月支出</div>
        <div class="value">¥{{ money(data.expense) }}</div>
        <div class="foot">{{ data.expenseCount || 0 }} 笔</div>
      </div>
      <div class="stat-card">
        <div class="label">本月净现金流</div>
        <div class="value" :class="data.netCashFlow >= 0 ? 'money-in' : 'money-out'">
          {{ data.netCashFlow >= 0 ? '+' : '' }}{{ money(data.netCashFlow) }}
        </div>
        <div class="foot">收入 − 支出</div>
      </div>
      <div class="stat-card">
        <div class="label">待收款</div>
        <div class="value">¥{{ money(data.pendingReceivable) }}</div>
        <div class="foot">
          {{ data.pendingReceivableCount || 0 }} 笔
          <span v-if="data.overdueReceivableCount" class="money-out">· 逾期 {{ data.overdueReceivableCount }}</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="label">待付款</div>
        <div class="value">¥{{ money(data.pendingPayment) }}</div>
        <div class="foot">
          {{ data.pendingPaymentCount || 0 }} 笔
          <span v-if="data.overduePaymentCount" class="money-out">· 逾期 {{ data.overduePaymentCount }}</span>
        </div>
      </div>
    </div>

    <div class="section-title">各公司余额</div>
    <div class="company-grid">
      <div v-for="c in data.companies" :key="c.id" class="company-card" @click="goCompany(c)">
        <div class="c-name">{{ c.code }}</div>
        <div class="c-balance money">¥{{ money(c.currencies?.CNY) }}</div>
        <div class="c-extra" v-if="c.currencies?.USD">$ {{ money(c.currencies.USD) }}</div>
        <div class="c-extra muted" v-else>{{ c.name }}</div>
      </div>
    </div>

    <el-row :gutter="14" style="margin-top: 6px">
      <el-col :xs="24" :lg="14">
        <div class="section-title">近 12 个月收支趋势</div>
        <div class="chart-card"><div ref="trendRef" class="chart"></div></div>
      </el-col>
      <el-col :xs="24" :lg="10">
        <div class="section-title">未来资金预测</div>
        <div class="chart-card">
          <ResponsiveTable :data="data.forecast?.windows || []" size="small">
            <el-table-column prop="days" label="窗口" width="80" mobile="title">
              <template #default="{ row }">未来 {{ row.days }} 天</template>
            </el-table-column>
            <el-table-column label="预计流入" align="right">
              <template #default="{ row }"><span class="money money-in">{{ money(row.inflow) }}</span></template>
            </el-table-column>
            <el-table-column label="预计流出" align="right">
              <template #default="{ row }"><span class="money money-out">{{ money(row.outflow) }}</span></template>
            </el-table-column>
            <el-table-column label="预计期末" align="right" mobile="amount">
              <template #default="{ row }">
                <span class="money" :class="row.endingBalance < 0 ? 'money-out' : ''">{{ money(row.endingBalance) }}</span>
              </template>
            </el-table-column>
          </ResponsiveTable>
          <div class="forecast-note">
            当前可用余额 <b class="money">¥{{ money(data.forecast?.available) }}</b>，
            预测口径 = 可用余额 + 预计收款 − 已审批待付款 − 固定周期支出。
            <el-button link type="primary" @click="$router.push('/forecast')">查看明细</el-button>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useCharts } from '@/composables/useCharts'
import api from '@/api'
import { money, currentPeriod, periodOptions } from '@/utils/format'
import ResponsiveTable from '@/components/mobile/ResponsiveTable'

const router = useRouter()
const loading = ref(false)
const data = ref({})
const period = ref(currentPeriod())
const periods = periodOptions(18)
const now = new Date().toLocaleDateString('zh-CN')
const trendRef = ref(null)
const { render: renderChart, resizeAll } = useCharts()

async function load() {
  loading.value = true
  try {
    data.value = await api.dashboard.get({ period: period.value })
    await nextTick()
    renderTrend()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function renderTrend() {
  if (!trendRef.value) return
  const list = data.value.trend || []
  renderChart(trendRef.value, {
    grid: { left: 58, right: 16, top: 30, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + money(v) },
    legend: { data: ['收入', '支出', '净现金流'], right: 0, top: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    xAxis: { type: 'category', data: list.map((i) => i.period.slice(2)), axisLine: { lineStyle: { color: '#ddd9d2' } }, axisLabel: { color: '#8f8a82' } },
    yAxis: {
      type: 'value', splitLine: { lineStyle: { color: '#f2f0eb' } },
      axisLabel: { color: '#8f8a82', formatter: (v) => (Math.abs(v) >= 10000 ? v / 10000 + '万' : v) }
    },
    series: [
      { name: '收入', type: 'bar', data: list.map((i) => i.income), itemStyle: { color: '#2e7d4f', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 16 },
      { name: '支出', type: 'bar', data: list.map((i) => i.expense), itemStyle: { color: '#c2362b', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 16 },
      { name: '净现金流', type: 'line', smooth: true, data: list.map((i) => i.net), itemStyle: { color: '#d2521e' }, lineStyle: { width: 2 } }
    ]
  })
}

function goCompany(c) {
  router.push({ path: '/transactions', query: { company_id: c.id } })
}

onMounted(load)
onActivated(() => { load(); resizeAll() })
</script>

<style scoped>
.company-grid {
  display: grid; gap: 12px; margin-bottom: 6px;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}
.company-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--card-radius); padding: 14px 16px; cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
}
.company-card:hover { border-color: var(--accent); transform: translateY(-1px); }
@media (max-width: 768px) {
  .company-grid { grid-template-columns: 1fr; gap: 8px; }
  .company-card { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; padding: 12px 14px; }
  .c-balance { font-size: 18px; margin-top: 0; }
  .c-extra { flex-basis: 100%; font-size: 13px; }
  .forecast-note { font-size: 13px; }
}
.c-name { font-size: 14px; font-weight: 600; }
.c-balance { font-size: 22px; font-weight: 600; margin-top: 4px; }
.c-extra { font-size: 12px; color: var(--text-muted); }
.chart-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--card-radius); padding: 14px;
}
.chart { height: 300px; }
.forecast-note { font-size: 12px; color: var(--text-muted); margin-top: 10px; line-height: 1.7; }
@media (max-width: 768px) {
  .chart { height: 240px; }
}
</style>
