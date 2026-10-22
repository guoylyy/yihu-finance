#!/usr/bin/env node
/**
 * 从以虎 FDE 平台同步「客户」与「项目」到财务系统
 *
 * 用法：
 *   node scripts/sync-fde.js --dry-run        # 只看差异，不写库
 *   node scripts/sync-fde.js                  # 执行同步
 *   node scripts/sync-fde.js --company 星野教育  # 归到别的公司（默认 云帆科技）
 *
 * 凭证：读 ~/.yihu-mcp.env 里的 YIHU_MCP_URL / YIHU_MCP_TOKEN（与 FDE 仓库的
 * mcp-call.sh 同一份，不进仓库）。可用环境变量覆盖。
 *
 * 幂等：客户按「名称」比对、项目按「项目编号」比对，已存在则更新，不会重复建。
 * 跳过：已取消(CANCELLED)的项目、unit-test 开头的测试客户。
 */
import 'dotenv/config'
import fs from 'fs'
import os from 'os'
import path from 'path'
import prisma from '../src/lib/prisma.js'
import { Prisma } from '@prisma/client'

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const COMPANY_CODE = args[args.indexOf('--company') + 1]?.startsWith('--') || args.indexOf('--company') < 0
  ? '云帆科技'
  : args[args.indexOf('--company') + 1]

// FDE 项目状态 → 财务系统项目状态
const STATUS_MAP = {
  IN_PROGRESS: 'ACTIVE',
  APPROVED: 'ACTIVE',
  ACCEPTED: 'ACTIVE',
  DRAFT: 'PROPOSAL',
  PROPOSAL: 'PROPOSAL',
  CLOSED: 'CLOSED'
  // CANCELLED 不同步
}
const TYPE_LABEL = { NEW: '新建', UPGRADE: '升级', MAINTENANCE: '运维' }

function loadCredentials() {
  const envFile = process.env.YIHU_MCP_ENV || path.join(os.homedir(), '.yihu-mcp.env')
  let url = process.env.YIHU_MCP_URL
  let token = process.env.YIHU_MCP_TOKEN
  if ((!url || !token) && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*(YIHU_MCP_URL|YIHU_MCP_TOKEN)\s*=\s*(.+?)\s*$/.exec(line)
      if (!m) continue
      const v = m[2].replace(/^["']|["']$/g, '')
      if (m[1] === 'YIHU_MCP_URL') url = url || v
      else token = token || v
    }
  }
  if (!url || !token) {
    throw new Error(`没找到 FDE 平台凭证。请在 ${envFile} 里配置 YIHU_MCP_URL / YIHU_MCP_TOKEN`)
  }
  return { url, token }
}

async function callMcp(tool, args = {}) {
  const { url, token } = loadCredentials()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } })
  })
  const text = await res.text()
  // 服务端可能以 SSE 形式返回，取 data: 那一行
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim()
    : text
  let body
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error(`MCP 返回无法解析（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  if (body.error) throw new Error(`MCP 调用失败：${body.error.message || JSON.stringify(body.error)}`)
  const inner = JSON.parse(body.result.content[0].text)
  if (inner.code !== 0) throw new Error(`${tool} 返回 code=${inner.code}：${inner.message}`)
  return inner.data
}

const isTestData = (name) => !name || /^unit-test|^示范科技|^示例/.test(name)

async function main() {
  const company = await prisma.company.findFirst({ where: { code: COMPANY_CODE, deletedAt: null } })
  if (!company) throw new Error(`财务系统里没有公司「${COMPANY_CODE}」`)
  console.log(`→ 目标公司：${company.code}（${company.name}）${DRY ? ' [dry-run，不写库]' : ''}`)

  console.log('→ 从 FDE 平台拉取…')
  const [customerData, projectData] = await Promise.all([
    callMcp('list_customers', { page_size: 200 }),
    callMcp('list_projects', { page_size: 200 })
  ])
  const fdeCustomers = customerData.list.filter((c) => !isTestData(c.name))
  const fdeProjects = projectData.list
  console.log(`  客户 ${fdeCustomers.length} 条、项目 ${fdeProjects.length} 条`)

  // ── 客户 ──
  const idMap = new Map() // FDE customerId → 财务系统 customer.id
  const stat = { cCreated: 0, cUpdated: 0, pCreated: 0, pUpdated: 0, pSkipped: [] }

  for (const c of fdeCustomers) {
    const remark = [
      c.industry && `行业：${c.industry}`,
      c.shortName && `简称：${c.shortName}`,
      c.notes,
      `FDE#${c.id}`
    ].filter(Boolean).join('｜')

    const data = {
      companyId: company.id,
      name: c.name,
      taxNo: c.taxId || null,
      status: c.status === 1 ? 'ACTIVE' : 'DISABLED',
      remark: remark.slice(0, 500)
    }
    const exist = await prisma.customer.findFirst({
      where: { companyId: company.id, name: c.name, deletedAt: null }
    })
    if (exist) {
      if (!DRY) await prisma.customer.update({ where: { id: exist.id }, data })
      idMap.set(c.id, exist.id)
      stat.cUpdated++
    } else {
      if (DRY) {
        idMap.set(c.id, null)
      } else {
        const row = await prisma.customer.create({ data })
        idMap.set(c.id, row.id)
      }
      stat.cCreated++
      console.log(`  + 客户 ${c.name}`)
    }
  }

  // ── 项目 ──
  for (const p of fdeProjects) {
    const status = STATUS_MAP[p.status]
    if (!status) {
      stat.pSkipped.push(`${p.code || p.name}（${p.status}）`)
      continue
    }
    const period = [p.startDate?.slice(0, 10), p.endDate?.slice(0, 10)].filter(Boolean).join(' ~ ')
    const remark = [
      TYPE_LABEL[p.type] || p.type,
      period && `周期 ${period}`,
      `FDE 状态 ${p.status}`,
      `FDE#${p.id}`
    ].filter(Boolean).join('｜')

    const data = {
      companyId: company.id,
      code: p.code || null,
      name: p.name,
      customerId: idMap.get(p.customerId) ?? null,
      budget: p.budget != null ? new Prisma.Decimal(p.budget) : null,
      status,
      remark: remark.slice(0, 500)
    }
    const exist = p.code
      ? await prisma.project.findFirst({ where: { companyId: company.id, code: p.code, deletedAt: null } })
      : await prisma.project.findFirst({ where: { companyId: company.id, name: p.name, deletedAt: null } })

    if (exist) {
      if (!DRY) await prisma.project.update({ where: { id: exist.id }, data })
      stat.pUpdated++
    } else {
      if (!DRY) await prisma.project.create({ data })
      stat.pCreated++
      console.log(`  + 项目 ${p.code || ''} ${p.name}`)
    }
  }

  console.log('')
  console.log(`✅ 客户：新增 ${stat.cCreated}、更新 ${stat.cUpdated}`)
  console.log(`✅ 项目：新增 ${stat.pCreated}、更新 ${stat.pUpdated}`)
  if (stat.pSkipped.length) console.log(`⏭  跳过项目 ${stat.pSkipped.length} 个：${stat.pSkipped.join('、')}`)
  if (DRY) console.log('\n（dry-run，未写入数据库；去掉 --dry-run 执行同步）')
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1) })
  .finally(() => prisma.$disconnect())
