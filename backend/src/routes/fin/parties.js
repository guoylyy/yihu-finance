// 基础资料：客户 / 供应商 / 员工个人 / 项目 / 收支分类
import express from 'express'
import { crudRouter } from '../../lib/crud.js'

const router = express.Router()

router.use('/customers', crudRouter({
  model: 'customer', entity: 'customer',
  perms: { view: 'party.view', manage: 'party.manage' },
  fields: ['companyId', 'name', 'taxNo', 'contact', 'phone', 'status', 'remark'],
  searchFields: ['name', 'taxNo', 'contact'],
  filters: { status: 'status' },
  include: { company: { select: { id: true, code: true } } },
  required: ['name']
}))

router.use('/suppliers', crudRouter({
  model: 'supplier', entity: 'supplier',
  perms: { view: 'party.view', manage: 'party.manage' },
  fields: ['companyId', 'name', 'taxNo', 'contact', 'phone', 'bankAccount', 'bankName', 'status', 'remark'],
  searchFields: ['name', 'taxNo', 'contact'],
  filters: { status: 'status' },
  include: { company: { select: { id: true, code: true } } },
  required: ['name']
}))

router.use('/persons', crudRouter({
  model: 'person', entity: 'person',
  perms: { view: 'party.view', manage: 'party.manage' },
  fields: ['companyId', 'name', 'phone', 'type', 'bankAccount', 'bankName', 'bankBranch', 'cnaps', 'monthSalary', 'status', 'remark'],
  searchFields: ['name', 'phone', 'bankAccount'],
  filters: { status: 'status', type: 'type' },
  include: { company: { select: { id: true, code: true } } },
  orderBy: [{ companyId: 'asc' }, { id: 'asc' }],
  required: ['name']
}))

router.use('/projects', crudRouter({
  model: 'project', entity: 'project',
  perms: { view: 'party.view', manage: 'party.manage' },
  fields: ['companyId', 'code', 'name', 'customerId', 'budget', 'status', 'remark'],
  searchFields: ['name', 'code'],
  filters: { status: 'status' },
  include: { company: { select: { id: true, code: true } }, customer: { select: { id: true, name: true } } },
  required: ['companyId', 'name']
}))

router.use('/categories', crudRouter({
  model: 'category', entity: 'category',
  perms: { view: 'party.view', manage: 'party.manage' },
  fields: ['kind', 'name', 'parentId', 'sortOrder', 'status', 'remark'],
  searchFields: ['name'],
  filters: { kind: 'kind', status: 'status' },
  orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  scoped: false,
  required: ['kind', 'name']
}))

export default router
