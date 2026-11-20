#!/usr/bin/env node
/**
 * Integration harness for dsh-plugin-obsidian (host half).
 *
 * What this proves (and what it deliberately does NOT):
 *  - It loads the REAL lib/index.js and calls apply() with a ctx that mirrors the
 *    two service-access shapes the DSH loader offers (top-level `inject` export
 *    giving ctx.webServer, and ctx.inject(['tools'], cb)).
 *  - It wires the registered prefix route into a REAL node:http server and drives
 *    it with real HTTP requests (fetch), including the same-origin fence.
 *  - It executes every registered agent tool through the real tool definition
 *    (parameters -> execute -> structured result) against a temp vault.
 *  - It asserts the /health payload reports all 10 tools registered by the real
 *    tools service path.
 *
 * It does NOT prove the live DSH host gives the same services — that is the job of
 * tools/verify-isolated.ps1 against a real `dsh web` process. This harness is the
 * fast contract test; the isolated instance is the authority.
 *
 * GOLDEN RULE for this file: every assertion must be able to fail. No assertion
 * may pass merely because a string appears elsewhere in the output.
 */

'use strict'

const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, dirname } = require('node:path')
const http = require('node:http')
const { pathToFileURL } = require('node:url')

const REPO = join(__dirname, '..')
const API = '/dsh-obsidian/api'
const TOOL_NAMES = [
  'obsidian_status', 'obsidian_list', 'obsidian_read', 'obsidian_search', 'obsidian_write',
  'obsidian_manage', 'obsidian_daily', 'obsidian_tags', 'obsidian_links', 'obsidian_open',
]

let passed = 0
let failed = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passed++
    console.log(`PASS ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`FAIL ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}
