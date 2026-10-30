// 录入助手草稿的「确认提交」：服务端代用户调各模块现有的创建 / 更新接口（权限、数据范围、审计、余额重算照旧），
// 并在这里挡住重复提交：
//   1. 同一张草稿：提交成功后记下 submittedAt + 业务 id，之后再提交一律返回第一次的结果；并发两次由草稿锁排队
//   2. 不同草稿、内容相同：按「类型 + 修改目标 + 规范化 payload + 用户 id」算指纹，唯一索引挡并发；
//      60 秒内同指纹再提交 → 返回第一次的结果（duplicate: true）；超过 60 秒视为新的一笔
import crypto from 'node:crypto'
import prisma from './prisma.js'
import { can } from './auth.js'

export const DUP_WINDOW_MS = 60_000
const WAIT_MS = 15_000
const POLL_MS = 100

const MODULE = {
  account: { url: '/api/fin/accounts', perm: 'account.manage' },
  receivable: { url: '/api/fin/receivables', perm: 'receivable.manage' },
  invoice: { url: '/api/fin/invoices', perm: 'invoice.manage' },
  transaction: { url: '/api/fin/transactions', perm: 'transaction.manage' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v)

/** 规范化：键排序；空值（null / undefined / 空串）不影响写入结果，一律去掉；字符串去首尾空格 */
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (isPlainObject(v)) {
    const out = {}
    for (const k of Object.keys(v).sort()) {
      const x = canonical(v[k])
      if (x === undefined || x === null || x === '') continue
      out[k] = x
    }
    return out
  }
  if (typeof v === 'string') return v.trim()
  return v
}

export function fingerprint({ kind, mode, targetId, payload, userId }) {
  const text = [kind, mode, targetId || '', String(userId), JSON.stringify(canonical(payload))].join('|')
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** 给前端 / 测试看的草稿状态 */
export function draftView(d) {
  return {
    draftId: String(d.id),
    kind: d.kind,
    mode: d.mode,
    targetId: d.targetId != null ? String(d.targetId) : null,
    submitted: !!d.submittedAt,
    submittedAt: d.submittedAt,
    id: d.resultId,
    code: d.resultCode,
    duplicateOf: d.duplicateOf != null ? String(d.duplicateOf) : null
  }
}

/** chat 产出草稿后落库，返回的 draftId 挂到草稿上给前端 */
export async function saveDrafts(drafts, user) {
  for (const d of drafts) {
    const companyId = /^[1-9]\d{0,17}$/.test(String(d.payload?.companyId ?? '')) ? BigInt(d.payload.companyId) : null
    const row = await prisma.assistantDraft.create({
      data: {
        userId: BigInt(user.id), kind: d.kind, mode: d.mode,
        targetId: d.mode === 'update' && d.id ? BigInt(d.id) : null,
        companyId, payload: d.payload || {}
      }
    })
    d.draftId = String(row.id)
  }
}

export async function getDraft(id, user) {
  if (!/^[1-9]\d{0,17}$/.test(String(id))) return null
  // 只能看自己的草稿
  return prisma.assistantDraft.findFirst({ where: { id: BigInt(id), userId: BigInt(user.id) } })
}

// 代用户调本系统接口：带原 token，等于用户自己点了提交
async function selfRequest(token, method, url, body) {
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3010}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  const json = await r.json().catch(() => ({ code: 9001, message: `HTTP ${r.status}`, data: null }))
  return { status: r.status, json }
}

const codeOf = (kind, rec) => String(rec?.code ?? (kind === 'invoice' ? rec?.invoiceNo : rec?.name) ?? '').slice(0, 120) || null

/** 草稿锁：拿到返回 true；拿不到说明同一张草稿正在被另一个请求提交 */
async function lockDraft(id) {
  const now = new Date()
  const r = await prisma.assistantDraft.updateMany({
    where: { id, submittedAt: null, OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - DUP_WINDOW_MS) } }] },
    data: { lockedAt: now }
  })
  return r.count === 1
}

/**
 * 认领指纹：唯一索引保证同一时刻只有一个请求能拿到；冲突就回查已有那行
 * 返回 { own: row } 自己负责提交；{ duplicate: row } 60 秒内已成功提交过；{ error } 前一个还在处理中
 */
