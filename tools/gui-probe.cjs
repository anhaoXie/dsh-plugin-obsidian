#!/usr/bin/env node
/**
 * Live GUI probe for dsh-plugin-obsidian.
 *
 * Drives a real DSH web instance with headless Chrome over the Chrome DevTools
 * Protocol (no Playwright dependency), then:
 *   1. opens the tokenized DSH URL and dismisses the preview notice,
 *   2. clicks the "Obsidian" sidebar entry,
 *   3. asserts the panel root reports data-obsidian-state="ready" with the vault
 *      path and note items rendered (the REAL browser half, not a stub),
 *   4. runs note create/replace/trash through the panel's own HTTP API from the
 *      page context (same-origin fetch, real same-origin fence),
 *   5. saves a screenshot to verify-artifacts/.
 *
 * Usage: node tools/gui-probe.cjs <tokenized-url> [screenshot.png]
 * Requires a running DSH web instance (see tools/verify-isolated.ps1 or the
 * Lead's isolated boot) and a local Chrome/Edge.
 */

'use strict'

const { spawn, execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, dirname } = require('node:path')
const { tmpdir } = require('node:os')
const http = require('node:http')

const REPO = join(__dirname, '..')
const ARTIFACTS = join(REPO, 'verify-artifacts')

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

let passed = 0
let failed = 0
function ok(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS ${name}`) }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ` :: ${String(detail).slice(0, 500)}`}`) }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function findBrowser() {
  const { existsSync } = require('node:fs')
  for (const candidate of BROWSERS) if (existsSync(candidate)) return candidate
  return null
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(`${message.error.code} ${message.error.message}`))
        else resolve(message.result)
      }
    })
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', (event) => reject(new Error(`websocket error: ${event && event.message}`)), { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    const id = this.nextId++
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.ws.send(JSON.stringify({ id, method, params }))
    return promise
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'evaluate failed')
    }
    return result.result ? result.result.value : undefined
  }
  close() { try { this.ws.close() } catch { /* already closed */ } }
}

