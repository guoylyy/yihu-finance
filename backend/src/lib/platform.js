// 以虎 One 接入：统一登录（SSO）、前端挂在 /apps/<code>/ 下、AI 工具（MCP）
// 部署到以虎 One 时平台会注入 YH_* 环境变量，ws.enabled 为 true；本地开发不配这些变量，一切照旧（账号密码登录、根路径访问）
//
// 登录流程：前端 /login 发现在平台上 → 跳 <前缀>/sso/login → 平台授权 → <前缀>/sso/callback
//          → 平台用户对上本系统用户 → 签发本系统的 JWT → 跳回 <前缀>/sso-done#token=…（token 放在 # 后面，不进服务器日志）
// 权限仍然以本系统的用户和角色为准，平台只负责告诉我们「他是谁」
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { Workspace, basePathOf } from './yh-one.mjs'

export const ws = new Workspace()
export const onPlatform = () => ws.enabled
export { basePathOf }

/** 在平台上默认关掉本地账号密码登录（种子里的默认密码不能暴露在公网上）；确需时设 ALLOW_LOCAL_LOGIN=true */
export const localLoginAllowed = () => !onPlatform() || process.env.ALLOW_LOCAL_LOGIN === 'true'

const safeNext = (p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/')

/**
 * 挂上接入路由。必须在 404 处理之前调用
 * @param app express 应用
 * @param opts.resolveUser  async (平台用户) => 本系统用户；对不上时抛 Error(给用户看的原因)
 * @param opts.signFor      (本系统用户) => 本系统 JWT
 * @param opts.tools        MCP 工具 [{ name, title, description, inputSchema, run: async ({ user, token, args }) => 结果 }]
 * @param opts.appName      MCP serverInfo 里的名字
 */
export function mountPlatform(app, { resolveUser, signFor, tools = [], appName = 'app' }) {
  // 前端据此决定登录方式；homeUrl 用于「退出」后回到平台工作台
  app.get('/api/auth/mode', (req, res) => res.json({
    code: 0, message: 'ok',
    data: { platform: onPlatform(), localLogin: localLoginAllowed(), homeUrl: onPlatform() ? ws.webUrl : null }
  }))

  app.get('/sso/login', (req, res) => {
    if (!onPlatform()) return res.status(404).send('没有接入以虎 One')
    ws.beginLogin(req, res, safeNext(req.query.next))
  })

  app.get('/sso/callback', async (req, res) => {
    const base = basePathOf(req)
    try {
      const to = await ws.finishLogin(req, { code: req.query.code, state: req.query.state })
      const local = await resolveUser(ws.currentUser(req))
      ws.track(ws.currentUser(req), 'login')
      const next = to.startsWith(base) ? to.slice(base.length) || '/' : '/'
      res.redirect(`${base}/sso-done#token=${encodeURIComponent(signFor(local))}&next=${encodeURIComponent(next)}`)
    } catch (e) {
      res.status(403).type('html').send(`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<div style="font:15px/1.7 system-ui,sans-serif;max-width:480px;margin:18vh auto;padding:0 20px;color:#374151;text-align:center">
<h2 style="margin:0 0 8px">无法进入</h2><p>${String(e.message).replace(/[<>&]/g, '')}</p>
<p><a href="${ws.webUrl}" style="color:#2563eb">回到工作台</a></p></div>`)
    }
  })

  // ---------- AI 工具（MCP，无状态 Streamable HTTP，只回 JSON） ----------
  // 平台 AI 助手调用时带 Bearer access_token（代表当前平台用户）；对上本系统用户后，以他的权限调本系统接口
  app.post('/mcp', express.json(), async (req, res) => {
    const { id, method, params } = req.body || {}
    const reply = (result) => res.json({ jsonrpc: '2.0', id, result })
    const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } })
    if (id === undefined) return res.status(202).end()
    if (method === 'initialize') {
      return reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: appName, version: '1.0.0' } })
    }
    if (method === 'ping') return reply({})
    if (method === 'tools/list') return reply({ tools: tools.map(({ run, ...t }) => ({ ...t, annotations: { readOnlyHint: true, title: t.title } })) })
    if (method !== 'tools/call') return fail(-32601, `不支持 ${method}`)
    const pu = await ws.userFromToken(req.headers.authorization)
    if (!pu) return fail(-32001, '未授权：需要以虎 One 签发的 access_token')
    const tool = tools.find(t => t.name === params?.name)
    if (!tool) return fail(-32602, `没有工具 ${params?.name}`)
    try {
      const user = await resolveUser(pu)
      const out = await tool.run({ user, token: signFor(user, '10m'), args: params.arguments || {} })
      ws.track(pu, `mcp.${tool.name}`)
      let text = JSON.stringify(out)
      if (text.length > 30000) text = text.slice(0, 30000) + '…(结果过长已截断，请缩小范围)'
      return reply({ content: [{ type: 'text', text }] })
    } catch (e) {
      return reply({ content: [{ type: 'text', text: e.message }], isError: true })
    }
  })
}

/**
 * 以当前用户身份调本系统自己的接口（MCP 工具用：权限、数据范围和页面上完全一致）
 * 返回 data；接口报错时抛出它的 message
 */
export async function callSelf(token, url, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}${url}${q.size ? `?${q}` : ''}`, { headers: { Authorization: `Bearer ${token}` } })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) throw new Error(j.message || `HTTP ${r.status}`)
  return j.data
}

/**
 * 托管前端打包产物。挂在 /apps/<code>/ 下时给 index.html 注入 <base href>，
 * 前端的资源、接口、路由都相对它（见 frontend/src/api/base.js）
 */
export function serveFrontend(app, dist) {
  if (!fs.existsSync(path.join(dist, 'index.html'))) return false
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  app.use(express.static(dist, { index: false, maxAge: '1h' }))
  app.get(/^\/(?!api\/|sso\/|mcp$).*/, (req, res) => {
    res.set('Cache-Control', 'no-cache')
    res.type('html').send(html.replace('<head>', `<head><base href="${basePathOf(req)}/">`))
  })
  return true
}
