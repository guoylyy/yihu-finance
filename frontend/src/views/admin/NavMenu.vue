<!-- 左侧导航菜单：桌面侧栏、平板图标栏（collapse，子菜单浮层展开）、手机抽屉共用 -->
<template>
  <el-menu :default-active="route.path" router class="menu" :unique-opened="false"
           :collapse="collapse" :collapse-transition="false" @select="emit('select', $event)">
    <el-menu-item index="/dashboard">
      <el-icon><Odometer /></el-icon><template #title><span>管理驾驶舱</span></template>
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
      <el-icon><Reading /></el-icon><template #title><span>使用手册</span></template>
    </el-menu-item>
  </el-menu>
</template>

<script setup>
import { useRoute } from 'vue-router'
import { can } from '@/api/permissions'

defineProps({ collapse: Boolean })
const emit = defineEmits(['select'])
const route = useRoute()
</script>

<style scoped>
.menu { border-right: none; flex: 1; overflow-y: auto; padding-bottom: 20px; }
.menu :deep(.el-menu-item.is-active) { color: var(--accent); background: #fdf5f1; font-weight: 600; }
.menu :deep(.el-menu-item), .menu :deep(.el-sub-menu__title) { height: 42px; line-height: 42px; font-size: 14px; }
.menu.el-menu--collapse { width: 64px; padding-bottom: 20px; }
/* 抽屉里的菜单（手机）：行高 48，便于手指点 */
@media (max-width: 768px) {
  .menu :deep(.el-menu-item), .menu :deep(.el-sub-menu__title) { height: 48px; line-height: 48px; font-size: 15px; }
}
</style>
<!-- 平板图标栏的子菜单浮层：当前路由高亮与侧栏一致（popper 挂在 body 上，scoped 样式够不到） -->
<style>
.el-menu--popup .el-menu-item.is-active { color: var(--accent); background: #fdf5f1; font-weight: 600; }
</style>
