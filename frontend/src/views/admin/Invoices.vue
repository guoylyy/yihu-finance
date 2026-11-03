<template>
  <CrudTable
    ref="tableRef"
    :api="api.invoices"
    title="发票台账"
    subtitle="销项 / 进项 / 费用 / 红字发票，支持 Excel 导入与发票号查重"
    entity-name="发票"
    add-text="录入发票"
    :columns="columns"
    :form-fields="formFields"
    :filters="filters"
    :default-form="{ type: 'PURCHASE', status: 'PENDING', amount: 0, taxAmount: 0, totalAmount: 0 }"
    :can-manage="can('invoice.manage')"
    search-placeholder="搜索发票号 / 开票方 / 受票方"
    :action-width="230"
    pin-type="invoice"
    :pin-label="(r) => `发票 ${r.invoiceNo}`"
    draft-kind="invoice"
  >
    <template #toolbar="{ reload }">
      <el-upload v-if="can('invoice.manage')" :auto-upload="false" :show-file-list="false"
                 :on-change="(f) => importFile(f, reload)" style="display: inline-block; margin-right: 10px">
        <el-button><el-icon><Upload /></el-icon>Excel 导入</el-button>
      </el-upload>
      <el-button @click="showDuplicates">
        查重<el-badge v-if="stats.duplicateNos?.length" :value="stats.duplicateNos.length" style="margin-left: 4px" />
      </el-button>
    </template>

    <template #col-invoiceNo="{ row }">
      <template v-if="isMobile">{{ row.invoiceNo ?? '—' }}</template>
      <template v-else>
        <div class="inv-no">{{ row.invoiceNo ?? '—' }}</div>
        <div class="inv-sub">
          <el-tag size="small" class="inv-status" :type="tagOf(INVOICE_STATUS, row.status)">{{ labelOf(INVOICE_STATUS, row.status) }}</el-tag>
          <span class="muted">{{ date(row.issueDate) }}</span>
        </div>
      </template>
    </template>

    <template #col-receivable="{ row }">
      <el-button v-if="row.receivable" link type="primary" @click.stop="drawerRef?.open(row.receivable.id)">{{ row.receivable.code }}</el-button>
      <span v-else-if="LINKABLE.includes(row.type)" class="muted">未挂</span>
      <span v-else class="muted">—</span>
    </template>

    <template #row-actions="{ row }">
      <el-button v-if="can('invoice.manage') && LINKABLE.includes(row.type)" link type="primary" @click="openLink(row)">
        {{ row.receivable ? '改挂 / 摘除' : '挂应收' }}
      </el-button>
    </template>

    <template #form-extra="{ form }">
      <el-form-item v-if="form.id && LINKABLE.includes(form.type)" label="关联应收">
        <span v-if="form.receivable">{{ form.receivable.code }}｜{{ form.receivable.title }}｜¥{{ money(form.receivable.amount) }}</span>
        <span v-else class="muted">未挂</span>
        <el-button link type="primary" style="margin-left: 8px" @click="openLink(form)">{{ form.receivable ? '改挂 / 摘除' : '挂应收' }}</el-button>
      </el-form-item>
    </template>

    <template #stats>
      <div class="stat-grid">
        <div v-for="t in stats.byType || []" :key="t.type" class="stat-card">
          <div class="label">{{ labelOf(INVOICE_TYPES, t.type) }}</div>
          <div class="value">¥{{ money(t.total) }}</div>
          <div class="foot">{{ t.count }} 张｜税额 {{ money(t.tax) }}</div>
        </div>
        <div class="stat-card is-accent">
          <div class="label">待处理</div>
          <div class="value">{{ stats.pendingCount || 0 }}</div>
          <div class="foot">未入账发票</div>
        </div>
      </div>
    </template>
  </CrudTable>

  <el-dialog v-model="dupVisible" title="重复发票号" width="720px">
    <el-alert type="warning" :closable="false" style="margin-bottom: 12px"
              title="同一公司下发票号重复，通常是重复录入或重复报销，请核实后作废其中一条" />
    <ResponsiveTable :data="dupList" size="small">
      <el-table-column prop="invoiceNo" label="发票号码" width="180" mobile="title" />
      <el-table-column prop="company.code" label="公司" width="110" />
      <el-table-column label="类型" width="100">
        <template #default="{ row }">{{ labelOf(INVOICE_TYPES, row.type) }}</template>
      </el-table-column>
      <el-table-column label="开票日期" width="110">
        <template #default="{ row }">{{ date(row.issueDate) }}</template>
      </el-table-column>
      <el-table-column label="价税合计" align="right" width="120" mobile="amount">
        <template #default="{ row }"><span class="money">{{ money(row.totalAmount) }}</span></template>
      </el-table-column>
      <el-table-column prop="sellerName" label="开票方" min-width="150" />
    </ResponsiveTable>
  </el-dialog>

  <!-- 挂应收 / 改挂 / 摘除 -->
  <el-dialog v-model="link.visible" title="发票挂应收" width="min(560px, 96vw)" append-to-body>
    <template v-if="link.inv">
      <el-alert type="info" :closable="false" style="margin-bottom: 14px"
                :title="`${labelOf(INVOICE_TYPES, link.inv.type)} ${link.inv.invoiceNo}｜价税合计 ¥${money(link.inv.totalAmount)}｜受票方 ${link.inv.buyerName || '—'}`" />
      <el-form label-width="84px" @submit.prevent>
        <el-form-item label="当前">
          <span v-if="link.inv.receivable">{{ link.inv.receivable.code }}｜{{ link.inv.receivable.title }}</span>
          <span v-else class="muted">未挂应收</span>
        </el-form-item>
        <el-form-item label="挂到应收">
          <el-select v-model="link.receivableId" filterable :filter-method="(kw) => (link.kw = kw)" :loading="link.loading"
                     placeholder="搜应收编号 / 客户 / 金额" style="width: 100%" @visible-change="(v) => v && (link.kw = '')">
            <el-option v-for="r in arOptions" :key="r.id" :value="r.id" :label="`${r.code}｜${r.customer?.name || r.title}｜¥${money(r.amount)}`">
              <div class="lk-opt">
                <span class="lk-code">{{ r.code }}</span>
                <span class="lk-name">{{ r.customer?.name || '—' }}｜{{ r.title }}</span>
                <span class="money">¥{{ money(r.amount) }}</span>
              </div>
            </el-option>
          </el-select>
          <div class="muted" style="font-size: 12px; line-height: 1.6">只列同公司、未取消的应收；同客户、金额接近的排在前面</div>
        </el-form-item>
      </el-form>
    </template>
    <template #footer>
      <el-button v-if="link.inv?.receivable" type="danger" plain :loading="link.saving" @click="saveLink(null)">摘除</el-button>
      <el-button @click="link.visible = false">取消</el-button>
      <el-button type="primary" :loading="link.saving" :disabled="!link.receivableId" @click="saveLink(link.receivableId)">保存</el-button>
    </template>
  </el-dialog>

  <ReceivableDrawer ref="drawerRef" :allow-claim="false" @changed="tableRef?.reload()" />
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import CrudTable from '@/components/CrudTable.vue'
import api from '@/api'
import { can } from '@/api/permissions'
import { companies, loadMeta } from '@/composables/useMeta'
import { INVOICE_TYPES, INVOICE_STATUS, labelOf, tagOf } from '@/constants'
import { money, date } from '@/utils/format'
import ResponsiveTable from '@/components/mobile/ResponsiveTable'
import ReceivableDrawer from '@/components/ReceivableDrawer.vue'
import { useViewport } from '@/composables/useViewport'

