// 假的以虎 One 大模型上游 + 指向它的子进程后端
// 用法：最后一条用户消息里带标记决定上游怎么回——
//   [[500]] / [[503]] / [[nonjson]] / [[slow]]（不回，直到后端自己超时断开） / [[loop]]（永远要求调工具）
//   [[script:名字]]：返回 scripts 里登记的工具调用；工具结果回来后给一句收尾文字
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { BACKEND_DIR } from './lib.mjs'

export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

export async function startMockLlm() {
  const scripts = new Map()
  const requests = []
  let seq = 0
  const sockets = new Set()

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.endsWith('/api/open/llm/chat/completions')) { res.writeHead(404).end('{}'); return }
      let j = {}
      try { j = JSON.parse(body) } catch { /* 留空 */ }
      requests.push({ at: Date.now(), auth: req.headers.authorization, body: j })
      const msgs = j.messages || []
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content || ''
      const last = msgs[msgs.length - 1]
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)) }
      const text = (content) => send(200, { choices: [{ message: { role: 'assistant', content } }] })
      const tools = (calls) => send(200, {
        choices: [{ message: { role: 'assistant', content: '', tool_calls: calls.map(([name, args]) => ({ id: `mock_${++seq}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })) } }]
      })

      if (lastUser.includes('[[500]]')) return send(500, { message: 'mock upstream boom' })
      if (lastUser.includes('[[503]]')) return send(503, { message: 'no model configured' })
      if (lastUser.includes('[[nonjson]]')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>gateway</html>') }
      if (lastUser.includes('[[slow]]')) return // 不回：等后端的 AbortSignal 超时断开
      if (lastUser.includes('[[loop]]')) return tools([['list_companies', {}]])
      const m = lastUser.match(/\[\[script:([\w-]+)\]\]/)
      if (m) {
        if (last?.role === 'tool') return text('（mock）已处理')
        const calls = scripts.get(m[1])
        if (!calls) return text(`（mock）没有脚本 ${m[1]}`)
        return tools(typeof calls === 'function' ? calls(j) : calls)
      }
      return text('（mock）你好')
    })
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  const port = await freePort()
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${port}`,
    scripts,
    requests,
    hits: () => requests.length,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()) })
  }
}

/** 起一个不开 stub、上游指向 mock 的后端子进程（同一个库）。返回 { base, stop, output } */
export async function startChildBackend({ llmUrl, databaseUrl }) {
  const port = await freePort()
  const env = { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, FIN_LLM_STUB: '0', YH_CLIENT_ID: 'e2e-mock', YH_CLIENT_SECRET: 'e2e-mock-secret', YH_API_URL: llmUrl, JWT_SECRET: `e2e-child-${port}` }
  // 不设 YH_APP_URL：不进平台模式（本地账号密码登录照常，不往平台上报）
  for (const k of ['YH_APP_URL', 'YH_WEB_URL', 'YH_BASE_PATH', 'FIN_LLM_MODEL']) delete env[k]
  const proc = spawn(process.execPath, ['src/index.js'], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  proc.stdout.on('data', (d) => { output += d })
  proc.stderr.on('data', (d) => { output += d })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  for (;;) {
    if (proc.exitCode != null) throw new Error(`子进程后端启动失败：\n${output.slice(-800)}`)
    try { if ((await fetch(`${base}/api/health`)).ok) break } catch { /* 还没起来 */ }
    if (Date.now() > deadline) { proc.kill(); throw new Error(`子进程后端 20 秒内没起来：\n${output.slice(-800)}`) }
    await new Promise((r) => setTimeout(r, 200))
  }
  return {
    base,
    output: () => output,
    stop: () => new Promise((r) => { if (proc.exitCode != null) return r(); proc.once('exit', r); proc.kill() })
  }
}
