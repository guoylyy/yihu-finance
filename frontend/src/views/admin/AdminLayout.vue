<template>
  <el-container class="layout">
    <!-- 桌面 212px 侧栏；平板（≤1024）收成 64px 图标栏，子菜单浮层展开；手机（≤768）改为抽屉 -->
    <el-aside v-if="!isMobile" :width="isTablet ? '64px' : '212px'" class="sidebar" :class="{ 'is-collapsed': isTablet }">
      <div class="logo">
        <div class="mark">财</div>
        <div v-if="!isTablet" class="logo-text">
          <div class="logo-name">集团财务</div>
          <div class="logo-sub">FINANCE</div>
        </div>
      </div>
      <NavMenu :collapse="isTablet" />
    </el-aside>

    <el-drawer v-else v-model="navOpen" direction="ltr" size="min(300px, 82vw)" :with-header="false"
               class="m-nav-drawer" append-to-body>
      <div class="logo">
        <div class="mark">财</div>
        <div class="logo-text">
          <div class="logo-name">集团财务</div>
          <div class="logo-sub">FINANCE</div>
        </div>
        <el-button text circle class="m-nav-close" aria-label="收起导航" @click="navOpen = false">
          <el-icon :size="18"><Close /></el-icon>
        </el-button>
      </div>
      <NavMenu @select="navOpen = false" />
    </el-drawer>

    <el-container class="main-col">
      <el-header class="topbar">
        <div class="crumb">
          <el-button v-if="isMobile" text circle class="m-menu-btn" aria-label="打开导航" @click="navOpen = true">
            <el-icon :size="20"><Expand /></el-icon>
          </el-button>
          <span class="title">{{ route.meta.title || '集团财务系统' }}</span>
          <el-tag v-if="anomalyCount && !isMobile" type="danger" effect="plain" size="small"
                  style="cursor: pointer" @click="router.push('/anomalies')">
            {{ anomalyCount }} 项待处理
          </el-tag>
        </div>
        <div class="right">
          <template v-if="!isMobile">
            <el-tooltip v-if="can('finance.view')" placement="bottom"
                        :content="assistant.status.available ? (assistant.open ? '收起录入助手' : '打开录入助手') : `录入助手不可用：${assistant.status.reason}`">
              <span>
                <el-button text circle :disabled="!assistant.status.available"
                           :class="{ 'is-on': assistant.open && assistant.status.available }"
                           @click="assistant.open = !assistant.open">
                  <el-icon :size="17"><ChatDotRound /></el-icon>
                </el-button>
              </span>
            </el-tooltip>
            <el-tooltip content="使用手册与每月 SOP" placement="bottom">
              <el-button text circle @click="router.push('/guide')">
                <el-icon :size="17"><QuestionFilled /></el-icon>
              </el-button>
            </el-tooltip>
          </template>
          <!-- 手机端顶栏只留「菜单 / 标题 / 头像」，助手、异常、手册收进头像下拉 -->
          <el-dropdown :trigger="isMobile ? 'click' : 'hover'" @command="onCommand">
            <span class="user">
              <el-badge v-if="isMobile" is-dot :hidden="!anomalyCount" class="m-avatar">
                <el-avatar :size="32" style="background: var(--text)">{{ user?.name?.[0] || 'U' }}</el-avatar>
              </el-badge>
              <template v-else>
                <el-avatar :size="26" style="background: var(--text)">{{ user?.name?.[0] || 'U' }}</el-avatar>
                <span class="uname">{{ user?.name }}</span>
                <el-tag size="small" effect="plain">{{ ROLE_LABELS[user?.role] || user?.role }}</el-tag>
                <el-icon><ArrowDown /></el-icon>
              </template>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <template v-if="isMobile">
                  <el-dropdown-item disabled class="m-user-line">
                    {{ user?.name }} · {{ ROLE_LABELS[user?.role] || user?.role }}
                  </el-dropdown-item>
                  <el-dropdown-item v-if="can('finance.view')" command="assistant" :disabled="!assistant.status.available" divided>
                    <el-icon><ChatDotRound /></el-icon>{{ assistant.status.available ? '录入助手' : '录入助手（不可用）' }}
                  </el-dropdown-item>
                  <el-dropdown-item v-if="anomalyCount" command="anomalies">
                    <el-icon><Warning /></el-icon>异常清单 <span class="money-out">（{{ anomalyCount }} 项待处理）</span>
                  </el-dropdown-item>
                  <el-dropdown-item command="guide"><el-icon><QuestionFilled /></el-icon>使用手册</el-dropdown-item>
                </template>
                <el-dropdown-item command="profile" :divided="isMobile">个人中心</el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="main">
        <router-view v-slot="{ Component }">
          <keep-alive :max="6"><component :is="Component" :key="route.path" /></keep-alive>
        </router-view>
      </el-main>
    </el-container>

    <AssistantDrawer v-if="can('finance.view') && assistant.open && assistant.status.available" />
  </el-container>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api, { getUser, clearAuth } from '@/api'
