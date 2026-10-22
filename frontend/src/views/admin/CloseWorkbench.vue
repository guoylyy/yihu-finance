<template>
  <div class="page" v-loading="loading">
    <div class="page-head">
      <div>
        <div class="page-title">月结工作台</div>
        <div class="page-sub">八项检查全过再锁月；锁定后该月流水与付款不可再改</div>
      </div>
      <div>
        <el-select v-model="companyId" style="width: 130px; margin-right: 8px" @change="load">
          <el-option v-for="c in companies" :key="c.id" :label="c.code" :value="c.id" />
        </el-select>
        <el-select v-model="period" style="width: 130px; margin-right: 8px" @change="load">
          <el-option v-for="p in periods" :key="p" :label="p" :value="p" />
        </el-select>
        <el-button @click="downloadSummary"><el-icon><Download /></el-icon>导出月结摘要</el-button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card is-success"><div class="label">本月收入</div><div class="value">¥{{ money(data.incomeTotal) }}</div></div>
      <div class="stat-card is-danger"><div class="label">本月支出</div><div class="value">¥{{ money(data.expenseTotal) }}</div></div>
      <div class="stat-card">
        <div class="label">净现金流</div>
        <div class="value" :class="data.netCashFlow >= 0 ? 'money-in' : 'money-out'">{{ money(data.netCashFlow) }}</div>
      </div>
      <div class="stat-card" :class="data.passCount === data.total ? 'is-success' : 'is-accent'">
        <div class="label">检查通过</div>
        <div class="value">{{ data.passCount || 0 }} / {{ data.total || 8 }}</div>
        <div class="foot">
          <el-tag v-if="data.record?.status === 'CLOSED'" size="small" type="success">已锁定</el-tag>
          <span v-else>未锁定</span>
        </div>
      </div>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :lg="13">
        <div class="section-title">月结检查清单</div>
        <div class="table-card" style="padding: 6px 16px 16px">
          <div v-for="item in data.items || []" :key="item.key" class="check-item">
            <el-icon :class="item.pass ? 'ok' : 'warn'" :size="18">
              <CircleCheckFilled v-if="item.pass" /><WarningFilled v-else />
            </el-icon>
            <div>
              <div class="t">{{ item.title }}</div>
              <div class="d">{{ item.detail }}</div>
            </div>
          </div>

          <div class="close-actions">
            <template v-if="data.record?.status === 'CLOSED'">
              <el-alert type="success" :closable="false"
                        :title="`${period} 已由 ${data.record.closedBy} 锁定于 ${datetime(data.record.closedAt)}`" />
              <el-button v-if="can('close.manage')" style="margin-top: 10px" @click="reopen">解锁该月</el-button>
            </template>
            <template v-else-if="can('close.manage')">
              <el-checkbox v-model="force">强制月结（存在未通过项时仍然锁定）</el-checkbox>
              <el-button type="primary" style="margin-left: 10px" @click="doClose">锁定 {{ period }}</el-button>
            </template>
          </div>
        </div>
      </el-col>

      <el-col :xs="24" :lg="11">
        <div class="section-title">月结摘要（Markdown，可直接贴回账本）</div>
        <div class="table-card">
          <el-input v-model="summaryMd" type="textarea" :rows="24" readonly class="md-box" />
          <el-button style="margin-top: 10px" @click="copyMd">复制到剪贴板</el-button>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted, onActivated } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { download } from '@/api'
import { can } from '@/api/permissions'
import { companies, loadMeta } from '@/composables/useMeta'
import { money, datetime, periodOptions, currentPeriod } from '@/utils/format'

const loading = ref(false)
const companyId = ref('')
const period = ref(currentPeriod())
const periods = periodOptions(18)
const data = ref({})
const summaryMd = ref('')
const force = ref(false)

async function load() {
  if (!companyId.value) return
  loading.value = true
  try {
    const params = { company_id: companyId.value, period: period.value }
    data.value = await api.close.checklist(params)
    summaryMd.value = (await api.close.summary(params)).markdown
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function doClose() {
  await ElMessageBox.confirm(`锁定后 ${period.value} 的流水、付款将不可再修改，确认月结？`, '确认月结', { type: 'warning' })
  try {
    await api.close.close({ companyId: companyId.value, period: period.value, force: force.value })
    ElMessage.success('已锁定')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function reopen() {
  const { value } = await ElMessageBox.prompt('请填写解锁原因（会记入操作日志）', '解锁月份', { inputPlaceholder: '如：补录 8 月漏记流水' })
  try {
    await api.close.reopen({ companyId: companyId.value, period: period.value, reason: value })
    ElMessage.success('已解锁')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function downloadSummary() {
  try {
    await download(api.close.summaryUrl, { company_id: companyId.value, period: period.value, download: 1 }, 'close.md')
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function copyMd() {
  await navigator.clipboard.writeText(summaryMd.value)
  ElMessage.success('已复制')
}

onActivated(() => load())
onMounted(async () => {
  await loadMeta()
  companyId.value = companies.value[0]?.id
  load()
})
</script>

<style scoped>
.check-item {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 12px 0; border-bottom: 1px solid var(--border);
}
.check-item:last-of-type { border-bottom: none; }
.check-item .ok { color: var(--success); }
.check-item .warn { color: var(--warning); }
.check-item .t { font-size: 14px; font-weight: 500; }
.check-item .d { font-size: 12px; color: var(--text-muted); }
.close-actions { padding-top: 14px; border-top: 1px solid var(--border); }
.md-box :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.7; }
</style>
