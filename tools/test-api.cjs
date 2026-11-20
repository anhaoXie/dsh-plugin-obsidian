#!/usr/bin/env node
/**
 * test-api.cjs — 离线测试 lib/api.js（SPEC §5）+ lib/index.js 的接线。
 *
 * 用假 req/res 直接调用 createApi(...).handle(req,res)：
 * 同源 fence、方法/路由分发、错误码→HTTP 映射、1 MiB 请求体上限、
 * /health.toolsRegistered、dispose，以及真实 apply(ctx, config) 的端到端接线。
 *
 * 运行：node tools/test-api.cjs
 */
'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO = path.resolve(__dirname, '..')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-obsidian-test-api-'))
const ORIGINAL_DSH_HOME = process.env.DSH_HOME
const ORIGINAL_VAULT_ENV = process.env.DSH_OBSIDIAN_VAULT
process.env.DSH_HOME = path.join(ROOT, 'dsh-home')
delete process.env.DSH_OBSIDIAN_VAULT

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    failures.push(name)
    console.log(`FAIL ${name}`)
    const stack = error && error.stack ? String(error.stack) : String(error)
    console.log(stack.split('\n').slice(0, 6).map((line) => `     ${line}`).join('\n'))
  }
}

// ── 假 HTTP req / res ─────────────────────────────────────────────────────

function makeRequest({ method = 'GET', url = '/dsh-obsidian/api/health', headers = {}, rawBody } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:5558', ...headers }
  req.readableEnded = false
  req.destroyed = false
  req.destroy = () => {
    req.destroyed = true
  }
  let payload = null
  if (rawBody !== undefined) payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')
  process.nextTick(() => {
    if (req.destroyed) return
    if (payload) req.emit('data', payload)
    req.readableEnded = true
    req.emit('end')
  })
  return req
}

function makeResponse() {
  const res = {
    statusCode: 0,
    headers: null,
    bodyText: '',
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers || {}
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.bodyText += String(chunk)
      this.ended = true
    },
    json() {
      try {
        return JSON.parse(this.bodyText)
      } catch {
        return null
      }
    },
  }
  return res
}

async function call(api, options = {}) {
  const req = makeRequest(options)
  const res = makeResponse()
  await api.handle(req, res)
  return { status: res.statusCode, headers: res.headers || {}, body: res.json(), raw: res.bodyText }
}

function makeVaultFixture(createVault, label) {
  const base = path.join(ROOT, label)
  const vaultPath = path.join(base, 'vault')
  const backupDir = path.join(base, 'backups')
  fs.mkdirSync(vaultPath, { recursive: true })
  const vault = createVault({ vaultPath, backupDir, now: () => new Date(2024, 0, 2, 3, 4, 5) })
  return { base, vaultPath, backupDir, vault }
}