import { can, setPermissions, ROLE_LABELS } from '@/api/permissions'
import { loadMeta, resetMeta } from '@/composables/useMeta'
import { getPlatformHome } from '@/api/base'
import AssistantDrawer from '@/components/AssistantDrawer.vue'
import NavMenu from './NavMenu.vue'
import { useViewport } from '@/composables/useViewport'
import { useAssistantStore } from '@/stores/assistant'

const route = useRoute()
const router = useRouter()
const user = ref(getUser())
const anomalyCount = ref(0)
const assistant = useAssistantStore()
const { isMobile, isTablet } = useViewport()
const navOpen = ref(false)

onMounted(async () => {
  try {
    const me = await api.auth.me()
    setPermissions(me.permissions)
    user.value = me.user
    await loadMeta()
    if (can('finance.view')) loadAssistantStatus()
    const a = await api.ai.anomalies()
    anomalyCount.value = a.anomalies.filter((x) => x.level !== 'info').length
  } catch (e) {
    if (!String(e.message).includes('未登录')) ElMessage.warning(e.message)
  }
})

// 录入助手是否可用（平台没配模型时入口置灰并说明原因）
async function loadAssistantStatus() {
  try {
    const s = await api.assistant.status()
    assistant.status = { available: s.available, reason: s.reason || '', stub: !!s.stub }
  } catch (e) {
    assistant.status = { available: false, reason: e.message }
  }
}

function onCommand(cmd) {
  if (cmd === 'profile') return router.push('/profile')
  if (cmd === 'guide') return router.push('/guide')
  if (cmd === 'anomalies') return router.push('/anomalies')
  if (cmd === 'assistant') { assistant.open = true; return }
  if (cmd === 'logout') {
    clearAuth()
    resetMeta()
    // 从以虎 One 进来的：回到平台工作台（留在这里会被自动再登录一次）
    const home = getPlatformHome()
    if (home) location.href = home
    else router.replace('/login')
  }
}
</script>

<style scoped>
.layout { height: 100vh; }
.main-col { min-width: 0; }
.sidebar {
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
}
.logo {
  display: flex; align-items: center; gap: 10px;
  padding: 18px 18px 14px; border-bottom: 1px solid var(--border);
}
.mark {
  width: 30px; height: 30px; border-radius: 8px;
  background: var(--text); color: #faf9f7;
  display: grid; place-items: center; font-size: 14px; font-weight: 600;
}
.logo-name { font-size: 15px; font-weight: 600; line-height: 1.2; }
.logo-sub {
  font-family: var(--font-num); font-size: 10px; letter-spacing: 0.18em;
  color: var(--accent); font-weight: 700;
}

.topbar {
  height: 56px; background: var(--surface); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; padding: 0 20px;
}
.crumb { display: flex; align-items: center; gap: 10px; }
.title { font-size: 15px; font-weight: 600; }
.user { display: flex; align-items: center; gap: 8px; cursor: pointer; outline: none; }
.uname { font-size: 14px; }
.main { background: var(--bg); padding: 18px 20px; overflow-y: auto; }
.right { display: flex; align-items: center; gap: 4px; }
.right .is-on { color: var(--accent); }

/* 平板：图标栏 */
.sidebar.is-collapsed .logo { justify-content: center; padding: 18px 0 14px; }

/* 手机 */
@media (max-width: 768px) {
  .layout { height: 100dvh; }
  .topbar { height: 52px; padding: 0 6px 0 4px; padding-left: max(4px, env(safe-area-inset-left)); padding-right: max(6px, env(safe-area-inset-right)); }
  .crumb { min-width: 0; flex: 1; gap: 4px; }
  .title { font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .m-menu-btn { flex-shrink: 0; }
  .user { min-width: 44px; min-height: 44px; justify-content: center; }
  .main { padding: 12px 12px calc(16px + env(safe-area-inset-bottom)); }
}
</style>

<!-- 导航抽屉 append 到 body，scoped 样式够不到 -->
<style>
.m-nav-drawer .el-drawer__body { padding: 0; display: flex; flex-direction: column; padding-bottom: env(safe-area-inset-bottom); }
.m-nav-drawer .logo {
  display: flex; align-items: center; gap: 10px;
  padding: calc(14px + env(safe-area-inset-top)) 8px 12px 18px; border-bottom: 1px solid var(--border);
}
.m-nav-drawer .mark {
  width: 30px; height: 30px; border-radius: 8px; background: var(--text); color: #faf9f7;
  display: grid; place-items: center; font-size: 14px; font-weight: 600;
}
.m-nav-drawer .logo-text { flex: 1; }
.m-nav-drawer .logo-name { font-size: 15px; font-weight: 600; line-height: 1.2; }
.m-nav-drawer .logo-sub { font-family: var(--font-num); font-size: 10px; letter-spacing: 0.18em; color: var(--accent); font-weight: 700; }
.m-user-line { font-size: 13px !important; color: var(--text-muted) !important; cursor: default; }
.el-dropdown-menu__item .el-icon { margin-right: 6px; }
</style>
