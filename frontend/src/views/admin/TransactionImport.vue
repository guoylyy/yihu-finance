<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">导入银行流水</div>
        <div class="page-sub">支持 CSV / XLS / XLSX，自动识别表头、猜业务类型、按账户查重</div>
      </div>
      <el-button @click="$router.push('/transactions')">返回流水列表</el-button>
    </div>

    <el-steps :active="step" align-center finish-status="success" style="margin-bottom: 18px">
      <el-step title="选择账户与文件" />
      <el-step title="核对与分类" />
      <el-step title="导入完成" />
    </el-steps>

    <!-- 第一步 -->
    <div v-if="step === 0" class="table-card" style="padding: 20px">
      <el-form label-width="100px" style="max-width: 560px">
        <el-form-item label="导入到公司">
          <el-select v-model="companyId" style="width: 100%" @change="accountId = null">
            <el-option v-for="c in companies" :key="c.id" :label="c.code" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="导入到账户">
          <el-select v-model="accountId" style="width: 100%" placeholder="选择账户">
            <el-option v-for="a in accountsOf(companyId)" :key="a.id"
                       :label="`${a.name}（${a.currency}｜余额 ${money(a.balance)}）`" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="流水文件">
          <el-upload :auto-upload="false" :show-file-list="true" :limit="1" drag
                     :on-change="onFileChange" :on-remove="() => (file = null)" style="width: 100%">
            <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
            <div class="el-upload__text">把银行导出的流水文件拖到这里，或<em>点击选择</em></div>
            <template #tip>
              <div class="el-upload__tip">
                常见网银格式会自动识别「交易日期 / 金额 / 收入支出 / 对方户名 / 摘要」；
                没有表头或列名不常规的文件，下一步可以手工指定哪一列是什么。
              </div>
            </template>
          </el-upload>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="loading" :disabled="!file || !accountId" @click="preview">
            解析并预览
          </el-button>
        </el-form-item>
      </el-form>
    </div>

    <!-- 第二步 -->
    <div v-if="step === 1">
      <el-alert v-if="beforeBaseCount" type="error" :closable="false" style="margin-bottom: 12px"
                :title="`有 ${beforeBaseCount} 条流水早于该账户的期初余额基准日（${baseDate}）`">
        <div style="font-size: 12px; line-height: 1.7">
          期初余额是「基准日当天的账面余额」，已经包含了那天之前发生的所有收支。
          再把基准日之前的流水导进来，余额会被重复计算。
          建议用下面的「只导入此日期之后」把它们排除，或者先去账户管理把期初余额改成更早日期的数。
        </div>
      </el-alert>

      <div class="stat-grid">
        <div class="stat-card"><div class="label">解析到</div><div class="value">{{ rows.length }}</div><div class="foot">条流水</div></div>
        <div class="stat-card is-danger"><div class="label">完全重复</div><div class="value">{{ dupCount }}</div><div class="foot">同一笔已导过</div></div>
        <div class="stat-card is-accent"><div class="label">疑似重复</div><div class="value">{{ similarCount }}</div><div class="foot">同日同额，已手工记过</div></div>
        <div class="stat-card is-success"><div class="label">收入合计</div><div class="value">¥{{ money(sumBy('IN')) }}</div>
          <div class="foot">按当前日期范围</div></div>
        <div class="stat-card is-danger"><div class="label">支出合计</div><div class="value">¥{{ money(sumBy('OUT')) }}</div>
          <div class="foot">按当前日期范围</div></div>
      </div>

      <el-alert v-if="headerMode !== 'HEADER'" :closable="false" type="warning" style="margin-bottom: 12px"
                :title="headerMode === 'INFERRED'
                  ? '这个文件没有表头，下面的列是按数据形态猜的，请核对一下再导入'
                  : '当前用的是你手工指定的列'" />

      <div v-if="headerMode !== 'HEADER' || showMapping" class="table-card" style="margin-bottom: 12px; padding: 14px">
        <div class="section-title" style="margin-top: 0">手工指定列</div>
        <div class="map-grid">
          <div class="map-item">
            <label>日期列 <span class="req">*</span></label>
            <el-select v-model="mapping.date" size="small" placeholder="选列"><el-option v-for="o in colOptions" :key="o.value" :label="o.label" :value="o.value" /></el-select>
          </div>
          <div class="map-item">
            <label>金额列（含正负）</label>
            <el-select v-model="mapping.amount" size="small" clearable placeholder="选列"><el-option v-for="o in colOptions" :key="o.value" :label="o.label" :value="o.value" /></el-select>
          </div>
          <div class="map-item">
            <label>收入列</label>
            <el-select v-model="mapping.income" size="small" clearable placeholder="收支分两列时用"><el-option v-for="o in colOptions" :key="o.value" :label="o.label" :value="o.value" /></el-select>
          </div>
          <div class="map-item">
            <label>支出列</label>
            <el-select v-model="mapping.expense" size="small" clearable placeholder="收支分两列时用"><el-option v-for="o in colOptions" :key="o.value" :label="o.label" :value="o.value" /></el-select>
          </div>
          <div class="map-item">
            <label>对方名称</label>
            <el-select v-model="mapping.counterparty" size="small" clearable placeholder="选列"><el-option v-for="o in colOptions" :key="o.value" :label="o.label" :value="o.value" /></el-select>
          </div>
          <div class="map-item">
            <label>摘要 / 用途</label>
            <el-select v-model="mapping.summary" size="small" clearable placeholder="选列"><el-option v-for="o in colOptions" :key="o.value" :label="o.label" :value="o.value" /></el-select>
          </div>
          <div class="map-item">
            <label>对方账号</label>
            <el-select v-model="mapping.counterAccount" size="small" clearable placeholder="选列"><el-option v-for="o in colOptions" :key="o.value" :label="o.label" :value="o.value" /></el-select>
          </div>
          <div class="map-item">
            <label>收支方向</label>
            <el-select v-model="mapping.direction" size="small">
              <el-option label="按金额正负" value="SIGN" />
              <el-option label="全部算收入" value="ALL_IN" />
              <el-option label="全部算支出" value="ALL_OUT" />
            </el-select>
          </div>
          <div class="map-item">
            <label>表头在第几行</label>
            <el-input-number v-model="mapping.headerRow" size="small" :min="-1" :max="30" controls-position="right" />
          </div>
        </div>

        <div class="sample-wrap" v-if="sample.length">
          <table class="sample">
            <tr>
              <th>行</th>
              <th v-for="(c, i) in sampleCols" :key="i" :class="usedCols.includes(i) ? 'used' : ''">
                第{{ i + 1 }}列<span v-if="colRole(i)" class="role">{{ colRole(i) }}</span>
              </th>
            </tr>
            <tr v-for="(row, ri) in sample" :key="ri">
              <td class="muted">{{ ri + 1 }}</td>
              <td v-for="(c, i) in sampleCols" :key="i" :class="usedCols.includes(i) ? 'used' : ''">{{ row[i] }}</td>
            </tr>
          </table>
        </div>

        <el-button type="primary" size="small" style="margin-top: 10px" :loading="loading" @click="preview">
          按这个映射重新解析
        </el-button>
        <span class="muted" style="font-size: 12px; margin-left: 10px">
          「表头在第几行」填 -1 表示整个文件都是数据、没有表头
        </span>
      </div>

      <div class="filter-bar">
        <span class="muted" style="font-size: 13px">只导入此日期之后</span>
        <el-date-picker v-model="dateFrom" type="date" value-format="YYYY-MM-DD" style="width: 150px"
                        placeholder="不限" size="small" clearable />
        <span class="muted" style="font-size: 13px">至</span>
        <el-date-picker v-model="dateTo" type="date" value-format="YYYY-MM-DD" style="width: 150px"
                        placeholder="不限" size="small" clearable />
        <el-divider direction="vertical" />
        <el-checkbox v-model="skipDuplicate">跳过完全重复</el-checkbox>
        <el-checkbox v-model="skipSimilar">跳过疑似重复</el-checkbox>
        <el-button size="small" text @click="showMapping = !showMapping">
          {{ showMapping ? '收起列映射' : '调整列映射' }}
        </el-button>
        <el-select v-model="bulkBizType" placeholder="把选中行改为…" clearable size="small" style="width: 160px">
          <el-option v-for="b in BIZ_TYPES" :key="b.value" :label="b.label" :value="b.value" />
        </el-select>
        <el-button size="small" :disabled="!selection.length || !bulkBizType" @click="applyBulk">
          应用到选中 {{ selection.length }} 行
        </el-button>
        <div style="flex: 1"></div>
        <el-button @click="step = 0">上一步</el-button>
        <el-button type="primary" :loading="loading" @click="commit">确认导入</el-button>
      </div>

      <div class="table-card">
        <div v-if="rowsToImport.length !== rows.length" class="muted" style="font-size: 12px; padding: 8px 4px 0">
          实际将导入 <b>{{ rowsToImport.length }}</b> 条（共解析到 {{ rows.length }} 条，
          已按日期范围与重复设置排除 {{ rows.length - rowsToImport.length }} 条）
        </div>
        <el-table :data="visibleRows" size="small" max-height="520" @selection-change="selection = $event"
                  :row-class-name="({ row }) => (row.duplicate ? 'dup-row' : row.similar ? 'similar-row' : '')">
          <el-table-column type="selection" width="40" />
          <el-table-column prop="txnDate" label="日期" width="100" />
          <el-table-column label="收支" width="70">
            <template #default="{ row }">
              <el-tag size="small" :type="row.direction === 'IN' ? 'success' : 'danger'" effect="plain">
                {{ row.direction === 'IN' ? '收' : '支' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="金额" width="120" align="right">
            <template #default="{ row }"><span class="money">{{ money(row.amount) }}</span></template>
          </el-table-column>
          <el-table-column prop="counterparty" label="对方名称" min-width="150" />
          <el-table-column prop="summary" label="摘要 / 用途" min-width="180" />
          <el-table-column label="业务类型" width="150">
            <template #default="{ row }">
              <el-select v-model="row.bizType" size="small">
                <el-option v-for="b in BIZ_TYPES" :key="b.value" :label="b.label" :value="b.value" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="核对" min-width="230">
            <template #default="{ row }">
              <el-tag v-if="row.duplicate" size="small" type="danger">已导过 {{ row.duplicateOf }}</el-tag>
              <el-tag v-else-if="row.similar" size="small" type="warning" effect="plain">
                疑似已记：{{ row.similarOf }}
              </el-tag>
              <el-tag v-else-if="row.matchedPayment" size="small" type="success" effect="plain">
                对应 {{ row.matchedPayment }}
              </el-tag>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <!-- 第三步 -->
    <div v-if="step === 2" class="table-card" style="padding: 30px; text-align: center">
      <el-result icon="success" :title="`导入成功 ${result.success} 笔`"
                 :sub-title="`跳过 ${result.skip} 笔（重复或已锁定月份）`">
        <template #extra>
          <el-button type="primary" @click="$router.push('/transactions')">去查看流水</el-button>
          <el-button @click="restart">继续导入</el-button>
        </template>
      </el-result>
      <el-alert v-if="result.errors?.length" type="warning" :closable="false" style="text-align: left">
        <div v-for="(e, i) in result.errors" :key="i" style="font-size: 12px">{{ e }}</div>
      </el-alert>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api'
import { companies, accounts, accountsOf, loadMeta } from '@/composables/useMeta'
import { BIZ_TYPES } from '@/constants'
import { money } from '@/utils/format'

const step = ref(0)
const loading = ref(false)
const companyId = ref('')
const accountId = ref('')
const file = ref(null)
const rows = ref([])
const selection = ref([])
const skipDuplicate = ref(true)
const skipSimilar = ref(true)
const bulkBizType = ref('')
const result = ref({})
const fileName = ref('')
const headerMode = ref('HEADER')
const showMapping = ref(false)
const sample = ref([])
const columnCount = ref(0)
const mapping = ref({ direction: 'SIGN', headerRow: -1 })

const ROLE_LABEL = { date: '日期', amount: '金额', income: '收入', expense: '支出', counterparty: '对方', summary: '摘要', counterAccount: '对方账号' }
const colOptions = computed(() =>
  Array.from({ length: columnCount.value }, (_, i) => ({
    value: i,
    // 选项里带上示例值，不用数第几列
    label: `第${i + 1}列　${String(sample.value.find((r) => r[i])?.[i] || '').slice(0, 14)}`
  }))
)
const sampleCols = computed(() => Array.from({ length: columnCount.value }, (_, i) => i))
const usedCols = computed(() => Object.entries(mapping.value)
  .filter(([k, v]) => ROLE_LABEL[k] && v != null && v !== '')
  .map(([, v]) => Number(v)))
function colRole(i) {
  const hit = Object.entries(mapping.value).find(([k, v]) => ROLE_LABEL[k] && Number(v) === i)
  return hit ? ROLE_LABEL[hit[0]] : ''
}

const dateFrom = ref('')
const dateTo = ref('')

// 只导入日期范围内的流水：银行导出常常是一大段时间，而账户期初余额只对得上某个基准日之后
const visibleRows = computed(() => rows.value.filter((r) =>
  (!dateFrom.value || r.txnDate >= dateFrom.value) && (!dateTo.value || r.txnDate <= dateTo.value)
))
const dupCount = computed(() => visibleRows.value.filter((r) => r.duplicate).length)
const similarCount = computed(() => visibleRows.value.filter((r) => r.similar).length)
// 真正要提交的行：疑似重复默认排除，避免和手工记过的那笔重复计账
const rowsToImport = computed(() => visibleRows.value.filter((r) => !(skipSimilar.value && r.similar)))
const sumBy = (dir) => visibleRows.value.filter((r) => r.direction === dir).reduce((s, r) => s + Number(r.amount), 0)

// 该账户的期初余额基准日，早于它的流水会造成余额重复计算
const baseDate = computed(() => {
  const a = accounts.value.find((x) => String(x.id) === String(accountId.value))
  return a?.initialDate ? String(a.initialDate).slice(0, 10) : ''
})
const beforeBaseCount = computed(() =>
  baseDate.value ? visibleRows.value.filter((r) => r.txnDate < baseDate.value).length : 0
)

function onFileChange(f) { file.value = f.raw; fileName.value = f.name }

async function preview(useMapping = false) {
  loading.value = true
  try {
    const fd = new FormData()
    fd.append('file', file.value)
    fd.append('accountId', accountId.value)
    // 第一次让后端自己认；用户调过映射之后带上映射重新解析
    if (useMapping === true || step.value === 1) {
      const m = { ...mapping.value }
      for (const k of Object.keys(m)) if (m[k] === '' || m[k] == null) delete m[k]
      fd.append('mapping', JSON.stringify(m))
    }
    const data = await api.transactions.importPreview(fd)
    rows.value = data.rows
    fileName.value = data.fileName
    headerMode.value = data.headerMode
    sample.value = data.sample || []
    columnCount.value = data.columnCount || 0
    // 把后端认出来/猜出来的列回填到界面，用户在这个基础上改
    mapping.value = {
      ...mapping.value,
      ...data.columns,
      headerRow: data.headerRow >= 0 ? data.headerRow : -1
    }
    if (!rows.value.length) {
      showMapping.value = true
      step.value = 1
      return ElMessage.warning('没有解析到有效流水，请在「手工指定列」里核对日期列和金额列')
    }
    step.value = 1
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function applyBulk() {
  for (const r of selection.value) r.bizType = bulkBizType.value
  ElMessage.success(`已更新 ${selection.value.length} 行`)
}

async function commit() {
  loading.value = true
  try {
    const before = visibleRows.value.length
    result.value = await api.transactions.importCommit({
      accountId: accountId.value, fileName: fileName.value,
      rows: rowsToImport.value, skipDuplicate: skipDuplicate.value
    })
    await loadMeta(true)   // 账户余额变了，刷新缓存
    step.value = 2
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function restart() {
  step.value = 0; rows.value = []; file.value = null; result.value = {}
  dateFrom.value = ''; dateTo.value = ''
  headerMode.value = 'HEADER'; showMapping.value = false
  mapping.value = { direction: 'SIGN', headerRow: -1 }
}

onMounted(async () => {
  await loadMeta()
  companyId.value = companies.value[0]?.id || ''
})
</script>

<style scoped>
:deep(.dup-row) { background: #fdf3f2; }
:deep(.similar-row) { background: #fdf8f2; }

.map-grid {
  display: grid; gap: 10px 14px; margin-bottom: 12px;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
}
.map-item { display: flex; flex-direction: column; gap: 4px; }
.map-item label { font-size: 12px; color: var(--text-muted); }
.map-item .req { color: var(--danger); }
.map-item :deep(.el-select), .map-item :deep(.el-input-number) { width: 100%; }

.sample-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
table.sample { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
table.sample th, table.sample td {
  border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);
  padding: 5px 9px; text-align: left; max-width: 190px; overflow: hidden; text-overflow: ellipsis;
}
table.sample th { background: #faf9f7; color: var(--text-muted); font-weight: 600; }
table.sample .used { background: #fdf5f1; }
table.sample th.used { color: var(--accent); }
table.sample .role { margin-left: 5px; color: var(--accent); font-weight: 700; }
</style>