const LINKABLE = ['SALES', 'RED'] // 只有销项 / 红字发票能挂应收
const drawerRef = ref(null)

const tableRef = ref(null)
const stats = ref({})
const dupVisible = ref(false)
const dupList = ref([])
const companyOptions = () => companies.value.map((c) => ({ value: String(c.id), label: c.code }))

// 手机卡片：全部字段照旧显示。
// 桌面 1440：表格可视宽 778，固定列（价税合计 130 + 操作 230）也算在这 778 里，留给非固定列的只有 418：
//   发票号码 ≥164（弹性吃掉余量，第二行小字放状态 + 开票日期）+ 类型 84 + 关联应收 130 = 378 ≤ 418
//   合计 378 + 130 + 230 = 738 ≤ 778，余下 40 由发票号码列撑满，不留空缝。
// 公司 / 开票方 / 受票方 / 金额 / 税额在桌面隐藏（筛选、编辑弹窗里仍可查看、修改）。
const MOBILE_COLUMNS = [
  { prop: 'invoiceNo', label: '发票号码', width: 160 },
  { prop: 'company.code', label: '公司', width: 100 },
  { prop: 'type', label: '类型', width: 100, type: 'enum', tagList: INVOICE_TYPES },
  { prop: 'receivable', label: '关联应收', width: 130 },
  { prop: 'issueDate', label: '开票日期', width: 110, type: 'date' },
  { prop: 'sellerName', label: '开票方', minWidth: 160, ellipsis: true },
  { prop: 'buyerName', label: '受票方', minWidth: 160, ellipsis: true },
  { prop: 'amount', label: '金额', width: 110, align: 'right', type: 'money' },
  { prop: 'taxAmount', label: '税额', width: 100, align: 'right', type: 'money' },
  { prop: 'totalAmount', label: '价税合计', width: 120, align: 'right', type: 'money' },
  { prop: 'status', label: '状态', width: 90, type: 'tag', tagList: INVOICE_STATUS }
]
const DESKTOP_COLUMNS = [
  { prop: 'invoiceNo', label: '发票号码', minWidth: 164 },
  { prop: 'type', label: '类型', width: 84, type: 'enum', tagList: INVOICE_TYPES },
  { prop: 'receivable', label: '关联应收', width: 130 },
  { prop: 'totalAmount', label: '价税合计', width: 130, align: 'right', type: 'money', fixed: 'right' }
]
const { isMobile } = useViewport()
const columns = computed(() => (isMobile.value ? MOBILE_COLUMNS : DESKTOP_COLUMNS))