/** 一次 apply() 的假 ctx（形状与 tools/harness-host.cjs 一致）。 */
function makeCtx(record) {
  const ctx = {
    webServer: {
      register(route) {
        record.routes.push(route)
        return () => {
          record.routes = record.routes.filter((candidate) => candidate !== route)
        }
      },
    },
    tools: {
      register(definition) {
        record.tools.push(definition)
        return () => {
          record.tools = record.tools.filter((candidate) => candidate !== definition)
        }
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
      return callback(ctx)
    },
  }
  return ctx
}

async function main() {
  const vaultMod = await import(pathToFileURL(path.join(REPO, 'lib', 'vault.js')).href)
  const apiMod = await import(pathToFileURL(path.join(REPO, 'lib', 'api.js')).href)
  const indexMod = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  const { createVault } = vaultMod
  const { createApi, API_PREFIX } = apiMod

  const fixture = makeVaultFixture(createVault, 'api-fx')
  const { vault, vaultPath, backupDir } = fixture
  vault.write({ path: '01-笔记/欢迎', content: '---\ntags: [欢迎]\n---\n# 欢迎\n\n这是 api 测试笔记。\n', mode: 'create' })
  vault.write({ path: '01-笔记/第二篇', content: '# 第二篇\n\n包含 needle 关键词。\n', mode: 'create' })

  const config = { allowOpenInObsidian: false }
  const state = { toolsRegistered: ['obsidian_status', 'obsidian_read'] }
  const launcherCalls = []
  const api = createApi(null, {
    getVault: () => vault,
    getConfig: () => config,
    getState: () => state,
    version: '9.9.9-test',
  })

  console.log(`fixtures: ${ROOT}`)
  console.log(`node ${process.version}`)
  console.log('')

  await test('contract: createApi returns handle()/dispose(); API_PREFIX is frozen at /dsh-obsidian/api', () => {
    assert.equal(API_PREFIX, '/dsh-obsidian/api')
    assert.equal(typeof api.handle, 'function')
    assert.equal(typeof api.dispose, 'function')
  })

  // ── /health ─────────────────────────────────────────────────────────────
  await test('GET /health: ok, vaultPath, injected toolsRegistered, version, JSON headers', async () => {
    const result = await call(api)
    assert.equal(result.status, 200)
    assert.match(String(result.headers['content-type']), /application\/json/)
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.equal(result.body.ok, true)
    assert.equal(result.body.vaultPath, path.resolve(vaultPath))
    assert.equal(result.body.vaultAvailable, true)
    assert.deepEqual(result.body.toolsRegistered, ['obsidian_status', 'obsidian_read'])
    assert.equal(result.body.version, '9.9.9-test')

    state.toolsRegistered = ['a', 'b', 'c']
    const again = await call(api)
    assert.deepEqual(again.body.toolsRegistered, ['a', 'b', 'c'], 'health must read state each call')
    state.toolsRegistered = ['obsidian_status', 'obsidian_read']
  })

  // ── 读路由 ──────────────────────────────────────────────────────────────
  await test('GET /status, /tree, /note, /search, /tags, /links', async () => {
    let result = await call(api, { url: `${API_PREFIX}/status` })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.available, true)
    assert.ok(result.body.noteCount >= 2)

    result = await call(api, { url: `${API_PREFIX}/tree?dir=&depth=2&limit=50` })
    assert.equal(result.status, 200)
    assert.ok(Array.isArray(result.body.entries))
    assert.ok(result.body.entries.some((entry) => entry.path === '01-笔记' && entry.type === 'folder'))

    result = await call(api, { url: `${API_PREFIX}/tree?dir=no-such-dir` })
    assert.equal(result.status, 404)
    assert.equal(result.body.error.code, 'not-found')

    result = await call(api, { url: `${API_PREFIX}/note?path=${encodeURIComponent('01-笔记/欢迎')}` })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.note.title, '欢迎')
    assert.ok(result.body.note.content.includes('api 测试笔记'))
    assert.deepEqual(result.body.note.frontmatter.tags, ['欢迎'])

    result = await call(api, { url: `${API_PREFIX}/note?path=missing-note` })
    assert.equal(result.status, 404)
    assert.equal(result.body.error.code, 'not-found')

    result = await call(api, { url: `${API_PREFIX}/note` })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'invalid-path')

    result = await call(api, { url: `${API_PREFIX}/search?q=needle` })
    assert.equal(result.status, 200)
    assert.ok(result.body.results.some((item) => item.path === '01-笔记/第二篇.md'))
    assert.equal(typeof result.body.total, 'number')

    result = await call(api, { url: `${API_PREFIX}/search?q=` })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'invalid-path')

    result = await call(api, { url: `${API_PREFIX}/tags` })
    assert.equal(result.status, 200)
    assert.ok(result.body.tags.some((entry) => entry.tag === '欢迎'))

    result = await call(api, { url: `${API_PREFIX}/links?path=${encodeURIComponent('01-笔记/欢迎')}` })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.outgoing, [])
    result = await call(api, { url: `${API_PREFIX}/links` })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'invalid-path')
  })

  // ── 写路由 / 方法路由回归 ───────────────────────────────────────────────
  await test('POST /note: routes by method (regression: must not be 405), create/append/409/400', async () => {
    const created = await call(api, {
      method: 'POST',
      url: `${API_PREFIX}/note`,
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify({ path: '00-收件箱/api 新建', content: '# API\n\n内容\n', mode: 'create', tags: ['api'] }),
    })
    assert.equal(created.status, 200, `POST /note must route to write; body=${created.raw}`)
    assert.equal(created.body.ok, true)
    assert.equal(created.body.result.created, true)
    assert.equal(created.body.result.path, '00-收件箱/api 新建.md')

    const duplicate = await call(api, {
      method: 'POST',
      url: `${API_PREFIX}/note`,
      rawBody: JSON.stringify({ path: '00-收件箱/api 新建.md', content: '', mode: 'create' }),
    })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.error.code, 'exists')

    const traversal = await call(api, {
      method: 'POST',
      url: `${API_PREFIX}/note`,
      rawBody: JSON.stringify({ path: '../逃逸.md', content: 'x', mode: 'overwrite' }),
    })
    assert.equal(traversal.status, 400)
    assert.equal(traversal.body.error.code, 'invalid-path')

    const append = await call(api, {
      method: 'POST',
      url: `${API_PREFIX}/note`,
      rawBody: JSON.stringify({ path: '00-收件箱/api 新建', content: '追加内容', mode: 'append' }),
    })
    assert.equal(append.status, 200)
    assert.equal(append.body.result.mode, 'append')

    const readBack = await call(api, { url: `${API_PREFIX}/note?path=${encodeURIComponent('00-收件箱/api 新建')}` })
    assert.ok(readBack.body.note.content.includes('追加内容'))
    assert.ok(readBack.body.note.tags.includes('api'))
  })

  await test('POST /manage: move/trash; GET /manage -> 405; GET /daily; POST /daily', async () => {
    let result = await call(api, {
      method: 'POST',
      url: `${API_PREFIX}/manage`,
      rawBody: JSON.stringify({ action: 'move', from: '00-收件箱/api 新建', to: '03-归档/api 新建' }),
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.result.action, 'move')
    assert.ok(fs.existsSync(path.join(vaultPath, '03-归档', 'api 新建.md')))

    result = await call(api, {
      method: 'POST',
      url: `${API_PREFIX}/manage`,
      rawBody: JSON.stringify({ action: 'trash', path: '03-归档/api 新建' }),
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.result.trashed, true)
    assert.equal(fs.existsSync(path.join(vaultPath, '03-归档', 'api 新建.md')), false)

    result = await call(api, { url: `${API_PREFIX}/manage` })
    assert.equal(result.status, 405)
    assert.equal(result.body.error.code, 'method-not-allowed')

    result = await call(api, { url: `${API_PREFIX}/daily?date=2024-06-01` })
    assert.equal(result.status, 200)
    assert.equal(result.body.daily.created, false)
    assert.equal(result.body.daily.path, '2024-06-01.md')

    result = await call(api, {
      method: 'POST',
      url: `${API_PREFIX}/daily`,
      rawBody: JSON.stringify({ date: '2024-06-01', mode: 'append', content: 'api 日记内容' }),
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.daily.created, true)
    assert.ok(result.body.daily.content.includes('api 日记内容'))
  })

  // ── /open ───────────────────────────────────────────────────────────────
  await test('POST /open: disabled config -> opened:false; launcher -> opened:true; bad path -> 400', async () => {
    let result = await call(api, {
      method: 'POST',
      url: `${API_PREFIX}/open`,
      rawBody: JSON.stringify({ path: '01-笔记/欢迎' }),
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.result.opened, false)
    assert.equal(result.body.result.path, '01-笔记/欢迎.md')
    assert.ok(result.body.result.uri.startsWith('obsidian://open?vault='))
    assert.ok(result.body.result.uri.includes('&file=01-%E7%AC%94%E8%AE%B0%2F%E6%AC%A2%E8%BF%8E'))

    config.allowOpenInObsidian = true
    config.launcher = (uri) => launcherCalls.push(uri)
    result = await call(api, {
      method: 'POST',
      url: `${API_PREFIX}/open`,
      rawBody: JSON.stringify({ path: '01-笔记/欢迎' }),
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.result.opened, true)
    assert.equal(launcherCalls.length, 1)
    assert.equal(launcherCalls[0], result.body.result.uri)
    delete config.launcher
    config.allowOpenInObsidian = false

    result = await call(api, {
      method: 'POST',
      url: `${API_PREFIX}/open`,
      rawBody: JSON.stringify({ path: '../escape' }),
    })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'invalid-path')
  })

  // ── 同源 fence ──────────────────────────────────────────────────────────
  await test('same-origin fence: cross-site/sec-fetch-site and foreign Origin -> 403', async () => {
    let result = await call(api, { headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(result.status, 403)
    assert.equal(result.body.ok, false)
    assert.equal(result.body.error.code, 'cross-site-request-rejected')

    result = await call(api, { headers: { origin: 'http://evil.example' } })
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, 'cross-site-request-rejected')

    result = await call(api, { headers: { origin: 'not a url' } })
    assert.equal(result.status, 403)

    // 同源 Origin（与 Host 一致）允许
    result = await call(api, { headers: { origin: 'http://127.0.0.1:5558', host: '127.0.0.1:5558' } })
    assert.equal(result.status, 200)

    // Origin: null 允许（同源策略下 sandbox iframe 等）
    result = await call(api, { headers: { origin: 'null' } })
    assert.equal(result.status, 200)

    // 无 Origin / sec-fetch-site 的本地脚本请求允许
    result = await call(api, {})
    assert.equal(result.status, 200)
  })

  // ── 路由 / 方法错误 ─────────────────────────────────────────────────────
  await test('routing errors: unknown route 404, wrong method 405, method list in message', async () => {
    let result = await call(api, { url: `${API_PREFIX}/no-such-route` })
    assert.equal(result.status, 404)
    assert.equal(result.body.error.code, 'not-found')

    result = await call(api, { url: '/dsh-obsidian/other' })
    assert.equal(result.status, 404)

    result = await call(api, { method: 'POST', url: `${API_PREFIX}/status` })
    assert.equal(result.status, 405)
    assert.equal(result.body.error.code, 'method-not-allowed')
    assert.ok(result.body.error.message.includes('GET'))

    result = await call(api, { method: 'DELETE', url: `${API_PREFIX}/note` })
    assert.equal(result.status, 405)
    assert.ok(result.body.error.message.includes('GET'))
    assert.ok(result.body.error.message.includes('POST'))

    result = await call(api, { method: 'GET', url: `${API_PREFIX}/manage` })
    assert.equal(result.status, 405)

    // 方法分发：GET /note 仍走 read，不是 405
    result = await call(api, { url: `${API_PREFIX}/note?path=${encodeURIComponent('01-笔记/欢迎')}` })
    assert.equal(result.status, 200)
  })

  // ── 请求体错误 ──────────────────────────────────────────────────────────
  await test('body errors: invalid JSON / non-object / empty body / >1 MiB -> 400 bad-request', async () => {
    let result = await call(api, { method: 'POST', url: `${API_PREFIX}/note`, rawBody: '{bad json' })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'bad-request')

    result = await call(api, { method: 'POST', url: `${API_PREFIX}/note`, rawBody: '[]' })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'bad-request')

    // 空请求体 → 视为 {} → 后续参数校验 400 invalid-path
    result = await call(api, { method: 'POST', url: `${API_PREFIX}/note`, rawBody: '' })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'invalid-path')

    // 合法 JSON 但超过 1 MiB
    const huge = JSON.stringify({ path: 'big', content: 'x'.repeat(1100 * 1024) })
    assert.ok(Buffer.byteLength(huge) > 1024 * 1024)
    result = await call(api, { method: 'POST', url: `${API_PREFIX}/note`, rawBody: huge })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'bad-request')
    assert.ok(result.body.error.message.includes('1 MiB'))

    // 声明的 content-length 超限（无需真的发送 body）
    result = await call(api, {
      method: 'POST',
      url: `${API_PREFIX}/note`,
      headers: { 'content-length': String(2 * 1024 * 1024) },
    })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'bad-request')
  })

  // ── 错误码映射 ──────────────────────────────────────────────────────────
  await test('VaultError -> HTTP mapping: too-large 400, outside-vault 400, internal 500', async () => {
    const limitsBase = path.join(ROOT, 'limits-fx')
    const limitsVaultPath = path.join(limitsBase, 'vault')
    fs.mkdirSync(limitsVaultPath, { recursive: true })
    const limitsVault = createVault({ vaultPath: limitsVaultPath, backupDir: path.join(limitsBase, 'backups'), maxFileBytes: 32 })
    fs.writeFileSync(path.join(limitsVaultPath, 'big.md'), '# big\n\n' + 'x'.repeat(200), 'utf8')
    const limitsApi = createApi(null, { getVault: () => limitsVault, getConfig: () => ({}), getState: () => ({ toolsRegistered: [] }) })
    let result = await call(limitsApi, { url: `${API_PREFIX}/note?path=big` })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'too-large')

    // outside-vault：junction 指向 vault 外
    const escapeBase = path.join(ROOT, 'escape-fx')
    const escapeVaultPath = path.join(escapeBase, 'vault')
    const outside = path.join(escapeBase, 'outside')
    fs.mkdirSync(escapeVaultPath, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    const escapeVault = createVault({ vaultPath: escapeVaultPath, backupDir: path.join(escapeBase, 'backups') })
    const junction = path.join(escapeVaultPath, 'evil')
    let junctionCreated = false
    try {
      fs.symlinkSync(outside, junction, 'junction')
      junctionCreated = true
    } catch {
      junctionCreated = false
    }
    if (junctionCreated) {
      const escapeApi = createApi(null, { getVault: () => escapeVault, getConfig: () => ({}), getState: () => ({ toolsRegistered: [] }) })
      result = await call(escapeApi, {
        method: 'POST',
        url: `${API_PREFIX}/note`,
        rawBody: JSON.stringify({ path: 'evil/note.md', content: 'x', mode: 'create' }),
      })
      assert.equal(result.status, 400)
      assert.equal(result.body.error.code, 'outside-vault')
      try {
        fs.rmdirSync(junction)
      } catch {
        /* ignore */
      }
    } else {
      console.log('SKIP outside-vault HTTP mapping :: 无法创建 junction')
    }

    // 非 VaultError → 500 internal-error（不泄露堆栈）
    const brokenVault = {
      root: limitsVaultPath,
      available: true,
      status() {
        return { ok: true, available: true, vaultPath: limitsVaultPath }
      },
      read() {
        throw new Error('boom from fake vault')
      },
    }
    const brokenApi = createApi(null, { getVault: () => brokenVault, getConfig: () => ({}), getState: () => ({ toolsRegistered: [] }) })
    result = await call(brokenApi, { url: `${API_PREFIX}/note?path=x` })
    assert.equal(result.status, 500)
    assert.equal(result.body.error.code, 'internal-error')
    assert.equal(result.body.error.message, 'boom from fake vault')
    assert.equal(result.raw.includes('at '), false, 'must not leak stack traces')
  })

  // ── vault 不可用 / dispose ─────────────────────────────────────────────
  await test('vault unavailable: /health 200 with null path, /status reports, data routes 503', async () => {
    const unavailable = createApi(null, {
      getVault: () => createVault({}),
      getConfig: () => ({}),
      getState: () => ({ toolsRegistered: [] }),
      version: '0.1.0',
    })
    let result = await call(unavailable, { url: `${API_PREFIX}/health` })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.vaultPath, null)
    assert.equal(result.body.vaultAvailable, false)

    result = await call(unavailable, { url: `${API_PREFIX}/status` })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.available, false)
    assert.equal(result.body.error.code, 'vault-unavailable')

    result = await call(unavailable, { url: `${API_PREFIX}/tree` })
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'vault-unavailable')

    const nullVault = createApi(null, { getVault: () => null, getConfig: () => ({}), getState: () => ({}) })
    result = await call(nullVault, { url: `${API_PREFIX}/health` })
    assert.equal(result.status, 200)
    assert.equal(result.body.vaultPath, null)
    assert.deepEqual(result.body.toolsRegistered, [])
    result = await call(nullVault, { url: `${API_PREFIX}/tags` })
    assert.equal(result.status, 503)
  })

  await test('dispose(): subsequent requests -> 503 vault-unavailable', async () => {
    const disposable = createApi(null, {
      getVault: () => vault,
      getConfig: () => config,
      getState: () => ({ toolsRegistered: [] }),
    })
    let result = await call(disposable, {})
    assert.equal(result.status, 200)
    disposable.dispose()
    result = await call(disposable, {})
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'vault-unavailable')
  })

  // ── index.js apply() 端到端接线 ─────────────────────────────────────────
  await test('lib/index.js: exports contract + apply registers 10 tools and one prefix route', () => {
    assert.equal(indexMod.name, 'dsh-plugin-obsidian')
    assert.ok(Array.isArray(indexMod.inject) && indexMod.inject.includes('webServer'), JSON.stringify(indexMod.inject))
    assert.equal(typeof indexMod.apply, 'function')

    const record = { routes: [], tools: [], effects: [], disposers: [], injectCalls: [] }
    const ctx = makeCtx(record)
    let applyError = null
    try {
      indexMod.apply(ctx, { vaultPath, allowOpenInObsidian: false })
    } catch (error) {
      applyError = error
    }
    assert.equal(applyError, null, applyError && applyError.stack)
    assert.equal(record.routes.length, 1)
    assert.equal(record.routes[0].kind, 'prefix')
    assert.equal(record.routes[0].path, API_PREFIX)
    assert.equal(typeof record.routes[0].handler, 'function')
    assert.equal(record.tools.length, 10)
    assert.deepEqual(
      record.tools.map((definition) => definition.name),
      [
        'obsidian_status',
        'obsidian_list',
        'obsidian_read',
        'obsidian_search',
        'obsidian_write',
        'obsidian_manage',
        'obsidian_daily',
        'obsidian_tags',
        'obsidian_links',
        'obsidian_open',
      ],
    )
    assert.ok(record.injectCalls.some((names) => names.includes('tools')))
    assert.ok(record.effects.some((label) => String(label).includes('http api')))
  })

  await test('lib/index.js: real handler end-to-end (health has 10 tools, POST note works)', async () => {
    const record = { routes: [], tools: [], effects: [], disposers: [], injectCalls: [] }
    const ctx = makeCtx(record)
    indexMod.apply(ctx, { vaultPath, allowOpenInObsidian: false })
    const handlers = record.routes.map((route) => route.handler)

    // handler 直接驱动（等价于 DSH webServer 前缀挂载）
    const drive = async (options) => {
      const req = makeRequest(options)
      const res = makeResponse()
      await handlers[0](req, res)
      return { status: res.statusCode, body: res.json(), raw: res.bodyText }
    }

    let result = await drive({ url: `${API_PREFIX}/health` })
    assert.equal(result.status, 200)
    assert.equal(result.body.toolsRegistered.length, 10, JSON.stringify(result.body.toolsRegistered))
    assert.equal(result.body.vaultPath, path.resolve(vaultPath))

    result = await drive({ url: `${API_PREFIX}/status` })
    assert.equal(result.status, 200)
    assert.equal(result.body.available, true)

    result = await drive({
      method: 'POST',
      url: `${API_PREFIX}/note`,
      rawBody: JSON.stringify({ path: 'apply-fx/从 apply 写入', content: '# Apply\n\n内容\n', mode: 'create' }),
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.result.created, true)

    result = await drive({ url: `${API_PREFIX}/note?path=${encodeURIComponent('apply-fx/从 apply 写入')}` })
    assert.equal(result.status, 200)
    assert.equal(result.body.note.title, 'Apply')

    // 释放 effect：路由 disposer 必须让 API 停止服务
    for (const dispose of record.disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    result = await drive({ url: `${API_PREFIX}/health` })
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'vault-unavailable')
  })

  await test('lib/index.js: vault path priority config > env > discovery; never throws when vault missing', async () => {
    const otherFixture = makeVaultFixture(createVault, 'env-fx')
    process.env.DSH_OBSIDIAN_VAULT = otherFixture.vaultPath

    // 只有 env：使用 env
    let record = { routes: [], tools: [], effects: [], disposers: [], injectCalls: [] }
    let ctx = makeCtx(record)
    indexMod.apply(ctx, { allowOpenInObsidian: false })
    let res = makeResponse()
    await record.routes[0].handler(makeRequest({ url: `${API_PREFIX}/health` }), res)
    assert.equal(res.json().vaultPath, path.resolve(otherFixture.vaultPath))
    for (const dispose of record.disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }

    // config.vaultPath 优先于 env
    record = { routes: [], tools: [], effects: [], disposers: [], injectCalls: [] }
    ctx = makeCtx(record)
    indexMod.apply(ctx, { vaultPath, allowOpenInObsidian: false })
    res = makeResponse()
    await record.routes[0].handler(makeRequest({ url: `${API_PREFIX}/health` }), res)
    assert.equal(res.json().vaultPath, path.resolve(vaultPath))
    for (const dispose of record.disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }

    // Schema 形态（.get()）也应被支持
    record = { routes: [], tools: [], effects: [], disposers: [], injectCalls: [] }
    ctx = makeCtx(record)
    indexMod.apply(ctx, { vaultPath: { get: () => vaultPath }, allowOpenInObsidian: false })
    res = makeResponse()
    await record.routes[0].handler(makeRequest({ url: `${API_PREFIX}/health` }), res)
    assert.equal(res.json().vaultPath, path.resolve(vaultPath))
    for (const dispose of record.disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }

    // vault 不存在：apply 不抛错，health/status 如实报告
    record = { routes: [], tools: [], effects: [], disposers: [], injectCalls: [] }
    ctx = makeCtx(record)
    let applyError = null
    try {
      indexMod.apply(ctx, { vaultPath: path.join(ROOT, 'definitely-missing-vault'), allowOpenInObsidian: false })
    } catch (error) {
      applyError = error
    }
    assert.equal(applyError, null, applyError && applyError.stack)
    res = makeResponse()
    await record.routes[0].handler(makeRequest({ url: `${API_PREFIX}/health` }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().vaultAvailable, false)
    const statusRes = makeResponse()
    await record.routes[0].handler(makeRequest({ url: `${API_PREFIX}/status` }), statusRes)
    assert.equal(statusRes.statusCode, 200)
    assert.equal(statusRes.json().available, false)
    for (const dispose of record.disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }

    // 清理 env
    if (ORIGINAL_VAULT_ENV === undefined) delete process.env.DSH_OBSIDIAN_VAULT
    else process.env.DSH_OBSIDIAN_VAULT = ORIGINAL_VAULT_ENV
  })

  // ── 汇总 ────────────────────────────────────────────────────────────────
  console.log('')
  console.log(`test-api: ${passed} passed, ${failed} failed（fixtures: ${ROOT}）`)
  if (failed > 0) {
    console.log(`failed checks:\n - ${failures.join('\n - ')}`)
    process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error('test-api crashed:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  })
  .finally(() => {
    if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = ORIGINAL_DSH_HOME
    if (ORIGINAL_VAULT_ENV === undefined) delete process.env.DSH_OBSIDIAN_VAULT
    else process.env.DSH_OBSIDIAN_VAULT = ORIGINAL_VAULT_ENV
    try {
      fs.rmSync(ROOT, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
