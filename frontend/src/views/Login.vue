<template>
  <div class="login-page">
    <div class="login-card">
      <div class="brand">
        <div class="mark">财</div>
        <div>
          <div class="brand-name">集团财务系统</div>
          <div class="brand-sub">钱在哪里 · 从哪来到哪去 · 未来够不够用</div>
        </div>
      </div>

      <!-- 部署在以虎 One 上：统一登录，自动跳转 -->
      <div v-if="mode?.platform && !mode.localLogin" class="sso">
        <el-icon class="is-loading"><Loading /></el-icon> 正在通过以虎 One 统一登录…
        <el-button link type="primary" @click="goSso">没有自动跳转？点这里</el-button>
      </div>

      <el-form v-else :model="form" @submit.prevent="submit">
        <el-form-item>
          <el-input v-model="form.username" size="large" placeholder="用户名" :prefix-icon="User"
                    autocomplete="username" autocapitalize="off" enterkeyhint="next" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" size="large" type="password" show-password
                    placeholder="密码" :prefix-icon="Lock" autocomplete="current-password" enterkeyhint="go"
                    @keyup.enter="submit" />
        </el-form-item>
        <el-checkbox v-model="form.remember" label="30 天内免登录" style="margin-bottom: 14px" />
        <el-button type="primary" size="large" style="width: 100%" :loading="loading" @click="submit">
          登录
        </el-button>
      </el-form>

      <div v-if="!mode?.platform" class="hint">
        默认账号：admin / admin123（管理者）· finance / finance123（财务）
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock, Loading } from '@element-plus/icons-vue'
import { BASE } from '@/api/base'
import api, { setToken, setUser } from '@/api'
import { setPermissions } from '@/api/permissions'

const router = useRouter()
const route = useRoute()
const loading = ref(false)
const form = ref({ username: '', password: '', remember: true })
const mode = ref(null)

function goSso() {
  const next = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard'
  location.href = `${BASE}/sso/login?next=${encodeURIComponent(next)}`
}

onMounted(async () => {
  mode.value = await api.auth.mode().catch(() => null)
  if (mode.value?.platform && !mode.value.localLogin) goSso()
})

async function submit() {
  if (!form.value.username || !form.value.password) return ElMessage.warning('请输入用户名和密码')
  loading.value = true
  try {
    const data = await api.auth.login(form.value)
    setToken(data.token)
    setUser(data.user)
    const me = await api.auth.me()
    setPermissions(me.permissions)
    ElMessage.success(`欢迎回来，${data.user.name}`)
    router.replace(route.query.redirect || '/dashboard')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  background:
    radial-gradient(900px 420px at 15% 0%, rgba(210, 82, 30, 0.07), transparent 60%),
    var(--bg);
  padding: 24px;
}
.login-card {
  width: 100%; max-width: 380px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 14px; padding: 34px 30px 24px;
}
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }
.mark {
  width: 40px; height: 40px; border-radius: 10px;
  background: var(--text); color: #faf9f7;
  display: grid; place-items: center; font-size: 18px; font-weight: 600;
}
.brand-name { font-size: 18px; font-weight: 600; }
.brand-sub { font-size: 12px; color: var(--text-muted); }
.sso { display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--text-muted); padding: 10px 0 4px; }
.hint {
  margin-top: 18px; font-size: 12px; color: var(--text-muted);
  text-align: center; line-height: 1.7;
}

/* 375px：不缩放即可登录；输入框 16px 防 iOS 聚焦放大（mobile.css 全局已设），按钮 48px */
@media (max-width: 768px) {
  .login-page {
    align-items: flex-start; padding: 16px;
    padding-top: calc(12vh + env(safe-area-inset-top)); padding-bottom: calc(16px + env(safe-area-inset-bottom));
    min-height: 100dvh;
  }
  .login-card { padding: 26px 20px 20px; }
  .brand-sub { font-size: 13px; }
  .login-card :deep(.el-button--large) { height: 48px; font-size: 16px; }
  .login-card :deep(.el-checkbox__label) { font-size: 14px; }
  .hint { font-size: 13px; word-break: break-all; }
}
</style>
