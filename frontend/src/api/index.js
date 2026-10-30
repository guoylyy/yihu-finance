// 后端 API 封装：统一带 token、统一解包 { code, message, data }
import { BASE } from './base.js'
const TOKEN_KEY = 'fin_token'
const USER_KEY = 'fin_user'

export const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t)
export const getUser = () => {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null') } catch { return null }
}
export const setUser = (u) => localStorage.setItem(USER_KEY, JSON.stringify(u))
export const clearAuth = () => { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY) }

function qs(params = {}) {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') s.append(k, v)
  }
  const str = s.toString()
  return str ? `?${str}` : ''
}

async function request(url, options = {}) {
  const isForm = options.body instanceof FormData
  const headers = {
    ...(isForm ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers || {})
  }
  if (getToken()) headers.Authorization = `Bearer ${getToken()}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeout || 30000)
  let res
  try {
    res = await fetch(url, { ...options, headers, signal: controller.signal })
  } catch (e) {
    clearTimeout(timer)
    throw new Error(e.name === 'AbortError' ? '请求超时，请稍后重试' : '网络异常，请检查后端服务是否已启动')
  }
  clearTimeout(timer)

  const data = await res.json().catch(() => ({}))
  if (data.code !== 0) {
    if (res.status === 401) {
      clearAuth()
      if (!location.pathname.endsWith('/login')) location.href = `${BASE}/login`
    }
    throw new Error(data.message || `请求失败（HTTP ${res.status}）`)
  }
  return data.data
}

const get = (url, params) => request(url + qs(params))
const post = (url, body) => request(url, { method: 'POST', body: JSON.stringify(body || {}) })
const put = (url, body) => request(url, { method: 'PUT', body: JSON.stringify(body || {}) })
const del = (url) => request(url, { method: 'DELETE' })
const upload = (url, formData) => request(url, { method: 'POST', body: formData, timeout: 120000 })

/** 下载二进制文件（导出 Excel / 银行模板 / 月结 Markdown） */
export async function download(url, params, fallbackName = 'download') {
  const res = await fetch(url + qs(params), { headers: { Authorization: `Bearer ${getToken()}` } })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || '下载失败')
  }
  const disposition = res.headers.get('Content-Disposition') || ''
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  const plain = /filename="?([^";]+)"?/i.exec(disposition)
  const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : fallbackName
  const blob = await res.blob()
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 3000)
}

// 标准台账 CRUD
const crud = (base) => ({
  list: (p) => get(base, p),
  get: (id) => get(`${base}/${id}`),
  create: (b) => post(base, b),
  update: (id, b) => put(`${base}/${id}`, b),
  remove: (id) => del(`${base}/${id}`)
})

const B = `${BASE}/api/fin`

export const api = {
  health: () => get(`${BASE}/api/health`),
  auth: {
    login: (b) => post(`${BASE}/api/auth/login`, b),
    mode: () => get(`${BASE}/api/auth/mode`),
    me: () => get(`${BASE}/api/auth/me`),
    changePassword: (b) => post(`${BASE}/api/auth/change-password`, b)
  },
  companies: { ...crud(`${B}/companies`), overview: (id, p) => get(`${B}/companies/${id}/overview`, p) },
  accounts: {
    ...crud(`${B}/accounts`),
    summary: () => get(`${B}/accounts/summary`),
    transfer: (b) => post(`${B}/accounts/transfer`, b),
    reconcile: (id) => get(`${B}/accounts/${id}/reconcile`)
  },
  customers: crud(`${B}/customers`),
  suppliers: crud(`${B}/suppliers`),
  persons: crud(`${B}/persons`),
  projects: crud(`${B}/projects`),
  categories: crud(`${B}/categories`),
  transactions: {
    ...crud(`${B}/transactions`),
    batch: (b) => post(`${B}/transactions/batch`, b),
    importPreview: (fd) => upload(`${B}/transactions/import/preview`, fd),
    importCommit: (b) => post(`${B}/transactions/import/commit`, b),
    batches: (p) => get(`${B}/transactions/import/batches`, p),
    exportUrl: `${B}/transactions/export`
  },
  receivables: {
    ...crud(`${B}/receivables`),
    overdue: () => get(`${B}/receivables/overdue`),
    receipt: (id, b) => post(`${B}/receivables/${id}/receipt`, b)
  },
  payables: {
    ...crud(`${B}/payables`),
    overdue: () => get(`${B}/payables/overdue`),
    quickPay: (id, b) => post(`${B}/payables/${id}/quick-pay`, b),
    payments: (id) => get(`${B}/payables/${id}/payments`)
  },
  payments: {
    ...crud(`${B}/payments`),
    plan: (p) => get(`${B}/payments/plan`, p),
    planUrl: `${B}/payments/plan`,
    submit: (id) => post(`${B}/payments/${id}/submit`),
    approve: (id, b) => post(`${B}/payments/${id}/approve`, b),
    reject: (id, b) => post(`${B}/payments/${id}/reject`, b),
    cancel: (id) => post(`${B}/payments/${id}/cancel`),
    batchApprove: (ids) => post(`${B}/payments/batch-approve`, { ids }),
    pay: (id, b) => post(`${B}/payments/${id}/pay`, b),
    linkTransaction: (id, b) => post(`${B}/payments/${id}/link-transaction`, b)
  },
  payrolls: {
    ...crud(`${B}/payrolls`),
    importFile: (id, fd) => upload(`${B}/payrolls/${id}/import`, fd),
    addItem: (id, b) => post(`${B}/payrolls/${id}/items`, b),
    updateItem: (itemId, b) => put(`${B}/payrolls/items/${itemId}`, b),
    removeItem: (itemId) => del(`${B}/payrolls/items/${itemId}`),
    bankBatches: (id, p) => get(`${B}/payrolls/${id}/bank-batches`, p),
    bankTemplateUrl: (id) => `${B}/payrolls/${id}/bank-template`,
    generatePayments: (id, b) => post(`${B}/payrolls/${id}/generate-payments`, b)
  },
  reimbursements: {
    ...crud(`${B}/reimbursements`),
    approve: (id) => post(`${B}/reimbursements/${id}/approve`),
    reject: (id, b) => post(`${B}/reimbursements/${id}/reject`, b),
    generatePayments: (b) => post(`${B}/reimbursements/generate-payments`, b)
  },
  invoices: {
    ...crud(`${B}/invoices`),
    stats: (p) => get(`${B}/invoices/stats`, p),
    duplicates: () => get(`${B}/invoices/duplicates`),
    importFile: (fd) => upload(`${B}/invoices/import`, fd),
    linkTransaction: (id, b) => post(`${B}/invoices/${id}/link-transaction`, b)
  },
  loans: { ...crud(`${B}/loans`), summary: () => get(`${B}/loans/summary`), repay: (id, b) => post(`${B}/loans/${id}/repay`, b) },
  close: {
    list: (p) => get(`${B}/close-periods`, p),
    checklist: (p) => get(`${B}/close-periods/checklist`, p),
    summary: (p) => get(`${B}/close-periods/summary`, p),
    summaryUrl: `${B}/close-periods/summary`,
    close: (b) => post(`${B}/close-periods/close`, b),
    reopen: (b) => post(`${B}/close-periods/reopen`, b)
  },
  dashboard: { get: (p) => get(`${B}/dashboard`, p) },
  analytics: {
    trend: (p) => get(`${B}/analytics/trend`, p),
    byCategory: (p) => get(`${B}/analytics/by-category`, p),
    byCompany: (p) => get(`${B}/analytics/by-company`, p),
    laborCost: (p) => get(`${B}/analytics/labor-cost`, p),
    topCounterparty: (p) => get(`${B}/analytics/top-counterparty`, p),
    byProject: () => get(`${B}/analytics/by-project`)
  },
  forecast: { get: (p) => get(`${B}/forecast`, p), items: crud(`${B}/forecast/items`) },
  attachments: {
    list: (p) => get(`${B}/attachments`, p),
    upload: (fd) => upload(`${B}/attachments`, fd),
    remove: (id) => del(`${B}/attachments/${id}`),
    downloadUrl: (id) => `${B}/attachments/${id}/download`
  },
  users: { ...crud(`${B}/users`), permissions: () => get(`${B}/users/permissions`) },
  auditLogs: { list: (p) => get(`${B}/audit-logs`, p) },
  ai: {
    monthlyReport: (p) => get(`${B}/ai/monthly-report`, p),
    anomalies: (p) => get(`${B}/ai/anomalies`, p)
  },
  // 录入助手：chat 只返回草稿；「确认提交」走 submitDraft，由服务端代调各模块的 create / update 并去重
  assistant: {
    status: () => get(`${B}/assistant/status`),
    chat: (b) => request(`${B}/assistant/chat`, { method: 'POST', body: JSON.stringify(b || {}), timeout: 65000 }),
    draft: (id) => get(`${B}/assistant/drafts/${id}`),
    drafts: (ids) => get(`${B}/assistant/drafts`, { ids: ids.join(',') }),
    submitDraft: (id, payload) => post(`${B}/assistant/drafts/${id}/submit`, { payload })
  }
}

export default api
