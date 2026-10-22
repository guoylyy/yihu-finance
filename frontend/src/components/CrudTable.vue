<!--
  通用台账页：筛选 + 列表 + 分页 + 新增/编辑弹窗 + 作废
  各模块只描述「列」和「表单字段」，业务动作用 #row-actions / #toolbar 插槽补。
-->
<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">{{ title }}</div>
        <div class="page-sub" v-if="subtitle">{{ subtitle }}</div>
      </div>
      <div>
        <slot name="toolbar" :reload="reload" :selection="selection" />
        <el-button v-if="canManage" type="primary" @click="openForm()">
          <el-icon><Plus /></el-icon>{{ addText }}
        </el-button>
      </div>
    </div>

    <slot name="stats" :list="list" :total="total" />

    <div class="filter-bar" v-if="filters.length || searchable">
      <template v-for="f in filters" :key="f.prop">
        <el-select v-if="f.type === 'select'" v-model="query[f.prop]" :placeholder="f.label" clearable
                   :style="{ width: (f.width || 140) + 'px' }" @change="reload">
          <el-option v-for="o in resolve(f.options)" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-date-picker v-else-if="f.type === 'daterange'" v-model="dateRange" type="daterange"
                        value-format="YYYY-MM-DD" start-placeholder="开始" end-placeholder="结束"
                        style="width: 230px" @change="onDateChange" />
        <el-input v-else v-model="query[f.prop]" :placeholder="f.label" clearable
                  :style="{ width: (f.width || 150) + 'px' }" @keyup.enter="reload" @clear="reload" />
      </template>
      <el-input v-if="searchable" v-model="query.keyword" :placeholder="searchPlaceholder" clearable
                style="width: 200px" @keyup.enter="reload" @clear="reload" />
      <el-button type="primary" @click="reload">查询</el-button>
      <el-button text @click="resetFilter">重置</el-button>
    </div>

    <div class="table-card">
      <el-table ref="tableRef" :data="list" v-loading="loading" size="small" :row-key="(r) => r.id"
                @selection-change="selection = $event">
        <el-table-column v-if="selectable" type="selection" width="40" />
        <el-table-column v-for="col in columns" :key="col.prop" :prop="col.prop" :label="col.label"
                         :width="col.width" :min-width="col.minWidth" :align="col.align"
                         :fixed="col.fixed" :show-overflow-tooltip="col.ellipsis">
          <template #default="{ row }">
            <slot :name="`col-${col.prop}`" :row="row">
              <span v-if="col.type === 'money'" class="money" :class="col.moneyClass?.(row)">
                {{ money(get(row, col.prop)) }}
              </span>
              <span v-else-if="col.type === 'date'">{{ date(get(row, col.prop)) }}</span>
              <span v-else-if="col.type === 'datetime'">{{ datetime(get(row, col.prop)) }}</span>
              <el-tag v-else-if="col.type === 'tag'" size="small" :type="tagOf(col.tagList, get(row, col.prop))">
                {{ labelOf(col.tagList, get(row, col.prop)) }}
              </el-tag>
              <span v-else-if="col.type === 'enum'">{{ labelOf(col.tagList, get(row, col.prop)) }}</span>
              <span v-else>{{ col.formatter ? col.formatter(row) : (get(row, col.prop) ?? '—') }}</span>
            </slot>
          </template>
        </el-table-column>

        <el-table-column v-if="canManage || $slots['row-actions']" label="操作"
                         :width="actionWidth" fixed="right">
          <template #default="{ row }">
            <slot name="row-actions" :row="row" :reload="reload" />
            <el-button v-if="canManage && !hideEdit" link type="primary" @click="openForm(row)">编辑</el-button>
            <el-button v-if="canManage && !hideDelete" link type="danger" @click="remove(row)">作废</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="total"
                       :page-sizes="[20, 50, 100]" layout="total, sizes, prev, pager, next" @change="load" />
      </div>
    </div>

    <el-dialog v-model="formVisible" :title="form.id ? `编辑${entityName}` : `新增${entityName}`" :width="dialogWidth">
      <el-form :model="form" label-width="100px">
        <el-form-item v-for="f in formFields" :key="f.prop" :label="f.label" :required="f.required">
          <el-select v-if="f.type === 'select'" v-model="form[f.prop]" :multiple="f.multiple" clearable
                     style="width: 100%" @change="f.onChange?.(form)">
            <el-option v-for="o in resolve(f.options, form)" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-date-picker v-else-if="f.type === 'date'" v-model="form[f.prop]" type="date"
                          value-format="YYYY-MM-DD" style="width: 100%" />
          <el-input-number v-else-if="f.type === 'money'" v-model="form[f.prop]" :precision="2" :step="100" style="width: 100%" />
          <el-input-number v-else-if="f.type === 'number'" v-model="form[f.prop]" style="width: 100%" />
          <el-switch v-else-if="f.type === 'switch'" v-model="form[f.prop]" />
          <el-input v-else-if="f.type === 'textarea'" v-model="form[f.prop]" type="textarea" :rows="2" />
          <el-input v-else v-model="form[f.prop]" :placeholder="f.placeholder" />
          <div v-if="f.hint" class="muted" style="font-size: 12px">{{ f.hint }}</div>
        </el-form-item>
        <slot name="form-extra" :form="form" />
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onActivated } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { labelOf, tagOf } from '@/constants'
import { money, date, datetime } from '@/utils/format'

