<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">工资管理</div>
        <div class="page-sub">导入工资表 → 校验银行账号 → 按单文件 5 万拆分银行模板 → 生成付款单</div>
      </div>
      <el-button v-if="can('payroll.manage')" type="primary" @click="createVisible = true">
        <el-icon><Plus /></el-icon>新建工资批次
      </el-button>
    </div>

    <FilterBar :active="['company_id', 'period', 'status'].filter((k) => q[k]).length">
      <el-select v-model="q.company_id" placeholder="全部公司" clearable style="width: 130px" @change="load">
        <el-option v-for="c in companies" :key="c.id" :label="c.code" :value="c.id" />
      </el-select>
      <el-select v-model="q.period" placeholder="全部月份" clearable style="width: 130px" @change="load">
        <el-option v-for="p in periods" :key="p" :label="p" :value="p" />
      </el-select>
      <el-select v-model="q.status" placeholder="全部状态" clearable style="width: 120px" @change="load">
        <el-option v-for="s in PAYROLL_STATUS" :key="s.value" :label="s.label" :value="s.value" />
      </el-select>
    </FilterBar>

    <div class="table-card">
      <ResponsiveTable :data="list" v-loading="loading" size="small">
        <el-table-column prop="code" label="批次编号" width="150" />
        <el-table-column prop="company.code" label="公司" width="110" />
        <el-table-column prop="period" label="工资月份" width="100" />
        <el-table-column prop="title" label="标题" min-width="150" mobile="title" />
        <el-table-column label="人数" width="70" align="right">
          <template #default="{ row }">{{ row.personCount }}</template>
        </el-table-column>
        <el-table-column label="应发合计" width="130" align="right">
          <template #default="{ row }"><span class="money">{{ money(row.grossTotal) }}</span></template>
        </el-table-column>
        <el-table-column label="实发合计" width="130" align="right" mobile="amount">
          <template #default="{ row }"><span class="money" style="font-weight: 600">{{ money(row.netTotal) }}</span></template>
        </el-table-column>
        <el-table-column label="发薪日" width="110">
          <template #default="{ row }">{{ date(row.payDate) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90" mobile="badge">
          <template #default="{ row }">
            <el-tag size="small" :type="tagOf(PAYROLL_STATUS, row.status)">{{ labelOf(PAYROLL_STATUS, row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="$router.push(`/payrolls/${row.id}`)">明细 / 模板</el-button>
          </template>
        </el-table-column>
      </ResponsiveTable>
      <div class="pager">
        <ResponsivePager v-model:current-page="page" :page-size="20" :total="total" layout="total, prev, pager, next" @change="load" />
      </div>
    </div>

    <el-dialog v-model="createVisible" title="新建工资批次" width="440px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="公司" required>
          <el-select v-model="form.companyId" style="width: 100%">
            <el-option v-for="c in companies" :key="c.id" :label="c.code" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="工资月份" required>
          <el-select v-model="form.period" style="width: 100%">
            <el-option v-for="p in periods" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题"><el-input v-model="form.title" placeholder="默认「YYYY-MM 工资」" /></el-form-item>
        <el-form-item label="计划发薪日">
          <el-date-picker v-model="form.payDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="create">创建并进入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api from '@/api'
import { can } from '@/api/permissions'
import { companies, loadMeta } from '@/composables/useMeta'
import { PAYROLL_STATUS, labelOf, tagOf } from '@/constants'
import { money, date, periodOptions, currentPeriod } from '@/utils/format'
import ResponsiveTable from '@/components/mobile/ResponsiveTable'
import FilterBar from '@/components/mobile/FilterBar.vue'
import { useViewport } from '@/composables/useViewport'
import ResponsivePager from '@/components/mobile/ResponsivePager'

const { isMobile } = useViewport()

const router = useRouter()
const loading = ref(false)
const saving = ref(false)
const createVisible = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const periods = periodOptions(18)
const q = reactive({ company_id: '', period: '', status: '' })
const form = ref({ period: currentPeriod() })

async function load() {
  loading.value = true
  try {
    const data = await api.payrolls.list({ ...q, page: page.value, page_size: 20 })
    list.value = data.list
    total.value = data.total
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function create() {
  saving.value = true
  try {
    const row = await api.payrolls.create(form.value)
    ElMessage.success('已创建，接下来导入工资表')
    createVisible.value = false
    router.push(`/payrolls/${row.id}`)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

onActivated(() => load())
onMounted(async () => {
  await loadMeta()
  form.value.companyId = companies.value[0]?.id
  load()
})
</script>
