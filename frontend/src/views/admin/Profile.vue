<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">个人中心</div>
        <div class="page-sub">账号信息与密码</div>
      </div>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="12">
        <div class="table-card" style="padding: 18px">
          <div class="section-title" style="margin-top: 0">账号信息</div>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="用户名">{{ user?.username }}</el-descriptions-item>
            <el-descriptions-item label="姓名">{{ user?.name }}</el-descriptions-item>
            <el-descriptions-item label="角色">{{ ROLE_LABELS[user?.role] || user?.role }}</el-descriptions-item>
            <el-descriptions-item label="数据范围">
              {{ user?.companyScope?.length ? user.companyScope.map(companyName).join('、') : '全部公司' }}
            </el-descriptions-item>
          </el-descriptions>

          <div class="section-title">我的权限（{{ perms.length }} 项）</div>
          <div class="perm-list">
            <el-tag v-for="p in perms" :key="p" size="small" effect="plain" style="margin: 0 6px 6px 0">{{ p }}</el-tag>
          </div>
        </div>
      </el-col>

      <el-col :xs="24" :md="12">
        <div class="table-card" style="padding: 18px">
          <div class="section-title" style="margin-top: 0">修改密码</div>
          <el-form :model="form" label-width="100px" style="max-width: 380px">
            <el-form-item label="原密码"><el-input v-model="form.oldPassword" type="password" show-password /></el-form-item>
            <el-form-item label="新密码"><el-input v-model="form.newPassword" type="password" show-password /></el-form-item>
            <el-form-item label="确认新密码"><el-input v-model="form.confirm" type="password" show-password /></el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
            </el-form-item>
          </el-form>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api, { getUser } from '@/api'
import { ROLE_LABELS } from '@/api/permissions'
import { companyName, loadMeta } from '@/composables/useMeta'

const user = ref(getUser())
const perms = ref([])
const saving = ref(false)
const form = ref({})

async function submit() {
  if (form.value.newPassword !== form.value.confirm) return ElMessage.warning('两次输入的新密码不一致')
  saving.value = true
  try {
    await api.auth.changePassword(form.value)
    ElMessage.success('密码已修改')
    form.value = {}
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await loadMeta()
  const me = await api.auth.me()
  user.value = me.user
  perms.value = me.permissions
})
</script>

<style scoped>
.perm-list { max-height: 260px; overflow-y: auto; }
</style>
