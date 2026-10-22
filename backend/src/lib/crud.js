// 通用 CRUD 路由工厂
// 财务系统里十几个台账（客户/供应商/项目/发票/借款…）的列表-新增-编辑-软删逻辑高度一致，
// 统一在这里生成，具体模块只写自己的业务动作（审批、付款、核对…）
import express from 'express'
import prisma from './prisma.js'
import { ok, badRequest, notFound, wrap } from './response.js'
import { requirePermission, scopeWhere } from './auth.js'
import { logAudit } from './audit.js'
import { toDate } from './period.js'

/**
 * @param {object} cfg
 *  model        Prisma 模型名，如 'invoice'
 *  entity       审计日志里的实体名
 *  perms        { view, manage } 权限点
 *  fields       允许写入的字段
 *  dateFields   需要转成 Date 的字段
 *  bigintFields 需要转成 BigInt 的字段（默认自动识别 xxxId）
 *  searchFields 关键字模糊搜索字段
 *  filters      支持精确筛选的 query 参数 → 字段映射
 *  include      Prisma include
 *  orderBy      默认排序
 *  dateRangeField 支持 date_from / date_to 过滤的日期字段
 *  scoped       是否按用户可见公司过滤（默认 true）
 *  required     新增时必填字段
 *  hooks        { beforeCreate, beforeUpdate, afterWrite }
 */
export function crudRouter(cfg) {
  const {
    model,
    entity = model,
    perms,
    fields = [],
    dateFields = [],
    bigintFields = [],
    searchFields = [],
    filters = {},
    include,
    orderBy = { createdAt: 'desc' },
    dateRangeField,
    scoped = true,
    required = [],
    hooks = {}
  } = cfg

  const router = express.Router()
  const db = () => prisma[model]

  const isBigint = (k) => bigintFields.includes(k) || (/Id$/.test(k) && k !== 'id')

  function pickData(body) {
    const data = {}
    for (const k of fields) {
      if (body[k] === undefined) continue
      let v = body[k]
      if (v === '') v = null
      if (v !== null) {
        if (dateFields.includes(k)) v = toDate(v)
        else if (isBigint(k)) v = BigInt(v)
      }
      data[k] = v
    }
    return data
  }

  // ── 列表 ──
  router.get('/', requirePermission(perms.view), wrap(async (req, res) => {
    const { page = 1, page_size = 20, keyword = '', company_id = '', date_from = '', date_to = '' } = req.query
    const take = Math.min(Number(page_size) || 20, 500)
    const skip = (Number(page) - 1) * take

    const where = { deletedAt: null, ...(scoped ? scopeWhere(req.user) : {}) }
    if (company_id) where.companyId = BigInt(company_id)

    for (const [q, field] of Object.entries(filters)) {
      const v = req.query[q]
      if (v !== undefined && v !== '') where[field] = isBigint(field) ? BigInt(v) : v
    }
    if (keyword && searchFields.length) {
      where.OR = searchFields.map((f) => ({ [f]: { contains: keyword } }))
    }
    if (dateRangeField && (date_from || date_to)) {
      where[dateRangeField] = {}
      if (date_from) where[dateRangeField].gte = toDate(date_from)
      if (date_to) where[dateRangeField].lte = toDate(date_to)
    }

    const [list, total] = await Promise.all([
      db().findMany({ where, include, orderBy, skip, take }),
      db().count({ where })
    ])
    return ok(res, { list, total, page: Number(page), pageSize: take })
  }))

  // ── 详情 ──
  router.get('/:id', requirePermission(perms.view), wrap(async (req, res) => {
    const row = await db().findFirst({ where: { id: BigInt(req.params.id), deletedAt: null }, include })
    if (!row) return notFound(res)
    return ok(res, row)
  }))

  // ── 新增 ──
  router.post('/', requirePermission(perms.manage), wrap(async (req, res) => {
    const missing = required.filter((k) => req.body[k] === undefined || req.body[k] === '' || req.body[k] === null)
    if (missing.length) return badRequest(res, `缺少必填字段：${missing.join('、')}`)

    let data = pickData(req.body)
    if (hooks.beforeCreate) {
      const r = await hooks.beforeCreate(data, req)
      if (r?.error) return badRequest(res, r.error)
      data = r?.data || data
    }
    const row = await db().create({ data, include })
    await logAudit(req, { action: 'CREATE', entity, entityId: row.id, summary: `新增${entity}`, after: row })
    if (hooks.afterWrite) await hooks.afterWrite(row, req, 'CREATE')
    return ok(res, row)
  }))

  // ── 编辑 ──
  router.put('/:id', requirePermission(perms.manage), wrap(async (req, res) => {
    const id = BigInt(req.params.id)
    const before = await db().findFirst({ where: { id, deletedAt: null } })
    if (!before) return notFound(res)

    let data = pickData(req.body)
    if (hooks.beforeUpdate) {
      const r = await hooks.beforeUpdate(data, req, before)
      if (r?.error) return badRequest(res, r.error)
      data = r?.data || data
    }
    const row = await db().update({ where: { id }, data, include })
    await logAudit(req, { action: 'UPDATE', entity, entityId: id, summary: `修改${entity}`, before, after: row })
    if (hooks.afterWrite) await hooks.afterWrite(row, req, 'UPDATE', before)
    return ok(res, row)
  }))

  // ── 作废（软删，需求 §9：不做物理删除）──
  router.delete('/:id', requirePermission(perms.manage), wrap(async (req, res) => {
    const id = BigInt(req.params.id)
    const before = await db().findFirst({ where: { id, deletedAt: null } })
    if (!before) return notFound(res)
    const row = await db().update({ where: { id }, data: { deletedAt: new Date() } })
    await logAudit(req, { action: 'DELETE', entity, entityId: id, summary: `作废${entity}`, before })
    if (hooks.afterWrite) await hooks.afterWrite(row, req, 'DELETE', before)
    return ok(res, { id: String(id) })
  }))

  return router
}
