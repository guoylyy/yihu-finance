import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'

import authRouter from './routes/auth.js'
import companiesRouter from './routes/fin/companies.js'
import accountsRouter from './routes/fin/accounts.js'
import partiesRouter from './routes/fin/parties.js'
import transactionsRouter from './routes/fin/transactions.js'
import receivablesRouter from './routes/fin/receivables.js'
import payablesRouter from './routes/fin/payables.js'
import paymentsRouter from './routes/fin/payments.js'
import payrollsRouter from './routes/fin/payrolls.js'
import reimbursementsRouter from './routes/fin/reimbursements.js'
import invoicesRouter from './routes/fin/invoices.js'
import loansRouter from './routes/fin/loans.js'
import closePeriodsRouter from './routes/fin/close-periods.js'
import dashboardRouter from './routes/fin/dashboard.js'
import analyticsRouter from './routes/fin/analytics.js'
import forecastRouter from './routes/fin/forecast.js'
import attachmentsRouter from './routes/fin/attachments.js'
import usersRouter from './routes/fin/users.js'
import auditLogsRouter from './routes/fin/audit-logs.js'
import aiRouter from './routes/fin/ai.js'
import assistantRouter from './routes/fin/assistant.js'
import { auth } from './lib/auth.js'
import { fileURLToPath } from 'url'
import { mountPlatform, serveFrontend, callSelf } from './lib/platform.js'
import { resolveUser, signFor } from './lib/platform-users.js'

// Prisma 的 BigInt 主键默认无法被 JSON.stringify 序列化
BigInt.prototype.toJSON = function () { return this.toString() }

const app = express()
const PORT = process.env.PORT || 3010

app.use(cors())
app.use(express.json({ limit: '20mb' }))
app.use(express.urlencoded({ extended: true }))

app.get('/api/health', (req, res) => res.json({ code: 0, message: 'ok', data: { ts: Date.now() } }))
app.use('/api/auth', authRouter)

// 以下全部需要登录
app.use('/api/fin', auth)
app.use('/api/fin/companies', companiesRouter)
app.use('/api/fin/accounts', accountsRouter)
app.use('/api/fin', partiesRouter)            // /customers /suppliers /persons /projects /categories
app.use('/api/fin/transactions', transactionsRouter)
app.use('/api/fin/receivables', receivablesRouter)
app.use('/api/fin/payables', payablesRouter)
app.use('/api/fin/payments', paymentsRouter)
app.use('/api/fin/payrolls', payrollsRouter)
app.use('/api/fin/reimbursements', reimbursementsRouter)
app.use('/api/fin/invoices', invoicesRouter)
app.use('/api/fin/loans', loansRouter)
app.use('/api/fin/close-periods', closePeriodsRouter)
app.use('/api/fin/dashboard', dashboardRouter)
app.use('/api/fin/analytics', analyticsRouter)
app.use('/api/fin/forecast', forecastRouter)
app.use('/api/fin/attachments', attachmentsRouter)
app.use('/api/fin/users', usersRouter)
app.use('/api/fin/audit-logs', auditLogsRouter)
app.use('/api/fin/ai', aiRouter)
app.use('/api/fin/assistant', assistantRouter)   // 录入助手：只出草稿，不写库

// ---------- 以虎 One 接入：统一登录 + AI 工具 ----------
// 工具全部只读，以当前用户的角色和数据范围调用本系统接口（AI 助手不能付款、不能改账）
const month = { type: 'string', description: '月份 YYYY-MM，默认本月' }
mountPlatform(app, {
  appName: 'yihu-finance',
  resolveUser,
  signFor,
  tools: [
    {
      name: 'get_cash_overview', title: '集团资金概况',
      description: '集团和各公司的账户余额、本月收入/支出/净现金流、待收待付、未核对流水和逾期数。问「现在账上有多少钱」「这个月花了多少」时用。',
      inputSchema: { type: 'object', properties: { period: month } },
      run: ({ token, args }) => callSelf(token, '/api/fin/dashboard', { period: args.period })
    },
    {
      name: 'get_cash_forecast', title: '资金预测',
      description: '未来 30/60/90 天资金预测：预计期末余额 = 当前可用余额 + 预计收款 − 已审批待付款 − 固定周期支出，含逐日曲线和事项明细。问「钱够不够用」「下个月会不会紧张」时用。',
      inputSchema: { type: 'object', properties: { days: { type: 'string', description: '预测天数，逗号分隔，默认 30,60,90' }, company_id: { type: 'string', description: '只看某家公司（公司 id），默认全部' } } },
      run: ({ token, args }) => callSelf(token, '/api/fin/forecast', { days: args.days, company_id: args.company_id })
    },
    {
      name: 'list_overdue', title: '逾期收付款',
      description: '逾期未收的应收款和逾期未付的应付款清单。',
      inputSchema: { type: 'object', properties: {} },
      run: async ({ token }) => ({
        receivables: await callSelf(token, '/api/fin/receivables/overdue'),
        payables: await callSelf(token, '/api/fin/payables/overdue')
      })
    },
    {
      name: 'list_anomalies', title: '财务异常清单',
      description: '需要人看一眼的问题：缺银行账号、重复发票、待核对流水、逾期收付款、余额未更新、万元以上支出未关联发票等。',
      inputSchema: { type: 'object', properties: { period: month, company_id: { type: 'string', description: '公司 id，默认全部' } } },
      run: ({ token, args }) => callSelf(token, '/api/fin/ai/anomalies', { period: args.period, company_id: args.company_id })
    },
    {
      name: 'get_monthly_report', title: '公司月报',
      description: '某家公司某月的月结摘要（Markdown）：余额、收支、分类、待办。需要先用 get_cash_overview 拿到公司 id。',
      inputSchema: { type: 'object', properties: { company_id: { type: 'string', description: '公司 id（必填）' }, period: month }, required: ['company_id'] },
      run: ({ token, args }) => callSelf(token, '/api/fin/ai/monthly-report', { company_id: args.company_id, period: args.period })
    }
  ]
})

// 前端打包产物（frontend/dist）由后端直接托管；挂在 /apps/<code>/ 下时自动注入 <base href>
serveFrontend(app, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist'))

app.use((req, res) => res.status(404).json({ code: 9004, message: `接口不存在：${req.method} ${req.path}`, data: null }))

app.use((err, req, res, next) => {
  // 请求体不是合法 JSON、超过大小限制等是客户端的错：按 4xx 回，不当成服务器故障
  const status = err.status || err.statusCode || 500
  if (status < 500) {
    return res.status(status).json({ code: 9002, message: err.type === 'entity.parse.failed' ? '请求体不是合法的 JSON' : err.message, data: null })
  }
  console.error('[unhandled]', err)
  res.status(500).json({ code: 9001, message: err.message || '服务器内部错误', data: null })
})

app.listen(PORT, () => {
  console.log(`✅ 财务系统后端已启动：http://localhost:${PORT}`)
})
