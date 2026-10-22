<template>
  <div class="sso-done">
    <div v-if="error" class="box">
      <div class="title">登录没有完成</div>
      <div class="msg">{{ error }}</div>
      <el-button type="primary" @click="retry">重新登录</el-button>
    </div>
    <div v-else class="box"><el-icon class="is-loading"><Loading /></el-icon> 正在进入集团财务…</div>
  </div>
</template>

<script setup>
// 以虎 One 统一登录回来的落地页：后端把本系统的 token 放在 # 后面（不进服务器日志），取出来存好再进系统
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Loading } from '@element-plus/icons-vue'
import api, { setToken, setUser, clearAuth } from '@/api'
import { setPermissions } from '@/api/permissions'
import { BASE, setPlatformHome } from '@/api/base'

const router = useRouter()
const error = ref('')

onMounted(async () => {
  const p = new URLSearchParams(location.hash.slice(1))
  history.replaceState(null, '', location.pathname) // 把 token 从地址栏去掉
  const token = p.get('token')
  if (!token) { error.value = '没有拿到登录凭证'; return }
  try {
    setToken(token)
    const me = await api.auth.me()
    setUser(me.user)
    setPermissions(me.permissions)
    const mode = await api.auth.mode().catch(() => null)
    setPlatformHome(mode?.homeUrl || '')
    const next = p.get('next')
    router.replace(next && next.startsWith('/') && !next.startsWith('/login') && !next.startsWith('/sso') ? next : '/dashboard')
  } catch (e) {
    clearAuth()
    error.value = e.message
  }
})

function retry() {
  location.href = `${BASE}/sso/login`
}
</script>

<style scoped>
.sso-done { min-height: 100vh; display: grid; place-items: center; background: var(--bg); padding: 24px; }
.box { text-align: center; color: var(--text-muted); display: flex; flex-direction: column; align-items: center; gap: 12px; }
.title { font-size: 18px; font-weight: 600; color: var(--text); }
</style>