async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`)
      const page = list.find((target) => target.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* chrome not ready yet */ }
    await sleep(250)
  }
  throw new Error(`CDP target did not appear on port ${port} within ${timeoutMs}ms`)
}

async function main() {
  const url = process.argv[2]
  if (!url) {
    console.error('usage: node tools/gui-probe.cjs <tokenized-url> [screenshot.png]')
    process.exitCode = 2
    return
  }
  const screenshotPath = process.argv[3] || join(ARTIFACTS, 'obsidian-panel.png')
  const browser = findBrowser()
  ok('found a local Chromium-based browser', Boolean(browser), BROWSERS.join(' | '))
  if (!browser) { console.log(`\ngui-probe: ${passed} passed, ${failed} failed`); process.exitCode = 1; return }

  const port = 19391
  const profileDir = join(tmpdir(), `dsh-obsidian-gui-probe-${Date.now()}`)
  mkdirSync(profileDir, { recursive: true })
  const chrome = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore' })

  let cdp = null
  try {
    const wsUrl = await waitForTarget(port, 20000)
    cdp = await Cdp.connect(wsUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    console.log('\n--- page load ---')
    await cdp.send('Page.navigate', { url })
    await sleep(6000)
    ok('DSH web app loaded (document.title present)', Boolean(await cdp.evaluate('document.title || ""')),
      await cdp.evaluate('document.title'))

    // First-run preview notice: click Continue if present.
    const dismissed = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const target = buttons.find((b) => (b.textContent || '').trim() === 'Continue');
      if (target) { target.click(); return true }
      return false;
    })()`)
    ok('preview notice dismissed (or absent)', dismissed !== undefined)
    await sleep(1500)

    console.log('\n--- sidebar entry ---')
    const entry = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const target = buttons.find((b) => ((b.getAttribute('aria-label') || '') === 'Obsidian')
        || ((b.textContent || '').trim() === 'Obsidian'));
      if (!target) return { found: false };
      return { found: true, label: target.getAttribute('aria-label') || target.textContent.trim(), tag: target.tagName };
    })()`)
    ok('sidebar button "Obsidian" exists in the real GUI', entry && entry.found === true, JSON.stringify(entry))

    const clicked = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const target = buttons.find((b) => ((b.getAttribute('aria-label') || '') === 'Obsidian')
        || ((b.textContent || '').trim() === 'Obsidian'));
      if (!target) return false;
      target.click();
      return true;
    })()`)
    ok('clicked the sidebar entry', clicked === true)

    console.log('\n--- panel render ---')
    let panel = null
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      panel = await cdp.evaluate(`(() => {
        const root = document.querySelector('[data-obsidian-panel="root"]');
        if (!root) return null;
        const noteItems = [...root.querySelectorAll('[data-obsidian-note-item]')].map((el) => el.getAttribute('data-obsidian-note-path'));
        const actions = [...root.querySelectorAll('[data-obsidian-action]')].map((el) => el.getAttribute('data-obsidian-action'));
        return {
          state: root.getAttribute('data-obsidian-state'),
          vault: root.getAttribute('data-obsidian-vault'),
          error: (root.querySelector('[data-obsidian-error]') || {}).textContent || '',
          noteItems,
          actions,
          text: (root.innerText || '').slice(0, 600),
        };
      })()`)
      if (panel && panel.state === 'ready') break
      await sleep(500)
    }
    ok('panel root exists after clicking the sidebar entry', Boolean(panel), JSON.stringify(panel))
    if (panel) {
      ok('panel state is "ready" (not loading/error)', panel.state === 'ready', JSON.stringify({ state: panel.state, error: panel.error }))
      ok('panel shows the vault path', typeof panel.vault === 'string' && panel.vault.length > 0, panel.vault)
      ok('panel renders note items from the vault', Array.isArray(panel.noteItems) && panel.noteItems.length >= 2, JSON.stringify(panel.noteItems))
      ok('panel renders its full action set',
        ['refresh', 'new', 'daily', 'edit', 'append', 'open', 'trash'].every((action) => panel.actions.includes(action)),
        JSON.stringify(panel.actions))
      ok('panel text mentions Obsidian and the vault name', /Obsidian/.test(panel.text) && /vault/.test(panel.text),
        JSON.stringify(panel.text.slice(0, 200)))
    }

    console.log('\n--- same-origin API from the page (real fence, real vault write) ---')
    const health = await cdp.evaluate(`fetch('/dsh-obsidian/api/health').then((r) => r.json())`)
    ok('page-context /health returns 10 registered tools', health && Array.isArray(health.toolsRegistered) && health.toolsRegistered.length === 10,
      JSON.stringify(health && health.toolsRegistered))
    ok('page-context /health sees the temp vault', Boolean(health && /dsh-obsidian/.test(String(health.vaultPath)) || String(health.vaultPath).length > 0),
      health && health.vaultPath)

    const created = await cdp.evaluate(`fetch('/dsh-obsidian/api/note', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '00-收件箱/GUI验证笔记', mode: 'create', content: '# GUI 验证笔记\\n\\n来自真实浏览器面板的写入。\\n', tags: ['GUI验证'] }),
    }).then((r) => r.json())`)
    ok('panel API creates a note from the page', created && created.ok === true, JSON.stringify(created))

    const readBack = await cdp.evaluate(`fetch('/dsh-obsidian/api/note?path=' + encodeURIComponent('00-收件箱/GUI验证笔记.md')).then((r) => r.json())`)
    ok('created note reads back through the panel API',
      readBack && readBack.ok === true && /GUI 验证笔记/.test(readBack.note.content) && readBack.note.frontmatter.tags.includes('GUI验证'),
      JSON.stringify(readBack && readBack.note && { title: readBack.note.title, tags: readBack.note.frontmatter.tags }))

    // Refresh the panel so the tree shows the new note (real UI state update).
    const refreshed = await cdp.evaluate(`(() => {
      const root = document.querySelector('[data-obsidian-panel="root"]');
      const buttons = root ? [...root.querySelectorAll('[data-obsidian-action="refresh"]')] : [];
      if (buttons.length === 0) return false;
      buttons[0].click();
      return true;
    })()`)
    ok('refresh action clicked in the panel', refreshed === true)
    await sleep(1500)
    const treeAfter = await cdp.evaluate(`(() => {
      const root = document.querySelector('[data-obsidian-panel="root"]');
      if (!root) return null;
      return [...root.querySelectorAll('[data-obsidian-note-item]')].map((el) => el.getAttribute('data-obsidian-note-path'));
    })()`)
    ok('tree lists the note created through the panel API',
      Array.isArray(treeAfter) && treeAfter.some((path) => String(path).includes('GUI验证笔记')), JSON.stringify(treeAfter))

    const trashed = await cdp.evaluate(`fetch('/dsh-obsidian/api/manage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'trash', path: '00-收件箱/GUI验证笔记.md' }),
    }).then((r) => r.json())`)
    ok('panel API trashes the note', trashed && trashed.ok === true && trashed.result && trashed.result.trashed === true,
      JSON.stringify(trashed))

    console.log('\n--- screenshot ---')
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(dirname(screenshotPath), { recursive: true })
    writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'))
    ok('screenshot saved', true)
    console.log(`screenshot: ${screenshotPath}`)
  } finally {
    if (cdp) cdp.close()
    try {
      execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      try { chrome.kill('SIGKILL') } catch { /* already gone */ }
    }
    try {
      const { rmSync } = require('node:fs')
      rmSync(profileDir, { recursive: true, force: true })
    } catch { /* best effort */ }
  }

  console.log(`\ngui-probe: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('gui-probe crashed:', error && error.stack || error)
  process.exitCode = 1
})
