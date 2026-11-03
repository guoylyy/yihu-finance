<!--
  应收详情抽屉（v1.4）：头部金额 + 关联发票（红字按负数冲减）+ 收款构成（哪几笔流水各认领多少，可撤销）
  用法：ref.open(应收 id)；emit('claim', 应收) 让父页面打开认领弹窗；emit('changed') 数据有变动（撤销 / 摘发票）
-->
<template>
  <el-drawer v-model="visible" :size="isMobile ? '100%' : '680px'" :title="row ? `应收详情｜${row.code}` : '应收详情'"
             append-to-body destroy-on-close class="ar-drawer">
    <div v-loading="loading" class="ard">
      <template v-if="row">
        <div class="ard-head">
          <div class="ard-title">{{ row.title }}
            <el-tag size="small" :type="tagOf(RECEIVABLE_STATUS, row.status)">{{ labelOf(RECEIVABLE_STATUS, row.status) }}</el-tag>
          </div>
          <div class="muted ard-meta">{{ row.company?.code }}｜客户：{{ row.customer?.name || '未指定' }}<template v-if="row.contractNo">｜合同 {{ row.contractNo }}</template></div>
          <div class="ard-nums">
            <div><div class="muted">应收</div><b class="money">¥{{ money(row.amount) }}</b></div>
            <div><div class="muted">已收</div><b class="money money-in">¥{{ money(row.receivedAmount) }}</b></div>
            <div><div class="muted">剩余未收</div><b class="money" :class="{ 'money-out': remaining > 0 }">¥{{ money(remaining) }}</b></div>
          </div>
          <el-button v-if="canClaim" type="primary" class="ard-btn" @click="emit('claim', row)">认领流水</el-button>
        </div>

        <!-- 关联发票 -->
        <div class="ard-sec">
          <div class="ard-sec-title">关联发票 <span class="muted">（{{ invoices.length }} 张）</span></div>
          <ResponsiveTable :data="invoices" size="small" empty-text="还没有挂发票：在「编辑」里选，或到发票台账挂到这笔应收">
            <el-table-column label="发票号" min-width="150" mobile="title">
              <template #default="{ row: inv }">{{ inv.invoiceNo }}</template>
            </el-table-column>
            <el-table-column label="类型" width="90" mobile="badge">
              <template #default="{ row: inv }">
                <el-tag size="small" :type="inv.type === 'RED' ? 'danger' : 'primary'" effect="plain">{{ inv.type === 'RED' ? '红字' : '销项' }}</el-tag>
                <el-tag v-if="inv.status === 'VOID'" size="small" type="info" effect="plain">已作废，不计入</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="价税合计" width="130" align="right" mobile="amount">
              <template #default="{ row: inv }">
                <span class="money" :class="{ 'money-out': inv.type === 'RED' }">{{ money(signedTotal(inv)) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="开票日期" width="104">
              <template #default="{ row: inv }">{{ date(inv.issueDate) }}</template>
            </el-table-column>
            <el-table-column v-if="can('invoice.manage')" label="操作" width="70">
              <template #default="{ row: inv }">
                <el-button link type="danger" @click="unlinkInvoice(inv)">摘除</el-button>
              </template>
            </el-table-column>
          </ResponsiveTable>
          <div class="ard-total" v-if="summary">
            已开票合计 <b class="money">¥{{ money(summary.invoicedTotal) }}</b>
            <template v-if="Number(summary.redTotal) > 0">（销项 ¥{{ money(summary.blueTotal) }} − 红字 ¥{{ money(summary.redTotal) }}）</template>
            ｜未开票差额 <b class="money" :class="{ 'money-out': Number(summary.uninvoicedAmount) !== 0 }">¥{{ money(summary.uninvoicedAmount) }}</b>
          </div>
        </div>

        <!-- 收款构成 -->
        <div class="ard-sec">
          <div class="ard-sec-title">收款构成 <span class="muted">（{{ receipts.length }} 笔流水）</span></div>
          <ResponsiveTable :data="receipts" size="small" empty-text="还没有收款">
            <el-table-column label="流水" min-width="140" mobile="title">
              <template #default="{ row: rc }">
                {{ rc.transaction?.code }}
                <el-tag v-if="rc.source !== 'LINK'" size="small" type="info" effect="plain">{{ SOURCE[rc.source] || rc.source }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="日期" width="100" mobile="badge">
              <template #default="{ row: rc }">{{ date(rc.receiptDate) }}</template>
            </el-table-column>
            <el-table-column label="账户" min-width="110">
              <template #default="{ row: rc }">{{ rc.transaction?.account?.name || '—' }}</template>
            </el-table-column>
            <el-table-column label="认领金额" width="120" align="right" mobile="amount">
              <template #default="{ row: rc }"><span class="money money-in">{{ money(rc.amount) }}</span></template>
            </el-table-column>
            <el-table-column label="流水金额 / 剩余" width="140" align="right">
              <template #default="{ row: rc }">
                <span class="money">{{ money(rc.transaction?.amount) }}</span>
                <div v-if="txnLeft[rc.transactionId] > 0" class="muted ard-small">剩余 {{ money(txnLeft[rc.transactionId]) }} 未认领</div>
              </template>
            </el-table-column>
            <el-table-column v-if="canRevoke" label="操作" width="70">
              <template #default="{ row: rc }">
                <el-button link type="danger" @click="revoke(rc)">撤销</el-button>
              </template>
            </el-table-column>
          </ResponsiveTable>
          <div class="ard-total">
            认领合计 <b class="money">¥{{ money(rcTotal) }}</b>
            <template v-if="remaining > 0">｜应收还剩 <b class="money money-out">¥{{ money(remaining) }}</b> 未收</template>
            <span v-if="rcData && rcData.consistent === false" class="money-out">｜与已收金额 ¥{{ money(rcData.receivedAmount) }} 对不上，请检查</span>
          </div>
          <div v-if="prepayments.length" class="ard-total">
            超收已转预收款：<span v-for="p in prepayments" :key="p.id" class="ard-pre">{{ p.code }} ¥{{ money(p.amount) }}</span>
          </div>
        </div>
      </template>
    </div>
  </el-drawer>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api'
import { can } from '@/api/permissions'
import { RECEIVABLE_STATUS, labelOf, tagOf } from '@/constants'
import { money, date } from '@/utils/format'
import { toCents, fromCents } from '@/utils/amount'
import { useViewport } from '@/composables/useViewport'
import ResponsiveTable from '@/components/mobile/ResponsiveTable'

const props = defineProps({ allowClaim: { type: Boolean, default: true } })
const emit = defineEmits(['claim', 'changed'])
const { isMobile } = useViewport()
const SOURCE = { AUTO: '登记回款时新建', BACKFILL: '历史回填' }

const visible = ref(false)
const loading = ref(false)
const row = ref(null)
const rcData = ref(null)
const txnLeft = ref({})

const invoices = computed(() => row.value?.invoices || [])
const summary = computed(() => row.value?.invoiceSummary)
const receipts = computed(() => rcData.value?.list || [])
const prepayments = computed(() => rcData.value?.prepayments || [])
const rcTotal = computed(() => rcData.value?.total || '0.00')
const remaining = computed(() => (row.value ? Number(fromCents(toCents(row.value.amount) - toCents(row.value.receivedAmount))) : 0))
const canClaim = computed(() => props.allowClaim && can('receivable.manage') && ['PENDING', 'PARTIAL'].includes(row.value?.status))
const canRevoke = computed(() => can('receivable.manage') && can('transaction.manage'))
// 红字发票冲减已开票：一律按负数展示（导入时可能已是负数，手工录入可能是正数）
const signedTotal = (inv) => (inv.type === 'RED' ? -Math.abs(Number(inv.totalAmount)) : Number(inv.totalAmount))

async function open(id) {
  visible.value = true
  await load(id)
}

async function load(id = row.value?.id) {
  loading.value = true
  try {
    const [r, rc] = await Promise.all([api.receivables.get(id), api.receivables.receipts(id)])
    row.value = r
    rcData.value = rc
    // 每笔流水还剩多少没认领（被别的应收 / 预收占用的也扣掉）
    const ids = [...new Set(rc.list.map((x) => x.transactionId))]
    const left = {}
    await Promise.all(ids.map(async (tid) => {
      try { left[tid] = Number((await api.transactions.receipts(tid)).remainingAmount) } catch { /* 无流水查看权限就不显示 */ }
    }))
    txnLeft.value = left
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function unlinkInvoice(inv) {
  try {
    await ElMessageBox.confirm(`把发票 ${inv.invoiceNo} 从 ${row.value.code} 摘除？发票本身不受影响。`, '摘除发票', { type: 'warning' })
  } catch { return }
  try {
    await api.invoices.linkReceivable(inv.id, null)
    ElMessage.success(`已摘除发票 ${inv.invoiceNo}`)
    await load()
    emit('changed')
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function revoke(rc) {
  const auto = rc.source !== 'LINK'
  const msg = `撤销 ${rc.transaction?.code} 认领到 ${row.value.code} 的 ¥${money(rc.amount)}？` +
    (auto ? '这笔流水是登记回款时系统新建的，没有其他认领时会一并作废（账户余额随之减少）。' : '流水保留，可再认领到别的应收。')
  try {
    await ElMessageBox.confirm(msg, '撤销认领', { type: 'warning', confirmButtonText: '确认撤销' })
  } catch { return }
  try {
    const r = await api.receipts.revoke(rc.id)
    ElMessage.success(`已撤销认领${r.voidedTransaction ? `，流水 ${rc.transaction?.code} 已作废` : ''}${r.revokedPrepayments?.length ? `，预收款 ${r.revokedPrepayments.map((p) => p.code).join('、')} 一并撤销` : ''}`)
    await load()
    emit('changed')
  } catch (e) {
    ElMessage.error(e.message)
  }
}

// 只在抽屉开着、已加载过某笔应收时才刷新（父页面认领成功后会无条件调）
defineExpose({ open, reload: () => (visible.value && row.value ? load() : undefined) })
</script>

<style scoped>
.ard-head { border-bottom: 1px solid var(--border, #eee); padding-bottom: 12px; margin-bottom: 8px; }
.ard-title { font-size: 16px; font-weight: 600; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; word-break: break-all; }
.ard-meta { font-size: 13px; margin-top: 4px; }
.ard-nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 12px 0; font-size: 13px; }
.ard-nums b { font-size: 16px; }
.ard-btn { min-height: 36px; }
.ard-sec { margin-top: 16px; }
.ard-sec-title { font-weight: 600; margin-bottom: 8px; }
.ard-total { font-size: 13px; margin-top: 8px; line-height: 1.8; }
.ard-small { font-size: 12px; }
.ard-pre { margin-right: 10px; }
@media (max-width: 768px) {
  .ard-btn { width: 100%; min-height: 44px; }
  .ard-nums b { font-size: 15px; }
}
</style>
