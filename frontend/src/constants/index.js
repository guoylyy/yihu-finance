// 业务枚举与中文标签：与后端入库的英文常量一一对应
export const BIZ_TYPES = [
  { value: 'SALES_RECEIPT', label: '客户回款', direction: 'IN' },
  { value: 'OTHER_IN', label: '其他收入', direction: 'IN' },
  { value: 'LOAN', label: '借款', direction: 'BOTH' },
  { value: 'REPAY', label: '还款', direction: 'BOTH' },
  { value: 'TRANSFER', label: '内部转账', direction: 'BOTH' },
  { value: 'INTERCOMPANY', label: '公司间往来', direction: 'BOTH' },
  { value: 'SALARY', label: '工资', direction: 'OUT' },
  { value: 'LABOR', label: '劳务费', direction: 'OUT' },
  { value: 'REIMBURSE', label: '报销', direction: 'OUT' },
  { value: 'PURCHASE', label: '采购付款', direction: 'OUT' },
  { value: 'SERVICE', label: '服务费', direction: 'OUT' },
  { value: 'TAX', label: '税费', direction: 'OUT' },
  { value: 'RENT', label: '房租', direction: 'OUT' },
  { value: 'SOFTWARE', label: '软件和云服务', direction: 'OUT' },
  { value: 'OTHER_OUT', label: '其他支出', direction: 'OUT' }
]
export const BIZ_LABEL = Object.fromEntries(BIZ_TYPES.map((b) => [b.value, b.label]))

export const ACCOUNT_TYPES = [
  { value: 'BANK', label: '银行账户' },
  { value: 'ALIPAY', label: '支付宝' },
  { value: 'WECHAT', label: '微信' },
  { value: 'CASH', label: '现金' },
  { value: 'PETTY', label: '备用金' },
  { value: 'INTERCOMPANY', label: '公司间往来户' }
]
export const ACCOUNT_TYPE_LABEL = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t.value, t.label]))

export const TXN_STATUS = [
  { value: 'UNRECONCILED', label: '待核对', tag: 'warning' },
  { value: 'RECONCILED', label: '已核对', tag: 'success' },
  { value: 'ABNORMAL', label: '异常', tag: 'danger' }
]

export const PAYMENT_STATUS = [
  { value: 'DRAFT', label: '草稿', tag: 'info' },
  { value: 'PENDING_APPROVAL', label: '待审批', tag: 'warning' },
  { value: 'APPROVED', label: '待付款', tag: 'primary' },
  { value: 'PAID', label: '已付款', tag: 'success' },
  { value: 'RECONCILED', label: '已核对', tag: 'success' },
  { value: 'REJECTED', label: '已驳回', tag: 'danger' },
  { value: 'CANCELLED', label: '已取消', tag: 'info' }
]

export const PAY_TYPES = [
  { value: 'SALARY', label: '工资' },
  { value: 'LABOR', label: '劳务费' },
  { value: 'REIMBURSE', label: '报销' },
  { value: 'SUPPLIER', label: '供应商付款' },
  { value: 'SERVICE', label: '服务费' },
  { value: 'TAX', label: '税费' },
  { value: 'INTERCOMPANY', label: '公司间付款' },
  { value: 'OTHER', label: '其他' }
]

export const RECEIVABLE_STATUS = [
  { value: 'PENDING', label: '待收款', tag: 'warning' },
  { value: 'PARTIAL', label: '部分收款', tag: 'primary' },
  { value: 'RECEIVED', label: '已收款', tag: 'success' },
  { value: 'WRITTEN_OFF', label: '已核销', tag: 'info' },
  { value: 'CANCELLED', label: '已取消', tag: 'info' }
]

export const PAYABLE_STATUS = [
  { value: 'PENDING', label: '待付', tag: 'warning' },
  { value: 'PARTIAL', label: '部分付款', tag: 'primary' },
  { value: 'PAID', label: '已付清', tag: 'success' },
  { value: 'CANCELLED', label: '已取消', tag: 'info' }
]

export const REIMBURSE_STATUS = [
  { value: 'DRAFT', label: '草稿', tag: 'info' },
  { value: 'PENDING', label: '待审批', tag: 'warning' },
  { value: 'APPROVED', label: '待付款', tag: 'primary' },
  { value: 'PAID', label: '已付款', tag: 'success' },
  { value: 'REJECTED', label: '已驳回', tag: 'danger' }
]

export const PAYROLL_STATUS = [
  { value: 'DRAFT', label: '草稿', tag: 'info' },
  { value: 'CONFIRMED', label: '已确认', tag: 'warning' },
  { value: 'PAID', label: '已发放', tag: 'success' }
]

export const INVOICE_TYPES = [
  { value: 'SALES', label: '销项发票' },
  { value: 'PURCHASE', label: '进项发票' },
  { value: 'EXPENSE', label: '费用发票' },
  { value: 'RED', label: '红字发票' }
]
export const INVOICE_STATUS = [
  { value: 'PENDING', label: '待处理', tag: 'warning' },
  { value: 'BOOKED', label: '已入账', tag: 'success' },
  { value: 'VOID', label: '已作废', tag: 'info' }
]

export const LOAN_DIRECTIONS = [
  { value: 'COMPANY_TO_PERSON', label: '公司借给个人' },
  { value: 'PERSON_TO_COMPANY', label: '个人借给公司' },
  { value: 'COMPANY_TO_COMPANY', label: '公司间拆借' },
  { value: 'ADVANCE', label: '代付垫款' }
]
export const LOAN_STATUS = [
  { value: 'OPEN', label: '未归还', tag: 'warning' },
  { value: 'PARTIAL', label: '部分归还', tag: 'primary' },
  { value: 'CLOSED', label: '已结清', tag: 'success' }
]

export const CONFIDENCE = [
  { value: 'CONFIRMED', label: '已确认', tag: 'success' },
  { value: 'HIGH', label: '高概率', tag: 'primary' },
  { value: 'ESTIMATE', label: '预估', tag: 'info' }
]

export const PERSON_TYPES = [
  { value: 'EMPLOYEE', label: '正式员工' },
  { value: 'CONTRACTOR', label: '劳务/兼职' },
  { value: 'OTHER', label: '其他' }
]

export function labelOf(list, value) {
  return list.find((i) => i.value === value)?.label || value || '—'
}
export function tagOf(list, value) {
  return list.find((i) => i.value === value)?.tag || 'info'
}