function okEq(name, actual, expected) {
  const good = JSON.stringify(actual) === JSON.stringify(expected)
  ok(name, good, good ? undefined : `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}
function section(title) {
  console.log(`\n--- ${title} ---`)
}

function writeFixture(root) {
  mkdirSync(join(root, '01-笔记'), { recursive: true })
  mkdirSync(join(root, '日记'), { recursive: true })
  mkdirSync(join(root, '模板'), { recursive: true })
  mkdirSync(join(root, '02-资源'), { recursive: true })
  mkdirSync(join(root, '.obsidian'), { recursive: true })
  writeFileSync(join(root, '欢迎.md'), '---\ntags: [欢迎, 入门]\n---\n\n# 欢迎\n\n这是 welcome 笔记。\n', 'utf8')
  writeFileSync(join(root, '首页.md'), '---\ntitle: 首页\ntags:\n  - 首页\naliases: [Home]\n---\n\n# 我的知识体系\n\n导航：[[欢迎]] 与 [[01-笔记/为什么笔记要原子化|原子化笔记]]。\n', 'utf8')
  writeFileSync(join(root, '01-笔记', '为什么笔记要原子化.md'),
    '---\ntags: [方法, 笔记]\n---\n\n# 为什么笔记要原子化\n\n原子化让笔记可以被链接。内联标签 #方法论 也应该被识别。\n', 'utf8')
  writeFileSync(join(root, '02-资源', '资源清单.md'), '# 资源清单\n\n#资源 一份清单。\n', 'utf8')
  writeFileSync(join(root, '日记', '2026-10-23.md'), '# 2026-10-23\n\n- 已存在的日记\n', 'utf8')
  writeFileSync(join(root, '模板', '日记模板.md'), '# {{date}}\n\n## 记录\n\n', 'utf8')
  writeFileSync(join(root, '.obsidian', 'daily-notes.json'),
    JSON.stringify({ folder: '日记', format: 'YYYY-MM-DD', template: '模板/日记模板.md' }, null, 2), 'utf8')
  writeFileSync(join(root, '.obsidian', 'app.json'), '{}', 'utf8')
}

function makeCtx(record) {
  const ctx = {
    // top-level `inject = ['webServer']` means the loader hands the service here
    webServer: {
      register(route) {
        record.routes.push(route)
        return () => { record.routes = record.routes.filter((r) => r !== route) }
      },
    },
    tools: {
      register(def) {
        if (record.tools[def.name]) throw new Error(`duplicate tool registration: ${def.name}`)
        record.tools[def.name] = def
        return () => { delete record.tools[def.name] }
      },
    },
    effect(fn, label) {
      record.effects.push(label)
      const dispose = fn()
      record.disposers.push(dispose)
      return dispose
    },
    inject(names, callback) {
      record.injectCalls.push(names)
      for (const name of names) {
        if (ctx[name] === undefined) throw new Error(`fake ctx missing declared service ${name}`)
      }
      return callback(ctx)
    },
  }
  return ctx
}

async function main() {
  if (!existsSync(join(REPO, 'lib', 'index.js'))) {
    console.log('SKIP harness-host: lib/index.js does not exist yet')
    process.exitCode = 0
    return
  }

  const root = mkdtempSync(join(tmpdir(), 'dsh-obsidian-harness-'))
  const vault = join(root, 'vault')
  writeFixture(vault)
  const record = { routes: [], tools: {}, effects: [], injectCalls: [], disposers: [] }

  section('plugin entry contract')
  const mod = await import(pathToFileURL(join(REPO, 'lib', 'index.js')).href)
  okEq('export const name is dsh-plugin-obsidian', mod.name, 'dsh-plugin-obsidian')
  ok('apply is a function', typeof mod.apply === 'function', typeof mod.apply)
  ok('top-level inject includes webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'),
    JSON.stringify(mod.inject))

  section('apply(ctx, config) registration')
  const config = {
    vaultPath: vault,
    allowOpenInObsidian: false,
    // Keep backups inside the throwaway root: the default would be
    // $DSH_HOME/obsidian-backups, and a harness must not write the real home.
    backupDir: join(root, 'backups'),
  }
  const ctx = makeCtx(record)
  let applyError = null
  try {
    mod.apply(ctx, config)
  } catch (error) {
    applyError = error
  }
  ok('apply does not throw', applyError === null, applyError && applyError.stack)
  ok('registers exactly one prefix route for the API', record.routes.filter((r) => r.path === API).length === 1,
    JSON.stringify(record.routes.map((r) => ({ kind: r.kind, path: r.path }))))
  const route = record.routes.find((r) => r.path === API)
  ok('route kind is prefix', route && route.kind === 'prefix', route && route.kind)
  okEq('all 10 agent tools are registered with the real tools service', Object.keys(record.tools).sort(), [...TOOL_NAMES].sort())
  ok('tools were registered through ctx.inject([\'tools\'])', record.injectCalls.some((names) => names.includes('tools')),
    JSON.stringify(record.injectCalls))

  section('tool definitions shape')
  for (const name of TOOL_NAMES) {
    const def = record.tools[name]
    ok(`${name}: has description`, Boolean(def && typeof def.description === 'string' && def.description.length > 10))
    ok(`${name}: parameters is an object schema`, Boolean(def && def.parameters && def.parameters.type === 'object'))
    ok(`${name}: output.render is a function`, Boolean(def && def.output && typeof def.output.render === 'function'))
    ok(`${name}: execute is a function`, Boolean(def && typeof def.execute === 'function'))
  }

  section('real HTTP server + same-origin fence')
  const server = http.createServer((req, res) => {
    if (req.url === API || req.url.startsWith(`${API}/`)) {
      Promise.resolve(route.handler(req, res)).catch((error) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'harness-crash', message: String(error) } }))
      })
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not the plugin route')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const getJson = async (path, headers) => {
    const response = await fetch(base + path, { headers })
    let body = null
    try { body = await response.json() } catch { body = null }
    return { status: response.status, body }
  }
  const sendJson = async (path, method, payload, headers) => {
    const response = await fetch(base + path, {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, headers),
      body: JSON.stringify(payload),
    })
    let body = null
    try { body = await response.json() } catch { body = null }
    return { status: response.status, body }
  }

  try {
    let r = await getJson(`${API}/health`)
    ok('GET /health -> 200', r.status === 200, JSON.stringify(r.body))
    okEq('GET /health toolsRegistered lists all 10 tools', (r.body && r.body.toolsRegistered || []).slice().sort(), [...TOOL_NAMES].sort())
    ok('GET /health reports the vaultPath', Boolean(r.body && r.body.vaultPath && r.body.vaultPath.endsWith('vault')),
      r.body && r.body.vaultPath)

    r = await getJson(`${API}/status`)
    ok('GET /status -> 200 with counts', r.status === 200 && r.body.ok === true && r.body.noteCount >= 5,
      JSON.stringify(r.body).slice(0, 300))
    okEq('GET /status daily config auto-detected from .obsidian/daily-notes.json',
      r.body.daily && { folder: r.body.daily.folder, format: r.body.daily.format },
      { folder: '日记', format: 'YYYY-MM-DD' })

    r = await getJson(`${API}/tree?dir=&depth=2&limit=100`)
    ok('GET /tree lists folders and notes', r.status === 200 && Array.isArray(r.body.entries) && r.body.entries.length >= 4,
      JSON.stringify(r.body && r.body.entries && r.body.entries.map((e) => e.path)).slice(0, 400))
    ok('GET /tree never lists .obsidian', !JSON.stringify(r.body).includes('.obsidian'), JSON.stringify(r.body).slice(0, 300))

    r = await getJson(`${API}/note?path=${encodeURIComponent('首页.md')}`)
    ok('GET /note reads a note with frontmatter and body', r.status === 200 && r.body.note.title === '首页'
      && r.body.note.frontmatter.aliases && r.body.note.frontmatter.aliases[0] === 'Home'
      && r.body.note.content.includes('导航'),
      JSON.stringify(r.body && r.body.note && { title: r.body.note.title, fm: r.body.note.frontmatter }).slice(0, 400))

    r = await sendJson(`${API}/note`, 'POST', {
      path: '00-收件箱/测试笔记', content: '# 测试\n\n来自 harness 的内容。\n', mode: 'create',
      frontmatter: { created: '2026-11-20' }, tags: ['测试', 'harness'],
    })
    const createdPath = join(vault, '00-收件箱', '测试笔记.md')
    ok('POST /note create -> 200 and file exists', r.status === 200 && r.body.ok === true
      && existsSync(createdPath), JSON.stringify(r.body).slice(0, 300))
    const written = existsSync(createdPath) ? readFileSync(createdPath, 'utf8') : ''
    ok('written note has frontmatter + tags + body', written.startsWith('---') && written.includes('测试')
      && written.includes('# 测试'), JSON.stringify(written.slice(0, 200)))
    ok('written note has no BOM', written.length > 0 && written.charCodeAt(0) === 0x2d, written.charCodeAt(0).toString(16))

    r = await sendJson(`${API}/note`, 'POST', { path: '00-收件箱/测试笔记.md', content: '', mode: 'create' })
    ok('POST /note create on existing -> 409', r.status === 409 && r.body.error.code === 'exists', JSON.stringify(r.body))

    r = await sendJson(`${API}/note`, 'POST', { path: '../逃逸.md', content: 'x', mode: 'overwrite' })
    ok('POST /note traversal -> 400 invalid-path', r.status === 400 && r.body.error.code === 'invalid-path', JSON.stringify(r.body))

    r = await sendJson(`${API}/note`, 'POST', { path: '00-收件箱/测试笔记.md', content: '追加一行。\n', mode: 'append' })
    ok('POST /note append -> 200', r.status === 200, JSON.stringify(r.body).slice(0, 200))

    r = await getJson(`${API}/search?q=${encodeURIComponent('原子化')}`)
    ok('GET /search finds the atomic-note', r.status === 200 && r.body.results.some((x) => x.path.includes('原子化')),
      JSON.stringify(r.body && r.body.results && r.body.results.map((x) => x.path)))
    ok('GET /search results carry line + snippet', r.body.results.every((x) => typeof x.line === 'number' && typeof x.snippet === 'string'))

    r = await getJson(`${API}/search?q=${encodeURIComponent('原子化')}&mode=title`)
    ok('GET /search mode=title still finds it', r.status === 200 && r.body.results.length >= 1)

    r = await getJson(`${API}/tags`)
    ok('GET /tags aggregates frontmatter + inline tags', r.status === 200
      && r.body.tags.some((t) => t.tag === '笔记') && r.body.tags.some((t) => t.tag === '方法论'),
      JSON.stringify(r.body && r.body.tags && r.body.tags.map((t) => t.tag)))

    r = await getJson(`${API}/links?path=${encodeURIComponent('首页.md')}`)
    ok('GET /links returns wikilink targets', r.status === 200
      && r.body.outgoing.includes('欢迎'), JSON.stringify(r.body && r.body.outgoing))

    r = await getJson(`${API}/daily?date=2026-11-20`)
    ok('GET /daily read of a missing date does not create a file', r.status === 200
      && r.body.daily.created === false && !existsSync(join(vault, '日记', '2026-11-20.md')),
      JSON.stringify(r.body && r.body.daily).slice(0, 200))

    r = await sendJson(`${API}/daily`, 'POST', { date: '2026-11-20', mode: 'append', content: '- 来自 harness 的日记行\n' })
    ok('POST /daily append creates from template and appends', r.status === 200
      && existsSync(join(vault, '日记', '2026-11-20.md')), JSON.stringify(r.body).slice(0, 300))
    if (existsSync(join(vault, '日记', '2026-11-20.md'))) {
      const daily = readFileSync(join(vault, '日记', '2026-11-20.md'), 'utf8')
      ok('daily note uses the template (date token replaced)', daily.includes('# 2026-11-20') && daily.includes('来自 harness 的日记行'),
        JSON.stringify(daily.slice(0, 200)))
    }

    r = await sendJson(`${API}/manage`, 'POST', { action: 'move', from: '00-收件箱/测试笔记.md', to: '03-归档/测试笔记.md' })
    ok('POST /manage move -> 200 and destination exists', r.status === 200
      && existsSync(join(vault, '03-归档', '测试笔记.md')), JSON.stringify(r.body))

    r = await sendJson(`${API}/manage`, 'POST', { action: 'trash', path: '03-归档/测试笔记.md' })
    ok('POST /manage trash -> 200 and original gone', r.status === 200
      && !existsSync(join(vault, '03-归档', '测试笔记.md')), JSON.stringify(r.body))

    r = await getJson(`${API}/open`, { 'sec-fetch-site': 'cross-site' })
    ok('cross-site request -> 403', r.status === 403, JSON.stringify(r.body))
    r = await getJson(`${API}/status`, { origin: 'http://evil.example' })
    ok('foreign Origin -> 403', r.status === 403, JSON.stringify(r.body))
    r = await sendJson(`${API}/status`, 'DELETE', {})
    ok('wrong method -> 405', r.status === 405, JSON.stringify(r.body))
    r = await getJson(`${API}/no-such-route`)
    ok('unknown route -> 404', r.status === 404, JSON.stringify(r.body))
    r = await getJson(`${API}/note?path=${encodeURIComponent('nope.md')}`)
    ok('missing note -> 404 not-found', r.status === 404 && r.body.error.code === 'not-found', JSON.stringify(r.body))
  } finally {
    // tools execute against the same real plugin instance
    section('agent tools execute through the registered definitions')
    const exec = async (name, args) => {
      const def = record.tools[name]
      if (!def) throw new Error(`tool not registered: ${name}`)
      return def.execute(args, { signal: { aborted: false } })
    }
    try {
      const status = await exec('obsidian_status', {})
      ok('tool obsidian_status returns vaultPath + counts', Boolean(status && status.vaultPath && status.noteCount >= 5),
        JSON.stringify(status).slice(0, 200))

      const list = await exec('obsidian_list', { dir: '01-笔记', depth: 2 })
      ok('tool obsidian_list lists the folder', Array.isArray(list.entries)
        && list.entries.some((e) => e.path.includes('原子化')), JSON.stringify(list.entries).slice(0, 300))

      const read = await exec('obsidian_read', { path: '01-笔记/为什么笔记要原子化.md' })
      ok('tool obsidian_read returns frontmatter tags', read && read.frontmatter.tags && read.frontmatter.tags.includes('方法'),
        JSON.stringify(read && read.frontmatter))

      const search = await exec('obsidian_search', { query: '笔记', limit: 5 })
      ok('tool obsidian_search returns hits with snippets', search && search.results.length > 0
        && typeof search.results[0].snippet === 'string')

      const write = await exec('obsidian_write', {
        path: '00-收件箱/工具写入', content: '工具写入的内容。', mode: 'create', tags: ['工具'],
      })
      ok('tool obsidian_write creates the note', write && write.created === true
        && existsSync(join(vault, '00-收件箱', '工具写入.md')))

      const daily = await exec('obsidian_daily', { date: '2026-11-21', mode: 'append', content: '- 工具写的\n' })
      ok('tool obsidian_daily creates the daily note', daily && daily.path.endsWith('2026-11-21.md'))

      const tags = await exec('obsidian_tags', {})
      ok('tool obsidian_tags lists tags', tags && Array.isArray(tags.tags) && tags.tags.length > 0)

      const links = await exec('obsidian_links', { path: '首页.md' })
      ok('tool obsidian_links returns outgoing + backlinks keys', links
        && Array.isArray(links.outgoing) && Array.isArray(links.backlinks))

      const open = await exec('obsidian_open', { path: '首页.md' })
      ok('tool obsidian_open returns a obsidian:// URI and does not launch when disabled',
        open && typeof open.uri === 'string' && open.uri.startsWith('obsidian://open?')
        && open.opened === false, JSON.stringify(open))

      const moved = await exec('obsidian_manage', { action: 'move', from: '00-收件箱/工具写入.md', to: '03-归档/工具写入.md' })
      ok('tool obsidian_manage moves', moved && existsSync(join(vault, '03-归档', '工具写入.md')))

      const trashed = await exec('obsidian_manage', { action: 'trash', path: '03-归档/工具写入.md' })
      ok('tool obsidian_manage trashes', trashed && trashed.trashed === true)

      // Error paths keep their code in the message (agent gets an actionable error).
      let err = null
      try { await exec('obsidian_read', { path: '../etc/passwd' }) } catch (error) { err = error }
      ok('tool rejects traversal with invalid-path', err !== null && /invalid-path|invalid path|非法/i.test(err.message),
        err && err.message)
      err = null
      try { await exec('obsidian_read', { path: '不存在.md' }) } catch (error) { err = error }
      ok('tool rejects missing note with not-found', err !== null && /not-found|不存在/i.test(err.message), err && err.message)
    } catch (error) {
      ok('tool execution block completed', false, error && error.stack)
    }

    section('render() produces model-visible text')
    try {
      const def = record.tools.obsidian_status
      const value = await def.execute({}, { signal: { aborted: false } })
      const blocks = def.output.render({}, value)
      ok('render returns [{type:text}]', Array.isArray(blocks) && blocks[0] && blocks[0].type === 'text'
        && typeof blocks[0].text === 'string' && blocks[0].text.length > 20, JSON.stringify(blocks).slice(0, 200))
    } catch (error) {
      ok('render() produces model-visible text', false, error && error.stack)
    }

    // Cleanup registrations and the server.
    for (const dispose of record.disposers) {
      try { dispose() } catch { /* already disposed */ }
    }
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\nharness-host: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(`failed checks:\n - ${failures.join('\n - ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('harness-host crashed:', error && error.stack || error)
  process.exitCode = 1
})
