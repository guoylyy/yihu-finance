// 极简无头浏览器驱动：直接用 Chrome DevTools Protocol（Node 自带 WebSocket），不引入 puppeteer / playwright
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export function chromeAvailable(chromePath) {
  return !!chromePath && fs.existsSync(chromePath)
}

export async function launchBrowser(chromePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-e2e-chrome-'))
  const proc = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise((resolve, reject) => {
    let err = ''
    const timer = setTimeout(() => reject(new Error(`Chrome 没有启动：${err.slice(-300)}`)), 15_000)
    proc.stderr.on('data', (d) => {
      err += d
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) { clearTimeout(timer); resolve(m[1]) }
    })
    proc.once('exit', () => { clearTimeout(timer); reject(new Error(`Chrome 退出了：${err.slice(-300)}`)) })
  })
  const port = new URL(wsUrl).port
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('连不上 Chrome DevTools')) })

  let id = 0
  const pending = new Map()
  const dialogs = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      // alert() 被触发 = XSS 执行了；记下来并关掉，免得页面卡住
      dialogs.push(msg.params.message)
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  await send('Page.enable')
  await send('Runtime.enable')

  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`页面脚本出错：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
    return r.result.value
  }
  async function waitFor(expression, { timeout = 10_000, what = expression } = {}) {
    const end = Date.now() + timeout
    for (;;) {
      const v = await evaluate(expression).catch(() => null)
      if (v) return v
      if (Date.now() > end) throw new Error(`等待超时（${timeout}ms）：${what}`)
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  async function goto(url) {
    await send('Page.navigate', { url })
    await waitFor('document.readyState === "complete"', { what: `打开 ${url}` })
  }
  /** 以某个用户身份打开页面：先落到同源页面写 localStorage，再跳目标页 */
  async function openAs(ui, { token, user }, route, { assistantOpen = true } = {}) {
    await goto(`${ui}/login`)
    await evaluate(`localStorage.clear();
      localStorage.setItem('fin_token', ${JSON.stringify(token)});
      localStorage.setItem('fin_user', ${JSON.stringify(JSON.stringify(user))});
      localStorage.setItem('fin_assistant_ui', ${JSON.stringify(JSON.stringify({ open: assistantOpen, width: 420 }))}); true`)
    await goto(`${ui}${route}`)
    await waitFor(`!!document.querySelector('.topbar .uname')`, { what: '后台布局加载完成' })
  }
  async function close() {
    try { ws.close() } catch { /* 忽略 */ }
    await new Promise((r) => { if (proc.exitCode != null) return r(); proc.once('exit', r); proc.kill() })
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { evaluate, waitFor, goto, openAs, dialogs, close }
}

// 在页面里拿 pinia 的录入助手 store
export const STORE = `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('assistant')`

/** 在助手输入框里打字并发送，等到新的一条助手回复出现 */
export async function sendInAssistant(b, text) {
  const before = await b.evaluate(`document.querySelectorAll('.assistant-pane .msg.assistant').length`)
  await b.evaluate(`(() => {
    const ta = document.querySelector('.assistant-pane textarea')
    ta.value = ${JSON.stringify(text)}
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await b.waitFor(`!document.querySelector('.assistant-pane .a-input button.el-button--primary').disabled`, { what: '发送按钮可点' })
  await b.evaluate(`document.querySelector('.assistant-pane .a-input button.el-button--primary').click(), true`)
  await b.waitFor(`document.querySelectorAll('.assistant-pane .msg.assistant').length > ${before} && !document.querySelector('.assistant-pane .bubble.muted')`, { timeout: 70_000, what: '助手回复' })
}
