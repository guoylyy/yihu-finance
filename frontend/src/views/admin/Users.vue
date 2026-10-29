<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">用户管理</div>
        <div class="page-sub">角色决定能做什么，数据范围决定能看哪几家公司</div>
      </div>
      <el-button type="primary" @click="openForm()"><el-icon><Plus /></el-icon>新建用户</el-button>
    </div>

    <div class="table-card">
      <ResponsiveTable :data="list" v-loading="loading" size="small">
        <el-table-column prop="username" label="用户名" width="120" />
        <el-table-column prop="name" label="姓名" width="110" mobile="title" />
        <el-table-column label="角色" width="110" mobile="badge">
          <template #default="{ row }"><el-tag size="small" effect="plain">{{ ROLE_LABELS[row.role] || row.role }}</el-tag></template>
        </el-table-column>
        <el-table-column label="数据范围" min-width="180" mobile="full">
          <template #default="{ row }">
            <span v-if="!row.companyScope?.length" class="muted">全部公司</span>
            <span v-else>{{ row.companyScope.map(companyName).join('、') }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="phone" label="电话" width="130" />
        <el-table-column label="最近登录" width="150">
          <template #default="{ row }">{{ datetime(row.lastLoginAt) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="80" mobile="badge">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'ACTIVE' ? 'success' : 'info'">
              {{ row.status === 'ACTIVE' ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip mobile="full" />
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openForm(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">停用</el-button>
          </template>
        </el-table-column>
      </ResponsiveTable>
    </div>

    <el-dialog v-model="formVisible" :title="form.id ? '编辑用户' : '新建用户'" width="480px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="用户名" required>
          <el-input v-model="form.username" :disabled="!!form.id" />
        </el-form-item>
        <el-form-item label="姓名" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item :label="form.id ? '重置密码' : '密码'" :required="!form.id">
          <el-input v-model="form.password" type="password" show-password
                    :placeholder="form.id ? '留空表示不修改' : '至少 6 位'" />
        </el-form-item>
        <el-form-item label="角色" required>
          <el-select v-model="form.role" style="width: 100%">
            <el-option v-for="(label, value) in ROLE_LABELS" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="数据范围">
          <el-select v-model="form.companyScope" multiple clearable style="width: 100%" placeholder="留空 = 全部公司">
            <el-option v-for="c in companies" :key="c.id" :label="c.code" :value="String(c.id)" />
          </el-select>
        </el-form-item>
        <el-form-item label="电话"><el-input v-model="form.phone" type="tel" inputmode="tel" /></el-form-item>
        <el-form-item label="状态">
          <el-select v-model="form.status" style="width: 100%">
            <el-option label="启用" value="ACTIVE" /><el-option label="停用" value="DISABLED" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, onActivated } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api'
import { ROLE_LABELS } from '@/api/permissions'
import { companies, companyName, loadMeta } from '@/composables/useMeta'
import { datetime } from '@/utils/format'
import ResponsiveTable from '@/components/mobile/ResponsiveTable'
import { useViewport } from '@/composables/useViewport'

const { isMobile } = useViewport()

const loading = ref(false)
const saving = ref(false)
const list = ref([])
const formVisible = ref(false)
const form = ref({})

async function load() {
  loading.value = true
  try {
    list.value = (await api.users.list()).list
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function openForm(row) {
  form.value = row ? { ...row, password: '', companyScope: row.companyScope || [] } : { role: 'FINANCE', status: 'ACTIVE', companyScope: [] }
  formVisible.value = true
}

async function save() {
  saving.value = true
  try {
    if (form.value.id) await api.users.update(form.value.id, form.value)
    else await api.users.create(form.value)
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
  await ElMessageBox.confirm(`确认停用用户 ${row.username}？`, '确认', { type: 'warning' })
  try {
    await api.users.remove(row.id)
    ElMessage.success('已停用')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onActivated(() => load())
onMounted(async () => { await loadMeta(); load() })
</script>
