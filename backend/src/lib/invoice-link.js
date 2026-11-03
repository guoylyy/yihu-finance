// v1.4 发票 ↔ 应收
// 口径：
//  - 只有销项（SALES）和红字（RED）发票能挂应收；进项 / 费用发票是别人开给我们的，跟应收无关
//  - 一张发票只挂一笔应收（invoices.receivable_id 单值），一笔应收可挂多张（部分开票）
//  - 已开票 = 销项价税合计 − 红字价税合计的绝对值（红字发票导入时金额是负数、手工录入可能是正数，一律按绝对值冲减）
//  - 作废（VOID）的发票不计入；应收金额本身不因发票改变
import { Prisma } from '@prisma/client'

const D = (v) => new Prisma.Decimal(v ?? 0)
export const LINKABLE_INVOICE_TYPES = ['SALES', 'RED']

export function invoiceSummary(arAmount, invoices = []) {
  let blue = D(0)
  let red = D(0)
  let count = 0
  for (const inv of invoices) {
    if (inv.status === 'VOID') continue
    count++
    if (inv.type === 'RED') red = red.plus(D(inv.totalAmount).abs())
    else blue = blue.plus(D(inv.totalAmount))
  }
  const invoiced = blue.minus(red)
  return {
    count,
    blueTotal: blue.toFixed(2), // 销项价税合计
    redTotal: red.toFixed(2), // 红字冲减（正数表示）
    invoicedTotal: invoiced.toFixed(2), // 已开票净额
    uninvoicedAmount: D(arAmount).minus(invoiced).toFixed(2) // 应收 − 已开票净额（正 = 还没开足，负 = 开超了）
  }
}
