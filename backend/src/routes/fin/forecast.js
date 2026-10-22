// 资金预测 + 固定周期收支维护
import express from 'express'
import { crudRouter } from '../../lib/crud.js'
import { requirePermission } from '../../lib/auth.js'
import { ok, wrap } from '../../lib/response.js'
import { forecast } from '../../lib/forecast.js'

const router = express.Router()

router.get('/', requirePermission('forecast.view'), wrap(async (req, res) => {
  const days = req.query.days ? req.query.days.split(',').map(Number) : [30, 60, 90]
  return ok(res, await forecast(req.user, { days, companyId: req.query.company_id }))
}))

router.use('/items', crudRouter({
  model: 'forecastItem', entity: 'forecastItem',
  perms: { view: 'forecast.view', manage: 'forecast.manage' },
  fields: ['companyId', 'name', 'direction', 'amount', 'frequency', 'dayOfMonth', 'startDate', 'endDate', 'confidence', 'status', 'remark'],
  dateFields: ['startDate', 'endDate'],
  searchFields: ['name'],
  filters: { direction: 'direction', status: 'status' },
  include: { company: { select: { id: true, code: true } } },
  required: ['companyId', 'name', 'direction', 'amount']
}))

export default router
