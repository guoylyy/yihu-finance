<template>
  <div class="page" v-loading="loading">
    <div class="page-head">
      <div>
        <div class="page-title">
          {{ payroll.company?.code }} · {{ payroll.period }} 工资
          <el-tag size="small" :type="tagOf(PAYROLL_STATUS, payroll.status)">{{ labelOf(PAYROLL_STATUS, payroll.status) }}</el-tag>
        </div>
        <div class="page-sub">{{ payroll.code }}｜{{ payroll.personCount }} 人｜发薪日 {{ date(payroll.payDate) }}</div>
      </div>
      <div>
        <el-button @click="$router.push('/payrolls')">返回列表</el-button>
        <el-upload v-if="can('payroll.manage') && payroll.status !== 'PAID'" :auto-upload="false" :show-file-list="false" :on-change="importFile">
          <el-button type="primary"><el-icon><Upload /></el-icon>导入工资表</el-button>
        </el-upload>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card"><div class="label">应发合计</div><div class="value">¥{{ money(payroll.grossTotal) }}</div></div>
      <div class="stat-card is-accent"><div class="label">实发合计</div><div class="value">¥{{ money(payroll.netTotal) }}</div></div>
      <div class="stat-card"><div class="label">代扣合计</div><div class="value">¥{{ money(deductTotal) }}</div>
        <div class="foot">社保 + 公积金 + 个税</div></div>
      <div class="stat-card" :class="payroll.missingAccount?.length ? 'is-danger' : 'is-success'">
        <div class="label">缺银行账号</div>
        <div class="value">{{ payroll.missingAccount?.length || 0 }}</div>
        <div class="foot">{{ payroll.missingAccount?.join('、') || '全部已补齐' }}</div>
      </div>
    </div>

    <div class="section-title">银行支付批次（单文件上限 ¥50,000）</div>
    <div class="table-card" style="margin-bottom: 16px">
      <el-table :data="batches.batches || []" size="small">
        <el-table-column label="批次" width="80">
          <template #default="{ row }">第 {{ row.index }} 批</template>
        </el-table-column>
        <el-table-column prop="count" label="人数" width="70" align="right" />
        <el-table-column label="金额合计" width="140" align="right">
          <template #default="{ row }"><span class="money" style="font-weight: 600">{{ money(row.total) }}</span></template>
        </el-table-column>
        <el-table-column label="人员" min-width="260">
          <template #default="{ row }">
            <span class="muted" style="font-size: 12px">{{ row.names.join('、') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="提示" width="150">
          <template #default="{ row }">
            <el-tag v-if="row.overLimit" size="small" type="danger">单笔超 5 万</el-tag>
            <el-tag v-else-if="row.missingAccount.length" size="small" type="warning">缺账号</el-tag>
            <el-tag v-else size="small" type="success">可上传</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="downloadTemplate(row.index)">下载银行模板</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div style="padding: 12px 4px 4px; display: flex; gap: 10px; align-items: center">
        <el-button v-if="can('payroll.manage') && payroll.status === 'DRAFT'" type="primary" @click="genPayments">
          生成付款单（按批次）
        </el-button>
        <el-button v-if="can('payroll.manage') && payroll.status === 'DRAFT'" @click="genPayments('PERSON')">
          生成付款单（一人一单）
        </el-button>
        <span class="muted" style="font-size: 12px">
          生成的付款单是草稿状态，需在「付款管理」里提交审批 → 审批通过 → 标记付款后才会产生流水。
        </span>
      </div>
    </div>

    <div v-if="payroll.payments?.length">
      <div class="section-title">关联付款单</div>
      <div class="table-card" style="margin-bottom: 16px">
        <el-table :data="payroll.payments" size="small">
          <el-table-column prop="code" label="付款编号" width="150" />
          <el-table-column prop="payeeName" label="收款方" min-width="200" />
          <el-table-column label="金额" width="130" align="right">
            <template #default="{ row }"><span class="money">{{ money(row.amount) }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="tagOf(PAYMENT_STATUS, row.status)">{{ labelOf(PAYMENT_STATUS, row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110">
            <template #default>
              <el-button link type="primary" @click="$router.push('/payments')">去付款管理</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <div class="section-title">
      工资明细
      <el-button v-if="can('payroll.manage') && payroll.status !== 'PAID'" link type="primary" @click="openItem()">
        + 手工添加
      </el-button>
    </div>
    <div class="table-card">
      <el-table :data="payroll.items || []" size="small">
        <el-table-column prop="name" label="姓名" width="100" />
        <el-table-column label="应发" width="110" align="right">
          <template #default="{ row }"><span class="money">{{ money(row.gross) }}</span></template>
        </el-table-column>
        <el-table-column label="代扣社保" width="100" align="right">
          <template #default="{ row }"><span class="money">{{ money(row.deductSocial) }}</span></template>
        </el-table-column>
        <el-table-column label="代扣公积金" width="105" align="right">
          <template #default="{ row }"><span class="money">{{ money(row.deductFund) }}</span></template>
        </el-table-column>
        <el-table-column label="代扣个税" width="100" align="right">
          <template #default="{ row }"><span class="money">{{ money(row.deductTax) }}</span></template>
        </el-table-column>
        <el-table-column label="实发" width="120" align="right">
          <template #default="{ row }"><span class="money" style="font-weight: 600">{{ money(row.net) }}</span></template>
        </el-table-column>
        <el-table-column label="银行账号" min-width="180">
          <template #default="{ row }">
            <span v-if="row.bankAccount" class="num">{{ row.bankAccount }}</span>
            <el-tag v-else size="small" type="danger">缺账号</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button v-if="can('payroll.manage') && payroll.status !== 'PAID'" link type="primary" @click="openItem(row)">编辑</el-button>
            <el-button v-if="can('payroll.manage') && payroll.status !== 'PAID'" link type="danger" @click="removeItem(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="itemVisible" :title="item.id ? '编辑工资明细' : '添加工资明细'" width="460px">
      <el-form :model="item" label-width="100px">
        <el-form-item label="姓名" required><el-input v-model="item.name" /></el-form-item>
        <el-form-item label="应发工资"><el-input-number v-model="item.gross" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item label="代扣社保"><el-input-number v-model="item.deductSocial" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item label="代扣公积金"><el-input-number v-model="item.deductFund" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item label="代扣个税"><el-input-number v-model="item.deductTax" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item label="实发工资">
          <el-input-number v-model="item.net" :precision="2" style="width: 100%" />
          <div class="muted" style="font-size: 12px">留空按「应发 − 三项代扣」自动算</div>
        </el-form-item>
        <el-form-item label="银行账号"><el-input v-model="item.bankAccount" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="itemVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveItem">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { download } from '@/api'
import { can } from '@/api/permissions'
import { PAYROLL_STATUS, PAYMENT_STATUS, labelOf, tagOf } from '@/constants'
import { money, date } from '@/utils/format'

const route = useRoute()
const id = route.params.id
const loading = ref(false)
const saving = ref(false)
const payroll = ref({})
const batches = ref({})
const itemVisible = ref(false)
const item = ref({})

const deductTotal = computed(() =>
  (payroll.value.items || []).reduce((s, i) => s + Number(i.deductSocial) + Number(i.deductFund) + Number(i.deductTax), 0)
)

async function load() {
  loading.value = true
  try {
    payroll.value = await api.payrolls.get(id)
    batches.value = await api.payrolls.bankBatches(id)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function importFile(f) {
  const fd = new FormData()
  fd.append('file', f.raw)
  loading.value = true
  try {
    const r = await api.payrolls.importFile(id, fd)
    ElMessage.success(`已导入 ${r.imported} 人${r.missingAccount.length ? `，其中 ${r.missingAccount.length} 人缺银行账号` : ''}`)
    load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function downloadTemplate(batch) {
  try {
    await download(api.payrolls.bankTemplateUrl(id), { batch }, `bank-${batch}.xls`)
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function genPayments(mode = 'BATCH') {
  await ElMessageBox.confirm(
    mode === 'BATCH'
      ? '按银行批次生成付款单（每批一张，与上传文件一一对应）'
      : '一人一张付款单，便于逐笔审批和对账',
    '生成付款单', { type: 'info' }
  )
  try {
    const r = await api.payrolls.generatePayments(id, { mode })
    ElMessage.success(`已生成 ${r.count} 张付款单`)
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

function openItem(row) {
  item.value = row
    ? { ...row, gross: Number(row.gross), deductSocial: Number(row.deductSocial), deductFund: Number(row.deductFund), deductTax: Number(row.deductTax), net: Number(row.net) }
    : { gross: 0, deductSocial: 0, deductFund: 0, deductTax: 0 }
  itemVisible.value = true
}

async function saveItem() {
  saving.value = true
  try {
    if (item.value.id) await api.payrolls.updateItem(item.value.id, item.value)
    else await api.payrolls.addItem(id, item.value)
    ElMessage.success('已保存')
    itemVisible.value = false
    load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function removeItem(row) {
  await ElMessageBox.confirm(`确认删除 ${row.name} 的工资明细？`, '确认', { type: 'warning' })
  try {
    await api.payrolls.removeItem(row.id)
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
</script>
