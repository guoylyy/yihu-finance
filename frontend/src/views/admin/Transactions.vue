<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">资金流水</div>
        <div class="page-sub">系统的核心事实表：所有收付款最终都落到这里</div>
      </div>
      <div>
        <el-button @click="exportExcel"><el-icon><Download /></el-icon>导出 Excel</el-button>
        <el-button v-if="can('transaction.import')" @click="$router.push('/transactions/import')">
          <el-icon><Upload /></el-icon>导入银行流水
        </el-button>
        <el-button v-if="can('transaction.manage')" type="primary" @click="openForm()">
          <el-icon><Plus /></el-icon>新增流水
        </el-button>
      </div>
    </div>

    <FilterBar :active="activeFilters" @done="reload">
      <template v-if="isMobile" #bar>
        <el-input v-model="q.keyword" placeholder="搜索对方名称 / 备注 / 编号" clearable :prefix-icon="Search"
                  enterkeyhint="search" @keyup.enter="reload" @clear="reload" />
      </template>
      <el-select v-model="q.company_id" placeholder="全部公司" clearable style="width: 130px" @change="reload">
        <el-option v-for="c in companies" :key="c.id" :label="c.code" :value="c.id" />
      </el-select>
      <el-select v-model="q.account_id" placeholder="全部账户" clearable style="width: 150px" @change="reload">
        <el-option v-for="a in accountsOf(q.company_id)" :key="a.id" :label="`${a.company?.code || ''} ${a.name}`" :value="a.id" />
      </el-select>
      <el-select v-model="q.direction" placeholder="收支" clearable style="width: 95px" @change="reload">
        <el-option label="收入" value="IN" /><el-option label="支出" value="OUT" />
      </el-select>
      <el-select v-model="q.biz_type" placeholder="业务类型" clearable style="width: 140px" @change="reload">
        <el-option v-for="b in BIZ_TYPES" :key="b.value" :label="b.label" :value="b.value" />
      </el-select>
      <el-select v-model="q.status" placeholder="状态" clearable style="width: 110px" @change="reload">
        <el-option v-for="s in TXN_STATUS" :key="s.value" :label="s.label" :value="s.value" />
      </el-select>
      <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" style="width: 230px"
                      start-placeholder="开始日期" end-placeholder="结束日期" @change="onDateChange" />
      <el-input v-if="!isMobile" v-model="q.keyword" placeholder="搜索对方名称 / 备注 / 编号" clearable style="width: 200px"
                @keyup.enter="reload" @clear="reload" />
      <el-button v-if="!isMobile" type="primary" @click="reload">查询</el-button>
      <el-button text @click="resetFilter">重置</el-button>
    </FilterBar>

    <div class="stat-grid">
      <div class="stat-card is-success">
        <div class="label">筛选结果收入</div><div class="value">¥{{ money(stat.incomeTotal) }}</div>
      </div>
      <div class="stat-card is-danger">
        <div class="label">筛选结果支出</div><div class="value">¥{{ money(stat.expenseTotal) }}</div>
      </div>
      <div class="stat-card">
        <div class="label">净额</div>
        <div class="value" :class="stat.netTotal >= 0 ? 'money-in' : 'money-out'">{{ money(stat.netTotal) }}</div>
      </div>
      <div class="stat-card"><div class="label">笔数</div><div class="value">{{ total }}</div></div>
    </div>

    <div v-if="selection.length" class="batch-bar">
      已选 <b>{{ selection.length }}</b> 笔
      <el-select v-model="batch.bizType" placeholder="改业务类型" clearable size="small" style="width: 140px">
        <el-option v-for="b in BIZ_TYPES" :key="b.value" :label="b.label" :value="b.value" />
      </el-select>
      <el-select v-model="batch.categoryId" placeholder="改分类" clearable size="small" style="width: 140px">
        <el-option v-for="c in categories" :key="c.id" :label="`${c.kind === 'IN' ? '收' : '支'}｜${c.name}`" :value="c.id" />
      </el-select>
      <el-select v-model="batch.status" placeholder="改状态" clearable size="small" style="width: 120px">
        <el-option v-for="s in TXN_STATUS" :key="s.value" :label="s.label" :value="s.value" />
      </el-select>
      <el-button type="primary" size="small" @click="applyBatch">批量应用</el-button>
      <el-button size="small" text @click="tableRef?.clearSelection()">取消选择</el-button>
    </div>

    <div class="table-card">
      <ResponsiveTable ref="tableRef" :data="list" v-loading="loading" @selection-change="selection = $event" size="small">
        <el-table-column type="selection" width="40" />
        <!-- 1440 下表格可视宽约 778：选择 40 + 日期 90 + 公司/账户 120 + 对方 ≥130（弹性吃掉余量）+ 业务类型 100
             + 固定列 金额 130 / 操作 150 = 760，一屏放下、不出现被固定列压住的空缝。
             分类 / 状态 / 编号 只在手机卡片里作独立字段；桌面端状态并进「对方」单元格第二行。 -->
        <el-table-column prop="txnDate" label="日期" width="90">
          <template #default="{ row }">{{ date(row.txnDate) }}</template>
        </el-table-column>
        <el-table-column label="公司/账户" width="120" mobile="full">
          <template #default="{ row }">
            <div>{{ row.company?.code }}</div>
            <div class="muted ellipsis" style="font-size: 12px" :title="row.account?.name">{{ row.account?.name }}</div>
          </template>
        </el-table-column>
        <el-table-column label="对方名称 / 备注" min-width="130" mobile="title">
          <template #default="{ row }">
            <div class="ellipsis" :title="row.counterparty">{{ row.counterparty || '—' }}</div>
            <div v-if="!isMobile" class="cp-sub">
              <el-tag size="small" class="cp-status" :type="tagOf(TXN_STATUS, row.status)">{{ labelOf(TXN_STATUS, row.status) }}</el-tag>
              <span v-if="row.remark" class="muted ellipsis" :title="row.remark">{{ row.remark }}</span>
            </div>
            <div v-else class="muted" style="font-size: 12px">{{ row.remark }}</div>
          </template>
        </el-table-column>
        <el-table-column label="业务类型" width="100" mobile="badge">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ BIZ_LABEL[row.bizType] || row.bizType }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="isMobile" label="分类" width="110">
          <template #default="{ row }">{{ row.category?.name || '—' }}</template>
        </el-table-column>
        <el-table-column v-if="isMobile" label="状态" width="76" mobile="badge">
          <template #default="{ row }">
            <el-tag size="small" :type="tagOf(TXN_STATUS, row.status)">{{ labelOf(TXN_STATUS, row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="isMobile" prop="code" label="编号" width="140" />
        <el-table-column label="金额" width="130" align="right" fixed="right" mobile="amount">
          <template #default="{ row }">
            <span class="money" :class="row.direction === 'IN' ? 'money-in' : 'money-out'">
              {{ row.direction === 'IN' ? '+' : '−' }}{{ money(row.amount) }}
            </span>
            <div v-if="row.direction === 'IN' && Number(row.claimedAmount) > 0" class="muted claim-line">
              已认领 {{ money(row.claimedAmount) }}<template v-if="Number(row.remainingAmount) > 0">｜剩余 {{ money(row.remainingAmount) }}</template>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right" class-name="tx-ops">
          <template #default="{ row }">
            <PinButton type="transaction" :id="row.id" :label="`${row.code} ${row.direction === 'IN' ? '+' : '−'}${money(row.amount)}`" />
            <el-tooltip v-if="canClaim && row.claimable" content="认领到应收" placement="top" :show-after="400">
              <el-button link type="primary" aria-label="认领到应收" @click="reconcileRef?.open(row)">认领</el-button>
            </el-tooltip>
            <el-button v-if="can('transaction.manage')" link type="primary" @click="openForm(row)">编辑</el-button>
            <el-button v-if="can('transaction.manage')" link type="danger" @click="remove(row)">作废</el-button>
          </template>
        </el-table-column>
      </ResponsiveTable>
      <div class="pager">
        <ResponsivePager v-model:current-page="page" v-model:page-size="pageSize" :total="total"
                       :page-sizes="[20, 50, 100, 200]" layout="total, sizes, prev, pager, next" @change="load" />
      </div>
    </div>

    <ReconcileDialog ref="reconcileRef" @done="load" />

    <!-- 新增/编辑 -->
    <el-dialog v-model="formVisible" :title="form.id ? '编辑流水' : '新增流水'" width="580px">
      <el-form :model="form" label-width="92px">
        <el-form-item label="公司" required>
          <el-select v-model="form.companyId" style="width: 100%" @change="form.accountId = null">
            <el-option v-for="c in companies" :key="c.id" :label="c.code" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="账户" required>
          <el-select v-model="form.accountId" style="width: 100%">
            <el-option v-for="a in accountsOf(form.companyId)" :key="a.id" :label="`${a.name}（${a.currency}）`" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期" required>
          <el-date-picker v-model="form.txnDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="收支方向" required>
          <el-radio-group v-model="form.direction">
            <el-radio-button value="IN">收入</el-radio-button>
            <el-radio-button value="OUT">支出</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="金额" required>
          <el-input-number v-model="form.amount" :precision="2" :min="0" :step="100" style="width: 100%"
                           inputmode="decimal" :controls="!isMobile" />
        </el-form-item>
        <el-form-item label="对方名称">
          <el-input v-model="form.counterparty" placeholder="客户 / 供应商 / 收款人" />
        </el-form-item>
        <el-form-item label="业务类型" required>
          <el-select v-model="form.bizType" style="width: 100%">
            <el-option v-for="b in bizTypesFor(form.direction)" :key="b.value" :label="b.label" :value="b.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="form.categoryId" clearable style="width: 100%">
            <el-option v-for="c in categories.filter((x) => x.kind === form.direction)" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="form.status" style="width: 100%">
            <el-option v-for="s in TXN_STATUS" :key="s.value" :label="s.label" :value="s.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onActivated } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { download } from '@/api'
import { can } from '@/api/permissions'
import { companies, categories, accountsOf, loadMeta } from '@/composables/useMeta'
import { BIZ_TYPES, BIZ_LABEL, TXN_STATUS, labelOf, tagOf } from '@/constants'
import { money, date } from '@/utils/format'
import PinButton from '@/components/PinButton.vue'
import ReconcileDialog from '@/components/ReconcileDialog.vue'
import { useDraftReceiver } from '@/stores/assistant'
import ResponsiveTable from '@/components/mobile/ResponsiveTable'
import ResponsivePager from '@/components/mobile/ResponsivePager'
import FilterBar from '@/components/mobile/FilterBar.vue'
import { useViewport } from '@/composables/useViewport'

const { isMobile } = useViewport()

const route = useRoute()
const loading = ref(false)
const saving = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const stat = ref({})
const selection = ref([])
const activeFilters = computed(() => ['company_id', 'account_id', 'direction', 'biz_type', 'status'].filter((k) => q[k]).length + (dateRange.value?.length ? 1 : 0))
const tableRef = ref(null)
const dateRange = ref([])
const q = reactive({ company_id: '', account_id: '', direction: '', biz_type: '', status: '', keyword: '', date_from: '', date_to: '' })
const batch = reactive({ bizType: '', categoryId: '', status: '' })

const reconcileRef = ref(null)
// 认领会同时改流水关联与应收已收，两个权限都要有（与后端一致）
const canClaim = computed(() => can('transaction.manage') && can('receivable.manage'))
const formVisible = ref(false)
const form = ref({})

function bizTypesFor(direction) {
  return BIZ_TYPES.filter((b) => b.direction === 'BOTH' || b.direction === direction)
}

async function load() {
  loading.value = true
  try {
    const data = await api.transactions.list({ ...q, page: page.value, page_size: pageSize.value })
    list.value = data.list
    total.value = data.total
    stat.value = data
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function reload() { page.value = 1; load() }

function onDateChange(v) {
  q.date_from = v?.[0] || ''
  q.date_to = v?.[1] || ''
  reload()
}

function resetFilter() {
  Object.keys(q).forEach((k) => (q[k] = ''))
  dateRange.value = []
  reload()
}

function openForm(row) {
  form.value = row
    ? { ...row, companyId: String(row.companyId), accountId: String(row.accountId), categoryId: row.categoryId ? String(row.categoryId) : null, txnDate: date(row.txnDate), amount: Number(row.amount) }
    : { direction: 'OUT', bizType: 'OTHER_OUT', status: 'RECONCILED', txnDate: new Date().toISOString().slice(0, 10), amount: 0, companyId: q.company_id || companies.value[0]?.id }
  formVisible.value = true
}

// 录入助手「填入表单」：新增在默认值上预填；修改先取原流水再覆盖草稿字段
async function openPrefill(p) {
  try {
    openForm(p.mode === 'update' && p.id ? await api.transactions.get(p.id) : null)
    const v = { ...p.payload }
    if (v.amount != null) v.amount = Number(v.amount)
    form.value = { ...form.value, ...v }
  } catch (e) {
    ElMessage.error(e.message)
  }
}
useDraftReceiver('transaction', { onPrefill: openPrefill, onRefresh: load })

async function save() {
  saving.value = true
  try {
    if (form.value.id) await api.transactions.update(form.value.id, form.value)
    else await api.transactions.create(form.value)
    ElMessage.success('已保存')
    formVisible.value = false
    load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function remove(row) {
  await ElMessageBox.confirm(`确认作废流水 ${row.code}？作废后账户余额会自动重算。`, '确认', { type: 'warning' })
  try {
    await api.transactions.remove(row.id)
    ElMessage.success('已作废')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function applyBatch() {
  const payload = { ids: selection.value.map((r) => r.id) }
  if (batch.bizType) payload.bizType = batch.bizType
  if (batch.categoryId) payload.categoryId = batch.categoryId
  if (batch.status) payload.status = batch.status
  if (Object.keys(payload).length === 1) return ElMessage.warning('请选择要批量修改的字段')
  try {
    const r = await api.transactions.batch(payload)
    ElMessage.success(`已更新 ${r.count} 笔`)
    Object.keys(batch).forEach((k) => (batch[k] = ''))
    tableRef.value?.clearSelection()
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function exportExcel() {
  try {
    await download(api.transactions.exportUrl, q, 'transactions.xlsx')
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onActivated(() => load())
onMounted(async () => {
  await loadMeta()
  if (route.query.company_id) q.company_id = route.query.company_id
  if (route.query.status) q.status = route.query.status
  load()
})
</script>

<style scoped>
.claim-line { font-size: 12px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-sub { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; margin-top: 2px; }
.cp-sub .ellipsis { flex: 1; min-width: 0; }
.cp-status { flex: none; height: 18px; padding: 0 5px; font-size: 11px; }
/* 操作列压到 150px：@ / 认领 / 编辑 / 作废 四个按钮收紧间距 */
:deep(.tx-ops .cell) { padding-left: 6px; padding-right: 6px; white-space: nowrap; }
:deep(.tx-ops .cell .el-button.is-link) { padding-left: 0; padding-right: 0; }
:deep(.tx-ops .cell .el-button + .el-button) { margin-left: 6px; }
.batch-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: #fdf5f1; border: 1px solid #f0d9cd;
  border-radius: var(--card-radius); padding: 10px 14px; margin-bottom: 12px; font-size: 13px;
}
</style>
