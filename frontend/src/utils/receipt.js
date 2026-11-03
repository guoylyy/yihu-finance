// 认领 / 登记回款成功后的提示（应收页两步弹窗、流水页拆分共用口径）
import { ElMessage } from 'element-plus'
import { money } from './format'

/**
 * @param r       POST /receivables/:id/receipt 的响应 { receipt, transaction, prepayment, overpaidAmount }
 * @param arCode  应收编号
 */
export function receiptToast(r, arCode, { newTxn = false } = {}) {
  const tail = newTxn && r.transaction?.code ? `（新建流水 ${r.transaction.code}）` : ''
  if (r.prepayment && Number(r.overpaidAmount) > 0) {
    ElMessage({ type: 'warning', duration: 6000, showClose: true, message: `应收已结清，超出 ¥${money(r.overpaidAmount)} 已转预收款 ${r.prepayment.code}${tail}` })
  } else {
    ElMessage({ type: 'success', duration: 4000, message: `已认领 ¥${money(r.receipt?.amount)} 到 ${arCode}${tail}` })
  }
}