const filters = [
  { prop: 'company_id', label: '全部公司', type: 'select', width: 120, options: () => companyOptions() },
  { prop: 'type', label: '发票类型', type: 'select', width: 120, options: INVOICE_TYPES },
  { prop: 'status', label: '状态', type: 'select', width: 110, options: INVOICE_STATUS },
  { prop: 'linked', label: '是否已挂应收', type: 'select', width: 130, options: [{ value: '1', label: '已挂应收' }, { value: '0', label: '未挂应收' }] },
  { prop: 'daterange', type: 'daterange' }
]

const formFields = [
  { prop: 'companyId', label: '所属公司', type: 'select', required: true, options: () => companyOptions() },
  { prop: 'type', label: '发票类型', type: 'select', required: true, options: INVOICE_TYPES },
  { prop: 'invoiceNo', label: '发票号码', required: true },
  { prop: 'invoiceCode', label: '发票代码' },
  { prop: 'issueDate', label: '开票日期', type: 'date' },
  { prop: 'sellerName', label: '开票方' },
  { prop: 'buyerName', label: '受票方' },
  { prop: 'amount', label: '不含税金额', type: 'money' },
  { prop: 'taxAmount', label: '税额', type: 'money' },
  { prop: 'totalAmount', label: '价税合计', type: 'money', hint: '三个金额填两个，第三个会自动补齐' },
  { prop: 'status', label: '状态', type: 'select', options: INVOICE_STATUS },
  { prop: 'remark', label: '备注', type: 'textarea' }
]

// ── 挂应收 ──
const link = reactive({ visible: false, inv: null, receivableId: '', list: [], kw: '', loading: false, saving: false })
const arOptions = computed(() => {
  const kw = link.kw.trim()
  const total = Math.abs(Number(link.inv?.totalAmount || 0))
  const custId = link.inv?.customerId ? String(link.inv.customerId) : ''
  const buyer = link.inv?.buyerName || ''
  const sameCust = (r) => (custId && String(r.customerId) === custId) || (!!buyer && !!r.customer?.name && (buyer.includes(r.customer.name) || r.customer.name.includes(buyer)))
  return link.list
    .filter((r) => r.id === link.receivableId || !kw || [r.code, r.title, r.customer?.name, String(Number(r.amount)), money(r.amount)].some((v) => v && String(v).includes(kw)))
    .sort((a, b) => (sameCust(b) - sameCust(a)) || (Math.abs(Number(a.amount) - total) - Math.abs(Number(b.amount) - total)))
    .slice(0, 100)
})

async function openLink(inv) {
  Object.assign(link, { visible: true, inv, receivableId: inv.receivable ? String(inv.receivable.id) : '', kw: '', list: [], loading: true })
  try {
    const d = await api.receivables.list({ company_id: inv.companyId, page_size: 500 })
    link.list = d.list.filter((r) => !['CANCELLED', 'WRITTEN_OFF'].includes(r.status)).map((r) => ({ ...r, id: String(r.id) }))
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    link.loading = false
  }
}

async function saveLink(receivableId) {
  link.saving = true
  try {
    const r = await api.invoices.linkReceivable(link.inv.id, receivableId)
    const code = r.receivable?.code
    ElMessage.success(receivableId ? `发票 ${link.inv.invoiceNo} 已挂到 ${code}` : `发票 ${link.inv.invoiceNo} 已摘除`)
    if (r.warnings?.length) ElMessage({ type: 'warning', message: r.warnings.join('；'), duration: 6000, showClose: true })
    link.visible = false
    tableRef.value?.load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    link.saving = false
  }
}

async function loadStats() {
  try { stats.value = await api.invoices.stats() } catch { /* 统计失败不影响列表 */ }
}

async function importFile(f, reload) {
  const fd = new FormData()
  fd.append('file', f.raw)
  fd.append('companyId', companies.value[0]?.id)
  fd.append('type', 'PURCHASE')
  try {
    const r = await api.invoices.importFile(fd)
    ElMessage.success(`导入成功 ${r.success} 张${r.skipped.length ? `，跳过 ${r.skipped.length} 张` : ''}`)
    reload(); loadStats()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function showDuplicates() {
  try {
    const d = await api.invoices.duplicates()
    dupList.value = d.list
    if (!d.count) return ElMessage.success('没有发现重复发票号')
    dupVisible.value = true
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(async () => { await loadMeta(); loadStats() })
</script>

<style scoped>
.inv-no { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.inv-sub { display: flex; align-items: center; gap: 6px; font-size: 12px; margin-top: 2px; white-space: nowrap; }
.inv-status { flex: none; height: 18px; padding: 0 5px; font-size: 11px; }
.lk-opt { display: flex; gap: 10px; align-items: center; min-width: 0; }
.lk-code { flex-shrink: 0; }
.lk-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--el-text-color-secondary); }
</style>
