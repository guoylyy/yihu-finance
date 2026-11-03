<!--
  应收表单里的「发票」多选（v1.4）
  候选：同公司、销项 / 红字、未作废、还没挂别的应收（+ 本应收已挂的）；默认只看本客户，按价税合计与应收金额的接近程度排序
  选中结果写到 form.invoiceIds；form._origInvoiceIds 记打开时已挂的，保存后由父页面按差异逐张挂 / 摘（PATCH /invoices/:id）
-->
<template>
  <el-form-item label="发票">
    <el-select v-model="form.invoiceIds" multiple filterable remote :remote-method="search" :loading="loading"
               :disabled="!form.companyId" :placeholder="form.companyId ? '搜发票号，可多选' : '先选收款公司'"
               style="width: 100%" collapse-tags-tooltip :max-collapse-tags="isMobile ? 2 : 4" @visible-change="(v) => v && search('')">
      <el-option v-for="inv in options" :key="inv.id" :value="inv.id" :label="inv.invoiceNo">
        <div class="ip-opt">
          <span class="ip-no">{{ inv.invoiceNo }}<el-tag v-if="inv.type === 'RED'" size="small" type="danger" effect="plain" class="ip-tag">红字</el-tag></span>
          <span class="muted ip-date">{{ date(inv.issueDate) }}</span>
          <span class="money" :class="{ 'money-out': inv.type === 'RED' }">¥{{ money(signed(inv)) }}</span>
        </div>
      </el-option>
    </el-select>
    <div class="ip-bar">
      <el-checkbox v-if="form.customerId" v-model="onlyCustomer" @change="search(lastKw)">只看本客户的发票</el-checkbox>
      <span class="muted">候选为同公司、未挂其他应收的销项 / 红字发票</span>
    </div>
    <div v-if="form.invoiceIds?.length" class="ip-sum">
      已选 {{ form.invoiceIds.length }} 张｜价税合计 <b class="money">¥{{ money(fromCents(blue)) }}</b>
      <template v-if="red">｜红字冲减 <b class="money money-out">¥{{ money(fromCents(red)) }}</b></template>
      ｜已开票合计 <b class="money">¥{{ money(fromCents(blue - red)) }}</b>
      ｜未开票差额 <b class="money" :class="{ 'money-out': diff !== 0 }">¥{{ money(fromCents(diff)) }}</b>
      <span v-if="diff < 0" class="money-out">（开票超过应收金额，请核对）</span>
    </div>
  </el-form-item>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api'
import { money, date } from '@/utils/format'
import { toCents, fromCents } from '@/utils/amount'
import { useViewport } from '@/composables/useViewport'

const props = defineProps({
  form: { type: Object, required: true },
  customers: { type: Array, default: () => [] }
})
const { isMobile } = useViewport()

const loading = ref(false)
const onlyCustomer = ref(true)
const lastKw = ref('')
const cache = ref(new Map()) // id → 发票，选中的项换了搜索词也要能显示
const found = ref([])

const signed = (inv) => (inv.type === 'RED' ? -Math.abs(Number(inv.totalAmount)) : Number(inv.totalAmount))
const customerName = computed(() => props.customers.find((c) => String(c.id) === String(props.form.customerId))?.name || '')
const selected = computed(() => (props.form.invoiceIds || []).map((id) => cache.value.get(id)).filter(Boolean))
const blue = computed(() => selected.value.filter((i) => i.type !== 'RED').reduce((s, i) => s + toCents(i.totalAmount), 0))
const red = computed(() => selected.value.filter((i) => i.type === 'RED').reduce((s, i) => s + Math.abs(toCents(i.totalAmount)), 0))
const diff = computed(() => toCents(props.form.amount) - (blue.value - red.value))
const options = computed(() => {
  const ids = new Set(found.value.map((i) => i.id))
  return [...selected.value.filter((i) => !ids.has(i.id)), ...found.value]
})

const matchCustomer = (inv) => {
  if (!onlyCustomer.value || !props.form.customerId) return true
  if (inv.customerId) return String(inv.customerId) === String(props.form.customerId)
  const n = customerName.value
  return !inv.buyerName || !n || inv.buyerName.includes(n) || n.includes(inv.buyerName)
}

async function search(kw = '') {
  lastKw.value = kw
  if (!props.form.companyId) return
  loading.value = true
  try {
    const d = await api.invoices.list({ company_id: props.form.companyId, linked: 0, keyword: kw, page_size: 200 })
    const target = toCents(props.form.amount)
    found.value = d.list
      .filter((i) => ['SALES', 'RED'].includes(i.type) && i.status !== 'VOID' && matchCustomer(i))
      .sort((a, b) => Math.abs(toCents(a.totalAmount) - target) - Math.abs(toCents(b.totalAmount) - target))
    for (const i of found.value) cache.value.set(i.id, i)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

// 打开表单（新增 / 编辑某行）时：编辑先把已挂的发票拉回来作为初始选中
watch(() => props.form, async (form) => {
  found.value = []
  if (!form) return
  if (form.id && !form._invoicesLoaded) {
    form._invoicesLoaded = true
    try {
      const d = await api.invoices.list({ receivable_id: form.id, page_size: 200 })
      for (const i of d.list) cache.value.set(i.id, i)
      form._origInvoiceIds = d.list.map((i) => i.id)
      form.invoiceIds = [...form._origInvoiceIds]
    } catch (e) {
      ElMessage.error(e.message)
    }
  } else if (!form.id) {
    form._origInvoiceIds = form._origInvoiceIds || []
    form.invoiceIds = form.invoiceIds || []
  }
}, { immediate: true })

// 换公司：已选的发票不属于新公司，清空
watch(() => props.form?.companyId, (v, old) => {
  if (old !== undefined && v !== old) { props.form.invoiceIds = []; found.value = [] }
})
</script>

<style scoped>
.ip-opt { display: flex; gap: 10px; align-items: center; justify-content: space-between; min-width: 0; }
.ip-no { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ip-tag { margin-left: 4px; }
.ip-date { font-size: 12px; }
.ip-bar { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; font-size: 12px; margin-top: 4px; width: 100%; }
.ip-sum { font-size: 12px; line-height: 1.7; margin-top: 4px; width: 100%; }
</style>