const props = defineProps({
  api: { type: Object, required: true },
  title: String,
  subtitle: String,
  entityName: { type: String, default: '记录' },
  addText: { type: String, default: '新增' },
  columns: { type: Array, default: () => [] },
  formFields: { type: Array, default: () => [] },
  filters: { type: Array, default: () => [] },
  defaultForm: { type: Object, default: () => ({}) },
  extraQuery: { type: Object, default: () => ({}) },
  canManage: { type: Boolean, default: true },
  searchable: { type: Boolean, default: true },
  searchPlaceholder: { type: String, default: '搜索关键字' },
  actionWidth: { type: [Number, String], default: 150 },
  dialogWidth: { type: String, default: '520px' },
  selectable: Boolean,
  hideEdit: Boolean,
  hideDelete: Boolean,
  beforeSave: Function,
  // 保存成功后的回调：(row, form, isCreate) => Promise，用于顺带做后续动作
  afterSave: Function
})
const emit = defineEmits(['loaded'])

const loading = ref(false)
const saving = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const query = reactive({ keyword: '' })
const dateRange = ref([])
const formVisible = ref(false)
const form = ref({})
const selection = ref([])
const tableRef = ref(null)

const get = (row, path) => path.split('.').reduce((o, k) => o?.[k], row)
const resolve = (options, ctx) => (typeof options === 'function' ? options(ctx) : options || [])

async function load() {
  loading.value = true
  try {
    const data = await props.api.list({ ...props.extraQuery, ...query, page: page.value, page_size: pageSize.value })
    list.value = data.list
    total.value = data.total ?? data.list.length
    emit('loaded', data)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function reload() { page.value = 1; load() }

function onDateChange(v) {
  query.date_from = v?.[0] || ''
  query.date_to = v?.[1] || ''
  reload()
}

function resetFilter() {
  Object.keys(query).forEach((k) => (query[k] = ''))
  dateRange.value = []
  reload()
}

function openForm(row) {
  if (row) {
    const f = { ...row }
    // 后端返回的 BigInt 是字符串，Decimal 也是字符串，转成表单可用的类型
    for (const field of props.formFields) {
      const v = row[field.prop]
      if (v == null) continue
      if (field.type === 'money' || field.type === 'number') f[field.prop] = Number(v)
      if (field.type === 'date') f[field.prop] = String(v).slice(0, 10)
      if (field.type === 'select') f[field.prop] = String(v)
    }
    form.value = f
  } else {
    form.value = { ...props.defaultForm }
  }
  formVisible.value = true
}

async function save() {
  const payload = props.beforeSave ? props.beforeSave(form.value) : form.value
  if (!payload) return
  saving.value = true
  try {
    const isCreate = !payload.id
    const row = isCreate ? await props.api.create(payload) : await props.api.update(payload.id, payload)
    if (props.afterSave) await props.afterSave(row, payload, isCreate)
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
  await ElMessageBox.confirm(`确认作废这条${props.entityName}？作废后不再参与统计，但记录会保留。`, '确认', { type: 'warning' })
  try {
    await props.api.remove(row.id)
    ElMessage.success('已作废')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
// 列表页被 keep-alive 缓存着，从别的页面回来要重新拉一次，
// 否则会看到别处已经改过的旧数据（比如刚登记完回款，余额还是老的）
onActivated(load)
defineExpose({ reload, load, openForm, selection, clearSelection: () => tableRef.value?.clearSelection() })
</script>