async function claimFingerprint(fp, draft, userId) {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    const now = new Date()
    try {
      const row = await prisma.assistantSubmission.create({
        data: { fingerprint: fp, userId, draftId: draft.id, kind: draft.kind, status: 'PENDING', claimedAt: now }
      })
      return { own: row }
    } catch (e) {
      if (e?.code !== 'P2002') throw e
    }
    const ex = await prisma.assistantSubmission.findUnique({ where: { fingerprint: fp } })
    if (!ex) continue
    const fresh = Date.now() - ex.claimedAt.getTime() < DUP_WINDOW_MS
    if (ex.status === 'DONE' && fresh) return { duplicate: ex }
    if (ex.status === 'PENDING' && fresh) {
      if (Date.now() > deadline) return { error: '同样内容的上一次提交仍在处理中，请稍后刷新查看' }
      await sleep(POLL_MS)
      continue
    }
    // 上次失败了，或已过 60 秒窗口：接管这一行。条件更新保证并发接管时只有一个成功
    const r = await prisma.assistantSubmission.updateMany({
      where: { id: ex.id, status: ex.status, claimedAt: ex.claimedAt },
      data: { status: 'PENDING', userId, draftId: draft.id, kind: draft.kind, resultId: null, resultCode: null, claimedAt: now }
    })
    if (r.count === 1) return { own: { ...ex, status: 'PENDING', draftId: draft.id, claimedAt: now } }
  }
}

/**
 * @returns {{ status?: number, json?: object, data?: object }}
 *   data：成功（含重复提交的幂等返回）；status/json：原样转给前端的错误
 */
export async function submitDraft({ id, user, token, payload: bodyPayload }) {
  const fail = (status, code, message) => ({ status, json: { code, message, data: null } })
  let draft = await getDraft(id, user)
  if (!draft) return fail(200, 9004, '草稿不存在或已过期，请重新生成')
  const mod = MODULE[draft.kind]
  if (!mod) return fail(200, 9002, `不支持的草稿类型 ${draft.kind}`)
  if (!can(user, mod.perm)) return fail(403, 9003, `需要「${mod.perm}」权限，当前角色 ${user.role} 不具备`)

  const dupView = (d) => ({ ...draftView(d), duplicate: true, originalId: d.resultId, originalDraftId: String(d.duplicateOf ?? d.id) })
  if (draft.submittedAt) return { data: dupView(draft) }

  // 同一张草稿并发：后到的等前一个出结果
  if (!(await lockDraft(draft.id))) {
    const deadline = Date.now() + WAIT_MS
    for (;;) {
      await sleep(POLL_MS)
      draft = await getDraft(id, user)
      if (draft.submittedAt) return { data: dupView(draft) }
      if (await lockDraft(draft.id)) break
      if (Date.now() > deadline) return fail(200, 9002, '这张草稿正在提交中，请稍后刷新查看')
    }
  }
  const unlock = () => prisma.assistantDraft.update({ where: { id: draft.id }, data: { lockedAt: null } })

  let sub = null
  let done = false
  try {
    const payload = isPlainObject(bodyPayload) ? bodyPayload : draft.payload
    const userId = BigInt(user.id)
    const fp = fingerprint({ kind: draft.kind, mode: draft.mode, targetId: draft.targetId, payload, userId })

    const claim = await claimFingerprint(fp, draft, userId)
    if (claim.error) { await unlock(); return fail(200, 9002, claim.error) }
    if (claim.duplicate) {
      // 内容相同的另一张草稿 60 秒内刚提交过：这张也标成已提交，指向第一次的结果
      const s = claim.duplicate
      const updated = await prisma.assistantDraft.update({
        where: { id: draft.id },
        data: { payload, submittedAt: new Date(), resultId: s.resultId, resultCode: s.resultCode, duplicateOf: s.draftId, lockedAt: null }
      })
      return { data: dupView(updated) }
    }

    sub = claim.own
    const r = draft.mode === 'update'
      ? await selfRequest(token, 'PUT', `${mod.url}/${draft.targetId}`, payload)
      : await selfRequest(token, 'POST', mod.url, payload)
    if (r.json?.code !== 0) {
      // 业务校验没过（缺字段、越权、已结账…）：放开指纹和草稿锁，改好了可以再提交
      await prisma.assistantSubmission.updateMany({ where: { id: sub.id, claimedAt: sub.claimedAt }, data: { status: 'FAILED' } })
      await unlock()
      return { status: r.status, json: r.json }
    }

    const rec = r.json.data
    const resultId = rec?.id != null ? String(rec.id) : (draft.targetId != null ? String(draft.targetId) : null)
    const resultCode = codeOf(draft.kind, rec)
    await prisma.assistantSubmission.update({ where: { id: sub.id }, data: { status: 'DONE', resultId, resultCode } })
    done = true
    const updated = await prisma.assistantDraft.update({
      where: { id: draft.id },
      data: { payload, submittedAt: new Date(), resultId, resultCode, lockedAt: null }
    })
    return { data: { ...draftView(updated), duplicate: false, originalId: null, originalDraftId: null, record: rec } }
  } catch (e) {
    // 中途异常：没写成就放开指纹，免得同样内容被「处理中」卡 60 秒
    if (sub && !done) await prisma.assistantSubmission.updateMany({ where: { id: sub.id, claimedAt: sub.claimedAt }, data: { status: 'FAILED' } }).catch(() => {})
    await unlock().catch(() => {})
    throw e
  }
}
