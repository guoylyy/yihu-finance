<!--
  应收「认领流水」两步弹窗（v1.4）
  ① 选流水：从本公司的收入流水里挑一笔（默认只列还有剩余可认领的）→ ② 确认金额 → POST /receivables/:id/receipt { transactionId, amount }
  找不到对应流水时切到「新建流水」：账户 / 金额 / 日期 / 备注 → POST /receivables/:id/receipt { accountId, amount, receiptDate }
  用法：ref.open(应收行) / ref.open(应收行, { mode: 'new', prefill: {...} })；成功后 emit('done', 响应)
-->
<template>
  <el-dialog v-model="visible" :title="ar ? `认领流水｜${ar.code}` : '认领流水'" width="min(780px, 96vw)"
             class="receipt-dialog" append-to-body destroy-on-close>
    <template v-if="ar">
      <el-alert type="info" :closable="false" class="rc-alert">
        <template #title>
          <span class="rc-ar">{{ ar.title }}</span>
          <span>应收 ¥{{ money(ar.amount) }}｜已收 ¥{{ money(ar.receivedAmount) }}｜<b>剩余 ¥{{ money(arRemaining) }}</b></span>
        </template>
      </el-alert>

      <el-steps :active="step === 'pick' ? 0 : 1" simple finish-status="success" class="rc-steps">
        <el-step title="选流水" />
        <el-step :title="step === 'new' ? '新建流水' : '确认金额'" />
      </el-steps>

      <!-- ① 选流水 -->
      <div v-show="step === 'pick'">
        <div class="rc-filters">
          <el-input v-model="f.keyword" placeholder="搜索对方名称 / 流水号 / 备注" clearable :prefix-icon="Search"
                    enterkeyhint="search" class="rc-kw" @keyup.enter="search" @clear="search" />
          <el-date-picker v-model="f.range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期"
                          end-placeholder="结束日期" class="rc-range" @change="search" />
          <el-input v-model="f.amount" placeholder="金额（可选）" clearable inputmode="decimal" class="rc-amt"
                    @keyup.enter="search" @clear="search" />
          <el-checkbox v-model="f.includeUsed" class="rc-used" @change="search">显示已认领满的</el-checkbox>
          <el-button type="primary" class="rc-search" @click="search">查询</el-button>
        </div>

        <ResponsiveTable :data="list" v-loading="loading" size="small" class="rc-table" :row-class-name="rowClass"
                         highlight-current-row empty-text="没有符合条件的流水" @row-click="pick">
          <el-table-column label="日期" width="98" mobile="badge">
            <template #default="{ row }">{{ row.txnDate }}</template>
          </el-table-column>
          <el-table-column label="账户" min-width="110">
            <template #default="{ row }">{{ row.accountName }}</template>
          </el-table-column>
          <el-table-column label="金额" width="112" align="right" mobile="amount">
            <template #default="{ row }"><span class="money money-in">+{{ money(row.amount) }}</span></template>
          </el-table-column>
          <el-table-column label="对方" min-width="150" mobile="title">
            <template #default="{ row }">
              <span>{{ row.counterparty || '（无对方名称）' }}</span>
              <el-tag v-if="row.match?.amountEqualsTarget" size="small" type="success" effect="plain" class="rc-tag">金额相同</el-tag>
              <el-tag v-if="row.match?.counterpartyHit" size="small" effect="plain" class="rc-tag">客户匹配</el-tag>
              <div class="muted rc-sub">{{ row.code }}<template v-if="row.remark">｜{{ row.remark }}</template></div>
            </template>
          </el-table-column>
          <el-table-column label="已认领" width="100" align="right">
            <template #default="{ row }">
              <span class="money">{{ money(row.claimedAmount) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="剩余可认领" width="112" align="right">
            <template #default="{ row }">
              <span class="money" :class="{ muted: Number(row.remainingAmount) <= 0 }">{{ money(row.remainingAmount) }}</span>
            </template>
          </el-table-column>
        </ResponsiveTable>
        <div class="rc-pager" v-if="total > pageSize">
          <ResponsivePager v-model:current-page="page" :page-size="pageSize" :total="total" layout="total, prev, pager, next"
                           @change="load" />
        </div>
        <div class="rc-foot-tip">
          找不到这笔钱？<el-button link type="primary" class="rc-new-link" @click="toNew()"><b>新建一条流水</b></el-button>
        </div>
      </div>

      <!-- ② 确认金额（选了已有流水） -->
      <div v-if="step === 'confirm' && picked" class="rc-confirm">
        <div class="rc-sum">
          <div class="rc-sum-row"><span class="muted">应收</span><span>{{ ar.code }}</span><span class="money">剩余 ¥{{ money(arRemaining) }}</span></div>
          <div class="rc-sum-row"><span class="muted">流水</span><span>{{ picked.code }}｜{{ picked.txnDate }}｜{{ picked.accountName }}</span>
            <span class="money">剩余 ¥{{ money(picked.remainingAmount) }}</span></div>
          <div class="rc-sum-row is-main"><span class="muted">本次金额</span><span></span>
            <span class="money money-in">¥{{ amountErr ? '—' : money(confirm.amount) }}</span></div>
        </div>
        <el-form label-width="96px" @submit.prevent>
          <el-form-item label="本次金额" required :error="amountErr">
            <el-input v-model="confirm.amount" inputmode="decimal" placeholder="0.00">
              <template #prefix>¥</template>
            </el-input>
            <div class="muted rc-hint">最多 ¥{{ money(fromCents(capCents)) }}（应收剩余与流水剩余取小）
              <template v-if="!amountErr && leftAr > 0">；认领后应收还剩 ¥{{ money(fromCents(leftAr)) }}</template>
              <template v-if="!amountErr && leftTxn > 0">；流水还剩 ¥{{ money(fromCents(leftTxn)) }} 可认领到别的应收</template>
            </div>
          </el-form-item>
          <el-form-item label="备注"><el-input v-model="confirm.remark" maxlength="200" /></el-form-item>
        </el-form>
      </div>

      <!-- 新建流水（旧「登记回款」表单） -->
      <div v-if="step === 'new'">
        <el-alert v-if="prefillHint" type="warning" :closable="false" class="rc-alert" :title="prefillHint" />
        <el-form :model="nf" label-width="96px" @submit.prevent>
          <el-form-item label="收款账户" required>
            <el-select v-model="nf.accountId" style="width: 100%" placeholder="钱收到哪个账户">
              <el-option v-for="a in accountsOf(ar.companyId)" :key="a.id" :label="`${a.name}（${a.currency}）`" :value="a.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="本次收款" required :error="newAmountErr">
            <el-input-number v-model="nf.amount" :precision="2" :min="0.01" :step="1000" style="width: 100%"
                             inputmode="decimal" :controls="!isMobile" />
            <div class="muted rc-hint">会新记一笔收入流水并认领到 {{ ar.code }}；超过应收剩余的部分自动转预收款</div>
          </el-form-item>
          <el-form-item label="收款日期">
            <el-date-picker v-model="nf.receiptDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          </el-form-item>
          <el-form-item label="备注"><el-input v-model="nf.remark" maxlength="200" /></el-form-item>
        </el-form>
      </div>
    </template>

    <template #footer>
      <template v-if="step === 'pick'">
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :disabled="!picked" @click="toConfirm">下一步</el-button>
      </template>
      <template v-else>
        <el-button @click="step = 'pick'">上一步</el-button>
        <el-button v-if="step === 'confirm'" type="primary" :loading="saving" :disabled="!!amountErr" @click="submitClaim">确认认领</el-button>
        <el-button v-else type="primary" :loading="saving" @click="submitNew">确认收款</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import api from '@/api'
import { accountsOf, loadMeta } from '@/composables/useMeta'
import { money } from '@/utils/format'
import { amountError, toCents, fromCents } from '@/utils/amount'
import { receiptToast } from '@/utils/receipt'
import { useViewport } from '@/composables/useViewport'
import ResponsiveTable from '@/components/mobile/ResponsiveTable'
import ResponsivePager from '@/components/mobile/ResponsivePager'

const emit = defineEmits(['done'])
const { isMobile } = useViewport()

const visible = ref(false)
const ar = ref(null)
const step = ref('pick')
const loading = ref(false)
const saving = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = 10
const picked = ref(null)
const prefillHint = ref('')
const f = reactive({ keyword: '', range: [], amount: '', includeUsed: false })
const confirm = reactive({ amount: '', remark: '' })
const nf = ref({})
const today = () => new Date().toISOString().slice(0, 10)

const arRemaining = computed(() => (ar.value ? fromCents(toCents(ar.value.amount) - toCents(ar.value.receivedAmount)) : '0.00'))
const capCents = computed(() => Math.min(toCents(arRemaining.value), toCents(picked.value?.remainingAmount)))
const amountErr = computed(() => amountError(confirm.amount, {
  label: '本次金额', max: fromCents(capCents.value),
  maxLabel: toCents(picked.value?.remainingAmount) < toCents(arRemaining.value)
    ? `超过了流水剩余可认领 ¥${money(picked.value?.remainingAmount)}`
    : `超过了应收剩余 ¥${money(arRemaining.value)}`
}))
const leftAr = computed(() => toCents(arRemaining.value) - toCents(confirm.amount))
const leftTxn = computed(() => toCents(picked.value?.remainingAmount) - toCents(confirm.amount))
const newAmountErr = ref('')

function open(row, { mode = 'pick', prefill = null } = {}) {
  ar.value = row
  picked.value = null
  prefillHint.value = ''
  Object.assign(f, { keyword: '', range: [], amount: '', includeUsed: false })
  Object.assign(confirm, { amount: '', remark: '' })
  newAmountErr.value = ''
  page.value = 1
  list.value = []
  visible.value = true
  if (mode === 'new') toNew(prefill)
  else step.value = 'pick'
  load()
}

function search() { page.value = 1; load() }

async function load() {
  if (!ar.value) return
  const amt = String(f.amount || '').trim()
  if (amt && amountError(amt)) return ElMessage.warning(amountError(amt, { label: '筛选金额' }))
  loading.value = true
  try {
    const d = await api.receivables.receiptCandidates(ar.value.id, {
      keyword: f.keyword.trim(), date_from: f.range?.[0], date_to: f.range?.[1],
      ...(amt ? { amount: amt, amount_min: amt, amount_max: amt } : {}),
      include_used: f.includeUsed ? 1 : '', page: page.value, page_size: pageSize
    })
    list.value = d.list
    total.value = d.total
    // 以接口返回的应收为准（列表里的已收可能是旧的）
    if (d.receivable) ar.value = { ...ar.value, amount: d.receivable.amount, receivedAmount: d.receivable.receivedAmount }
    if (picked.value && !d.list.some((t) => t.id === picked.value.id)) picked.value = null
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

const usable = (t) => Number(t.remainingAmount) > 0 && !t.match?.alreadyClaimedThis
function pick(row) {
  if (Number(row.remainingAmount) <= 0) return ElMessage.warning(`流水 ${row.code} 已认领满，不能再认领`)
  if (row.match?.alreadyClaimedThis) return ElMessage.warning(`流水 ${row.code} 已认领过这笔应收；如需调整金额，请先在应收详情里撤销原认领`)
  picked.value = row
}
const rowClass = ({ row }) => [picked.value?.id === row.id ? 'is-picked' : '', usable(row) ? '' : 'is-used'].join(' ')

function toConfirm() {
  if (!picked.value) return
  confirm.amount = fromCents(capCents.value)
  step.value = 'confirm'
}

function toNew(prefill = null) {
  nf.value = {
    accountId: accountsOf(ar.value.companyId)[0]?.id,
    amount: Number(arRemaining.value) > 0 ? Number(arRemaining.value) : undefined,
    receiptDate: today(),
    remark: '',
    ...(prefill || {})
  }
  if (prefill?.amount) prefillHint.value = `录入助手草稿：金额 ¥${money(prefill.amount)}。如果这笔钱已经在流水里（比如导入过银行流水），请点「上一步」直接选那笔，避免重复入账。`
  newAmountErr.value = ''
  step.value = 'new'
}

async function submitClaim() {
  if (amountErr.value) return
  saving.value = true
  try {
    const r = await api.receivables.receipt(ar.value.id, { transactionId: picked.value.id, amount: confirm.amount.trim(), remark: confirm.remark || undefined })
    receiptToast(r, ar.value.code)
    visible.value = false
    emit('done', r)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function submitNew() {
  if (!nf.value.accountId) return ElMessage.warning('请选择收款账户')
  newAmountErr.value = amountError(nf.value.amount == null ? '' : String(nf.value.amount), { label: '收款金额' })
  if (newAmountErr.value) return ElMessage.warning(newAmountErr.value)
  saving.value = true
  try {
    const r = await api.receivables.receipt(ar.value.id, {
      accountId: nf.value.accountId, amount: Number(nf.value.amount).toFixed(2),
      receiptDate: nf.value.receiptDate || today(), remark: nf.value.remark || undefined
    })
    receiptToast(r, ar.value.code, { newTxn: true })
    await loadMeta(true) // 新流水改了账户余额，刷新缓存
    visible.value = false
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
.rc-alert { margin-bottom: 12px; }
.rc-ar { font-weight: 600; margin-right: 8px; }
.rc-steps { margin-bottom: 12px; }
.rc-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.rc-kw { width: 220px; }
.rc-range { width: 240px !important; }
.rc-amt { width: 130px; }
.rc-sub { font-size: 12px; margin-top: 2px; word-break: break-all; }
.rc-tag { margin-left: 4px; }
.rc-pager { margin-top: 8px; display: flex; justify-content: flex-end; }
.rc-foot-tip { margin-top: 12px; font-size: 13px; color: var(--text-2, #666); }
.rc-hint { font-size: 12px; line-height: 1.6; margin-top: 4px; }
.rc-sum { border: 1px solid var(--border, #eee); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; font-size: 13px; }
.rc-sum-row { display: grid; grid-template-columns: 64px 1fr auto; gap: 8px; padding: 4px 0; align-items: baseline; }
.rc-sum-row > span:nth-child(2) { min-width: 0; word-break: break-all; }
.rc-sum-row.is-main { border-top: 1px dashed var(--border, #eee); margin-top: 4px; padding-top: 8px; font-size: 15px; font-weight: 600; }
.rc-table :deep(tr.is-picked > td) { background: #fdf1ea !important; }
.rc-table :deep(tr.is-used) { color: #aaa; cursor: not-allowed; }
.rc-table :deep(tr) { cursor: pointer; }
.rc-table :deep(.m-card) { cursor: pointer; }
.rc-table :deep(.m-card.is-picked) { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent) inset; background: #fdf6f1; }
.rc-table :deep(.m-card.is-used) { opacity: .55; }

@media (max-width: 768px) {
  .rc-kw, .rc-range, .rc-amt { width: 100% !important; }
  .rc-used { flex: 1; min-height: 44px; }
  .rc-search { min-height: 44px; min-width: 88px; }
  .rc-new-link { min-height: 44px; }
  .rc-steps :deep(.el-step__title) { font-size: 13px; }
}
</style>
