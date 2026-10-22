import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from '@/api'
import { BASE } from '@/api/base'

const routes = [
  { path: '/login', name: 'login', component: () => import('@/views/Login.vue'), meta: { public: true } },
  // 以虎 One 统一登录回来的落地页
  { path: '/sso-done', name: 'sso-done', component: () => import('@/views/SsoDone.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('@/views/admin/AdminLayout.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'dashboard', component: () => import('@/views/admin/Dashboard.vue'), meta: { title: '管理驾驶舱' } },
      { path: 'companies', name: 'companies', component: () => import('@/views/admin/Companies.vue'), meta: { title: '公司管理' } },
      { path: 'accounts', name: 'accounts', component: () => import('@/views/admin/Accounts.vue'), meta: { title: '账户管理' } },
      { path: 'transactions', name: 'transactions', component: () => import('@/views/admin/Transactions.vue'), meta: { title: '资金流水' } },
      { path: 'transactions/import', name: 'txn-import', component: () => import('@/views/admin/TransactionImport.vue'), meta: { title: '导入银行流水' } },
      { path: 'receivables', name: 'receivables', component: () => import('@/views/admin/Receivables.vue'), meta: { title: '应收与收款' } },
      { path: 'payables', name: 'payables', component: () => import('@/views/admin/Payables.vue'), meta: { title: '应付台账' } },
      { path: 'payments', name: 'payments', component: () => import('@/views/admin/Payments.vue'), meta: { title: '付款管理' } },
      { path: 'payrolls', name: 'payrolls', component: () => import('@/views/admin/Payrolls.vue'), meta: { title: '工资管理' } },
      { path: 'payrolls/:id', name: 'payroll-detail', component: () => import('@/views/admin/PayrollDetail.vue'), meta: { title: '工资批次明细' } },
      { path: 'reimbursements', name: 'reimbursements', component: () => import('@/views/admin/Reimbursements.vue'), meta: { title: '报销管理' } },
      { path: 'invoices', name: 'invoices', component: () => import('@/views/admin/Invoices.vue'), meta: { title: '发票台账' } },
      { path: 'loans', name: 'loans', component: () => import('@/views/admin/Loans.vue'), meta: { title: '借贷与往来' } },
      { path: 'close', name: 'close', component: () => import('@/views/admin/CloseWorkbench.vue'), meta: { title: '月结工作台' } },
      { path: 'analytics', name: 'analytics', component: () => import('@/views/admin/Analytics.vue'), meta: { title: '经营分析' } },
      { path: 'forecast', name: 'forecast', component: () => import('@/views/admin/Forecast.vue'), meta: { title: '资金预测' } },
      { path: 'anomalies', name: 'anomalies', component: () => import('@/views/admin/Anomalies.vue'), meta: { title: '异常清单' } },
      { path: 'parties', name: 'parties', component: () => import('@/views/admin/Parties.vue'), meta: { title: '基础资料' } },
      { path: 'users', name: 'users', component: () => import('@/views/admin/Users.vue'), meta: { title: '用户管理' } },
      { path: 'audit-logs', name: 'audit-logs', component: () => import('@/views/admin/AuditLogs.vue'), meta: { title: '操作日志' } },
      { path: 'profile', name: 'profile', component: () => import('@/views/admin/Profile.vue'), meta: { title: '个人中心' } },
      { path: 'guide', name: 'guide', component: () => import('@/views/admin/Guide.vue'), meta: { title: '使用手册' } }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
]

const router = createRouter({ history: createWebHistory(BASE + '/'), routes })

router.beforeEach((to) => {
  if (to.meta.public) return true
  if (!getToken()) return { path: '/login', query: { redirect: to.fullPath } }
  return true
})

export default router
