<!--
  流水「认领到应收」弹窗（v1.4）：一笔收入流水拆给一笔或多笔应收
  每行「应收 + 金额」，实时校验：金额 > 0、最多两位小数、同一应收不重复、合计 ≤ 流水剩余可认领
  某行金额超过该应收剩余的部分，后端会自动转预收款（这里只提示，不拦）
  提交 POST /transactions/:id/reconcile { items }，成功后在弹窗里显示分配结果与流水剩余
  用法：ref.open(流水行)；成功后 emit('done', 响应)
-->
<template>
  <el-dialog v-model="visible" :title="txn ? `认领到应收｜${txn.code}` : '认领到应收'" width="min(760px, 96vw)"
             append-to-body destroy-on-close class="reconcile-dialog">
    <div v-loading="loading">
      <template v-if="txn">
        <el-alert type="info" :closable="false" class="rd-alert">
          <template #title>
            <div>{{ txn.counterparty || '（无对方名称）' }}｜{{ date(txn.txnDate) }}｜{{ txn.account?.name }}</div>
            <div>流水 <b>+¥{{ money(txn.amount) }}</b>｜已认领 ¥{{ money(info.claimedAmount) }}｜<b>剩余可认领 ¥{{ money(info.remainingAmount) }}</b></div>
          </template>
        </el-alert>
        <div v-if="info.list?.length" class="rd-exist muted">已认领：
          <span v-for="r in info.list" :key="r.id" class="rd-exist-item">{{ r.receivable?.code }} ¥{{ money(r.amount) }}</span>
          <span v-for="p in info.prepayments || []" :key="p.id" class="rd-exist-item">预收 {{ p.code }} ¥{{ money(p.amount) }}</span>
        </div>

        <!-- 分配 -->
        <template v-if="!result">
          <div v-for="(it, i) in items" :key="it.key" class="rd-row">
            <div class="rd-idx">{{ i + 1 }}</div>
            <el-select v-model="it.receivableId" filterable :filter-method="(kw) => (filterKw = kw)" placeholder="选应收：搜编号 / 客户 / 金额"
                       class="rd-ar" @visible-change="(v) => v && (filterKw = '')" @change="onPickAr(it)">
              <el-option v-for="r in arOptions(it)" :key="r.id" :value="r.id" :label="`${r.code}｜${r.customer?.name || r.title}｜剩余 ¥${money(r.remaining)}`"
                         :disabled="items.some((x) => x !== it && x.receivableId === r.id)">
                <div class="rd-opt">
                  <span>{{ r.code }}</span>
                  <span class="rd-opt-name">{{ r.customer?.name || '—' }}｜{{ r.title }}</span>
                  <span class="money">剩余 ¥{{ money(r.remaining) }}</span>
                </div>
              </el-option>
            </el-select>
            <el-input v-model="it.amount" inputmode="decimal" placeholder="认领金额" class="rd-amt">
              <template #prefix>¥</template>
            </el-input>
            <el-button class="rd-del" :disabled="items.length === 1" @click="items.splice(i, 1)" aria-label="删除这一行">
              <el-icon><Delete /></el-icon><span class="rd-del-text">删除</span>
            </el-button>
            <div class="rd-msg">
              <span v-if="rowErr(it)" class="money-out">{{ rowErr(it) }}</span>
              <span v-else-if="overAr(it) > 0" class="rd-warn">超出应收剩余 ¥{{ money(fromCents(overAr(it))) }}，这部分会自动转为预收款</span>
              <span v-else-if="arOf(it)" class="muted">应收 {{ arOf(it).code }} 剩余 ¥{{ money(arOf(it).remaining) }}</span>
            </div>
          </div>
          <el-button class="rd-add" :disabled="items.length >= 50" @click="addRow"><el-icon><Plus /></el-icon>再拆一笔</el-button>

          <div class="rd-total" :class="{ 'is-bad': overTotal }">
            <span>剩余可认领 <b class="money">¥{{ money(info.remainingAmount) }}</b></span>
            <span>本次合计 <b class="money">¥{{ money(fromCents(sumCents)) }}</b></span>
            <span>分配后剩余 <b class="money" :class="{ 'money-out': overTotal }">¥{{ money(fromCents(leftCents)) }}</b></span>
            <span v-if="overTotal" class="money-out rd-total-err">合计超过了流水剩余可认领，请调小金额</span>
          </div>
        </template>

        <!-- 结果 -->
        <div v-else class="rd-result">
          <el-alert type="success" :closable="false" class="rd-alert"
                    :title="`已认领 ¥${money(result.allocatedAmount)}，分给 ${result.results.length} 笔应收；流水剩余可认领 ¥${money(result.remainingAmount)}`" />
          <ResponsiveTable :data="result.results" size="small">
            <el-table-column label="应收" min-width="130" mobile="title">
              <template #default="{ row }">{{ row.receivable.code }}</template>
            </el-table-column>
            <el-table-column label="本次认领" width="120" align="right" mobile="amount">
              <template #default="{ row }"><span class="money money-in">{{ money(row.receiptAmount) }}</span></template>
            </el-table-column>
            <el-table-column label="应收已收 / 应收" width="190" align="right">
              <template #default="{ row }"><span class="money">{{ money(row.receivable.receivedAmount) }} / {{ money(row.receivable.amount) }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="90" mobile="badge">
              <template #default="{ row }">
                <el-tag size="small" :type="tagOf(RECEIVABLE_STATUS, row.receivable.status)">{{ labelOf(RECEIVABLE_STATUS, row.receivable.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="转预收" min-width="140">
              <template #default="{ row }">
                <span v-if="row.prepayment" class="rd-warn">超出 ¥{{ money(row.overpaidAmount) }} → {{ row.prepayment.code }}</span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
          </ResponsiveTable>
        </div>
      </template>
    </div>
    <template #footer>
      <template v-if="!result">
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!canSubmit" @click="submit">确认认领</el-button>
      </template>
      <el-button v-else type="primary" @click="visible = false">完成</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus, Delete } from '@element-plus/icons-vue'
import api from '@/api'
import { RECEIVABLE_STATUS, labelOf, tagOf } from '@/constants'
import { money, date } from '@/utils/format'
import { amountError, toCents, fromCents } from '@/utils/amount'
import ResponsiveTable from '@/components/mobile/ResponsiveTable'

const emit = defineEmits(['done'])

const visible = ref(false)
const loading = ref(false)
const saving = ref(false)
const txn = ref(null)
const info = ref({})
const ars = ref([])
const items = ref([])
const result = ref(null)
const filterKw = ref('')
let seq = 0

const arOf = (it) => ars.value.find((r) => r.id === it.receivableId)
const remCents = computed(() => toCents(info.value.remainingAmount))
const rowErr = (it) => {
  if (!it.receivableId) return '请选择应收'
  return amountError(it.amount, { label: '认领金额', max: fromCents(remCents.value), maxLabel: `超过了流水剩余可认领 ¥${money(info.value.remainingAmount)}` })
}
const overAr = (it) => (arOf(it) && !amountError(it.amount) ? toCents(it.amount) - toCents(arOf(it).remaining) : 0)
const sumCents = computed(() => items.value.reduce((s, it) => s + (amountError(it.amount) ? 0 : toCents(it.amount)), 0))
const leftCents = computed(() => remCents.value - sumCents.value)
const overTotal = computed(() => leftCents.value < 0)
const canSubmit = computed(() => items.value.length && !overTotal.value && items.value.every((it) => !rowErr(it)))

// 候选应收：客户名命中对方名称的、剩余正好等于流水剩余的排前面
function arOptions(it) {
  const kw = filterKw.value.trim()
  const cp = txn.value?.counterparty || ''
  const hit = (r) => !!cp && !!r.customer?.name && (cp.includes(r.customer.name) || r.customer.name.includes(cp))
  return ars.value
    .filter((r) => r.id === it.receivableId || !kw || [r.code, r.title, r.customer?.name, String(Number(r.remaining)), money(r.remaining), money(r.amount)].some((v) => v && String(v).includes(kw)))
    .sort((a, b) => (hit(b) - hit(a)) || ((toCents(b.remaining) === remCents.value) - (toCents(a.remaining) === remCents.value)) || (a.code < b.code ? 1 : -1))
    .slice(0, 100)
}

function defaultAmount(ar) {
  const free = remCents.value - items.value.reduce((s, x) => s + (amountError(x.amount) ? 0 : toCents(x.amount)), 0)
  const c = Math.max(0, ar ? Math.min(free, toCents(ar.remaining)) : free)
  return c > 0 ? fromCents(c) : ''
}

function onPickAr(it) {
  it.amount = ''
  it.amount = defaultAmount(arOf(it))
}

function addRow() {
  items.value.push({ key: ++seq, receivableId: '', amount: '' })
}

async function open(row) {
  txn.value = row
  result.value = null
  items.value = []
  visible.value = true
  loading.value = true
  try {
    const [r, list] = await Promise.all([
      api.transactions.receipts(row.id),
      api.receivables.list({ company_id: row.companyId, page_size: 500 })
    ])
    info.value = r
    ars.value = list.list
      .filter((a) => ['PENDING', 'PARTIAL'].includes(a.status))
      .map((a) => ({ ...a, id: String(a.id), remaining: fromCents(toCents(a.amount) - toCents(a.receivedAmount)) }))
    const first = { key: ++seq, receivableId: '', amount: '' }
    items.value = [first]
    const best = arOptions(first)[0]
    if (best) { first.receivableId = best.id; first.amount = defaultAmount(best) }
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (!canSubmit.value) return
  saving.value = true
  try {
    const r = await api.transactions.reconcile(txn.value.id, {
      items: items.value.map((it) => ({ receivableId: it.receivableId, amount: String(it.amount).trim() }))
    })
    result.value = r
    const pre = r.results.filter((x) => x.prepayment)
    ElMessage({
      type: pre.length ? 'warning' : 'success', duration: 6000, showClose: true,
      message: `已认领 ¥${money(r.allocatedAmount)} 到 ${r.results.map((x) => x.receivable.code).join('、')}` +
        (pre.length ? `；${pre.map((x) => `${x.receivable.code} 已结清，超出 ¥${money(x.overpaidAmount)} 已转预收款 ${x.prepayment.code}`).join('；')}` : '') +
        `；流水剩余 ¥${money(r.remainingAmount)}`
    })
    emit('done', r)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

defineExpose({ open })
</script>

<style scoped>
.rd-alert { margin-bottom: 12px; line-height: 1.7; }
.rd-exist { font-size: 12px; margin: -4px 0 12px; line-height: 1.8; }
.rd-exist-item { margin-right: 10px; }
.rd-row { display: grid; grid-template-columns: 24px 1fr 170px auto; gap: 6px 8px; align-items: center; margin-bottom: 10px; }
.rd-idx { color: var(--el-text-color-secondary); text-align: center; }
.rd-msg { grid-column: 2 / -1; font-size: 12px; line-height: 1.5; min-height: 18px; }
.rd-warn { color: #c77c02; }
.rd-opt { display: flex; gap: 10px; min-width: 0; }
.rd-opt-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--el-text-color-secondary); }
.rd-del-text { display: none; }
.rd-add { margin: 2px 0 12px 32px; }
.rd-total { display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 10px 12px; border-radius: 8px; background: #f7f7f5; font-size: 13px; }
.rd-total.is-bad { background: #fdf0ee; }
.rd-total-err { flex-basis: 100%; }
@media (max-width: 768px) {
  /* 手机：每行一张卡片，应收 / 金额上下排 */
  .rd-row { grid-template-columns: 1fr; border: 1px solid var(--border, #eee); border-radius: 8px; padding: 10px; position: relative; }
  .rd-idx { position: absolute; top: -9px; left: 10px; background: var(--surface, #fff); padding: 0 6px; font-size: 12px; }
  .rd-msg { grid-column: 1; }
  .rd-ar, .rd-amt { width: 100%; }
  .rd-ar :deep(.el-select__wrapper), .rd-amt :deep(.el-input__wrapper) { min-height: 44px; }
  .rd-del { min-height: 44px; width: 100%; margin: 0; }
  .rd-del-text { display: inline; margin-left: 4px; }
  .rd-add { width: 100%; min-height: 44px; margin: 0 0 12px; }
  .rd-total { flex-direction: column; }
}
</style>
