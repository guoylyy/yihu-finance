<template>
  <el-container class="layout">
    <el-aside width="212px" class="sidebar">
      <div class="logo">
        <div class="mark">财</div>
        <div class="logo-text">
          <div class="logo-name">集团财务</div>
          <div class="logo-sub">FINANCE</div>
        </div>
      </div>

      <el-menu :default-active="route.path" router class="menu" :unique-opened="false">
        <el-menu-item index="/dashboard">
          <el-icon><Odometer /></el-icon><span>管理驾驶舱</span>
        </el-menu-item>

        <el-sub-menu index="cash">
          <template #title><el-icon><Wallet /></el-icon><span>资金</span></template>
          <el-menu-item index="/accounts">账户管理</el-menu-item>
          <el-menu-item index="/transactions">资金流水</el-menu-item>
          <el-menu-item v-if="can('transaction.import')" index="/transactions/import">导入银行流水</el-menu-item>
        </el-sub-menu>

        <el-sub-menu index="settle">
          <template #title><el-icon><Money /></el-icon><span>收付款</span></template>
          <el-menu-item index="/receivables">应收与收款</el-menu-item>
          <el-menu-item index="/payables">应付台账</el-menu-item>
          <el-menu-item index="/payments">付款管理</el-menu-item>
          <el-menu-item v-if="can('payroll.view')" index="/payrolls">工资管理</el-menu-item>
          <el-menu-item index="/reimbursements">报销管理</el-menu-item>
        </el-sub-menu>

        <el-sub-menu index="doc">
          <template #title><el-icon><Tickets /></el-icon><span>票据与往来</span></template>
          <el-menu-item index="/invoices">发票台账</el-menu-item>
          <el-menu-item index="/loans">借贷与往来</el-menu-item>
        </el-sub-menu>

        <el-sub-menu index="report">
          <template #title><el-icon><TrendCharts /></el-icon><span>分析与月结</span></template>
          <el-menu-item index="/analytics">经营分析</el-menu-item>
          <el-menu-item index="/forecast">资金预测</el-menu-item>
          <el-menu-item v-if="can('close.view')" index="/close">月结工作台</el-menu-item>
          <el-menu-item index="/anomalies">异常清单</el-menu-item>
        </el-sub-menu>

        <el-sub-menu index="base">
          <template #title><el-icon><Setting /></el-icon><span>基础与系统</span></template>
          <el-menu-item index="/parties">基础资料</el-menu-item>
          <el-menu-item v-if="can('company.view')" index="/companies">公司管理</el-menu-item>
          <el-menu-item v-if="can('user.manage')" index="/users">用户管理</el-menu-item>
          <el-menu-item v-if="can('audit.view')" index="/audit-logs">操作日志</el-menu-item>
        </el-sub-menu>

        <el-menu-item index="/guide">
          <el-icon><Reading /></el-icon><span>使用手册</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container class="main-col">
      <el-header class="topbar">
        <div class="crumb">
          <span class="title">{{ route.meta.title || '集团财务系统' }}</span>
          <el-tag v-if="anomalyCount" type="danger" effect="plain" size="small"
                  style="cursor: pointer" @click="router.push('/anomalies')">
            {{ anomalyCount }} 项待处理
          </el-tag>
        </div>
        <div class="right">
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
          <el-dropdown @command="onCommand">
            <span class="user">
              <el-avatar :size="26" style="background: var(--text)">{{ user?.name?.[0] || 'U' }}</el-avatar>
              <span class="uname">{{ user?.name }}</span>
              <el-tag size="small" effect="plain">{{ ROLE_LABELS[user?.role] || user?.role }}</el-tag>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">个人中心</el-dropdown-item>
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
import { useAssistantStore } from '@/stores/assistant'

const route = useRoute()
const router = useRouter()
const user = ref(getUser())
const anomalyCount = ref(0)
const assistant = useAssistantStore()

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
.menu { border-right: none; flex: 1; overflow-y: auto; padding-bottom: 20px; }
.menu :deep(.el-menu-item.is-active) { color: var(--accent); background: #fdf5f1; font-weight: 600; }
.menu :deep(.el-menu-item), .menu :deep(.el-sub-menu__title) { height: 42px; line-height: 42px; font-size: 14px; }

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
</style>
