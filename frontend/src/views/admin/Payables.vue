<template>
  <CrudTable
    ref="tableRef"
    :api="api.payables"
    title="应付台账"
    subtitle="供应商欠款与各类待付事项，实际付款走「付款管理」审批流"
    entity-name="应付款"
    add-text="登记应付款"
    :columns="columns"
    :form-fields="formFields"
    :filters="filters"
    @loaded="(d) => (rows = d.list)"
    :default-form="{ status: 'PENDING', bizType: 'PURCHASE', amount: 0 }"
    :can-manage="can('payable.manage')"
    :action-width="200"
    search-placeholder="搜索编号 / 收款方 / 说明"
  >
    <template #stats>
      <div class="stat-grid">
        <div class="stat-card is-accent">
          <div class="label">未付合计</div>
          <div class="value">¥{{ money(unpaidTotal) }}</div>
          <div class="foot">当前列表内待付金额</div>
        </div>
        <div class="stat-card is-danger">
          <div class="label">已逾期</div>
          <div class="value">¥{{ money(overdue.total) }}</div>
          <div class="foot">{{ overdue.count || 0 }} 笔已过到期日</div>
        </div>
      </div>
    </template>

    <template #col-amount="{ row }">
      <div class="money">{{ money(row.amount) }}</div>
      <div class="muted" style="font-size: 12px">
        已付 {{ money(row.paidAmount) }}
        <template v-if="remain(row) > 0"> · 待付 <b class="money-out">{{ money(remain(row)) }}</b></template>
      </div>
    </template>

    <template #row-actions="{ row }">
      <el-button v-if="can('payable.manage') && row.status !== 'PAID' && row.status !== 'CANCELLED'"
                 link type="primary" @click="openPay(row)">快速付款</el-button>
      <el-button link type="primary" @click="showPayments(row)">付款记录</el-button>
    </template>
  </CrudTable>

  <!-- 快速付款 -->
  <el-dialog v-model="payVisible" title="快速付款" width="500px">
    <el-alert v-if="current" type="info" :closable="false" style="margin-bottom: 16px"
              :title="`${current.payeeName}｜${current.title || current.code}`">
      <div style="font-size: 13px">
        应付 <b class="money">¥{{ money(current.amount) }}</b>
        ｜已付 <b class="money">¥{{ money(current.paidAmount) }}</b>
        ｜待付 <b class="money money-out">¥{{ money(remain(current)) }}</b>
      </div>
    </el-alert>

    <el-form :model="payForm" label-width="100px">
      <el-form-item label="处理方式">
        <el-radio-group v-model="payForm.mode">
          <el-radio-button value="PAY" :disabled="!canDirectPay">直接记已付款</el-radio-button>
          <el-radio-button value="SUBMIT">生成付款单送审</el-radio-button>
        </el-radio-group>
        <div class="muted" style="font-size: 12px; line-height: 1.6">
          <template v-if="payForm.mode === 'PAY'">
            钱已经付出去了：立刻生成支出流水、扣减账户余额、回写应付状态。
          </template>
          <template v-else>
            还没付：生成一张待审批的付款单，后续在「付款管理」审批 → 标记付款。
          </template>
          <div v-if="!canDirectPay" class="money-out">你没有付款审批权限，只能送审。</div>
        </div>
      </el-form-item>

      <el-form-item label="付款账户" :required="payForm.mode === 'PAY'">
        <el-select v-model="payForm.accountId" style="width: 100%" placeholder="钱从哪个账户出">
          <el-option v-for="a in accountsOf(current?.companyId)" :key="a.id"
                     :label="`${a.name}（${a.currency}｜余额 ${money(a.balance)}）`" :value="a.id" />
        </el-select>
      </el-form-item>

      <el-form-item label="付款金额">
        <el-input-number v-model="payForm.amount" :precision="2" :min="0" :max="remain(current)"
                         :step="100" style="width: 100%" inputmode="decimal" :controls="!isMobile" />
        <div class="muted" style="font-size: 12px">默认全额付清，改小即为部分付款</div>
      </el-form-item>

      <el-form-item :label="payForm.mode === 'PAY' ? '付款日期' : '计划付款日'">
        <el-date-picker v-model="payForm.paidDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>

      <el-form-item label="备注"><el-input v-model="payForm.remark" placeholder="选填" /></el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="payVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submitPay">
        {{ payForm.mode === 'PAY' ? '确认已付款' : '生成付款单' }}
      </el-button>
    </template>
  </el-dialog>

  <!-- 付款记录 -->
  <el-dialog v-model="listVisible" title="付款记录" width="640px">
    <ResponsiveTable :data="payList" size="small">
      <el-table-column prop="code" label="付款编号" width="150" />
      <el-table-column label="金额" width="120" align="right" mobile="amount">
        <template #default="{ row }"><span class="money">{{ money(row.amount) }}</span></template>
      </el-table-column>
      <el-table-column label="付款账户" width="120">
        <template #default="{ row }">{{ row.account?.name || '—' }}</template>
      </el-table-column>
      <el-table-column label="付款日" width="110">
        <template #default="{ row }">{{ date(row.paidDate) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100" mobile="badge">
        <template #default="{ row }">
          <el-tag size="small" :type="tagOf(PAYMENT_STATUS, row.status)">{{ labelOf(PAYMENT_STATUS, row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="关联流水" min-width="130">
        <template #default="{ row }">{{ row.transaction?.code || '—' }}</template>
      </el-table-column>
    </ResponsiveTable>
    <el-empty v-if="!payList.length && !isMobile" description="还没有付款记录" :image-size="60" />
  </el-dialog>
</template>

<script setup>
import { onMounted, ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import CrudTable from '@/components/CrudTable.vue'
import api from '@/api'
import { can } from '@/api/permissions'
import { companies, accountsOf, loadMeta } from '@/composables/useMeta'
import { PAYABLE_STATUS, PAYMENT_STATUS, BIZ_TYPES, labelOf, tagOf } from '@/constants'
import { money, date } from '@/utils/format'
import { useViewport } from '@/composables/useViewport'
import ResponsiveTable from '@/components/mobile/ResponsiveTable'

const { isMobile } = useViewport()

const suppliers = ref([])
const tableRef = ref(null)
const payVisible = ref(false)
const listVisible = ref(false)
const saving = ref(false)
const current = ref(null)
const payForm = ref({})
const payList = ref([])
const overdue = ref({})
const rows = ref([])

const canDirectPay = computed(() => can('payment.approve') && can('payment.pay'))
const remain = (row) => (row ? Math.round((Number(row.amount) - Number(row.paidAmount)) * 100) / 100 : 0)
const unpaidTotal = computed(() =>
  rows.value.filter((r) => !['PAID', 'CANCELLED'].includes(r.status)).reduce((s, r) => s + remain(r), 0)
)

function openPay(row) {
  current.value = row
  payForm.value = {
    mode: canDirectPay.value ? 'PAY' : 'SUBMIT',
    accountId: accountsOf(row.companyId)[0]?.id,
    amount: remain(row),
    paidDate: new Date().toISOString().slice(0, 10),
    remark: ''
  }
  payVisible.value = true
}

async function submitPay() {
  if (payForm.value.mode === 'PAY' && !payForm.value.accountId) {
    return ElMessage.warning('请选择付款账户')
  }
  saving.value = true
  try {
    const r = await api.payables.quickPay(current.value.id, payForm.value)
    ElMessage.success(r.paid
      ? `已付款，生成流水 ${r.transaction.code}，账户余额已更新`
      : `已生成付款单 ${r.payment.code}，去「付款管理」审批`)
    payVisible.value = false
    tableRef.value?.reload()
    await loadMeta(true)   // 账户余额变了
    loadOverdue()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function showPayments(row) {
  current.value = row
  try {
    payList.value = (await api.payables.payments(row.id)).list
    listVisible.value = true
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function loadOverdue() {
  try {
    const d = await api.payables.overdue()
    overdue.value = { total: d.total, count: d.count }
  } catch { /* 非关键 */ }
}
const companyOptions = () => companies.value.map((c) => ({ value: String(c.id), label: c.code }))

const columns = [
  { prop: 'code', label: '编号', width: 130 },
  { prop: 'company.code', label: '公司', width: 100 },
  { prop: 'payeeName', label: '收款方', width: 160 },
  { prop: 'title', label: '款项说明', minWidth: 180, ellipsis: true },
  { prop: 'amount', label: '应付 / 已付', width: 130, align: 'right' },
  { prop: 'dueDate', label: '到期日', width: 110, type: 'date' },
  { prop: 'status', label: '状态', width: 100, type: 'tag', tagList: PAYABLE_STATUS }
]

const filters = [
  { prop: 'company_id', label: '全部公司', type: 'select', width: 120, options: () => companyOptions() },
  { prop: 'status', label: '状态', type: 'select', width: 120, options: PAYABLE_STATUS },
  { prop: 'daterange', type: 'daterange' }
]

const formFields = [
  { prop: 'companyId', label: '付款公司', type: 'select', required: true, options: () => companyOptions() },
  { prop: 'supplierId', label: '供应商', type: 'select', options: () => suppliers.value.map((s) => ({ value: String(s.id), label: s.name })) },
  { prop: 'payeeName', label: '收款方', required: true },
  { prop: 'title', label: '款项说明' },
  { prop: 'bizType', label: '业务类型', type: 'select', options: BIZ_TYPES.filter((b) => b.direction !== 'IN') },
  { prop: 'amount', label: '应付金额', type: 'money', required: true },
  { prop: 'dueDate', label: '到期日', type: 'date' },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

onMounted(async () => {
  await loadMeta()
  suppliers.value = (await api.suppliers.list({ page_size: 200 })).list
  loadOverdue()
})
</script>
