#!/usr/bin/env node
/**
 * test-tools.cjs — 离线测试 lib/tools.js（SPEC §4）。
 *
 * 用临时 vault + 假 getVault/getConfig 直接调用 createTools()，
 * 覆盖 10 个工具的定义形状、execute 结构化返回、render(_args, value)、
 * 取消信号、错误 code 保留、配置热切换与 vault 不可用路径。
 *
 * 运行：node tools/test-tools.cjs
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO = path.resolve(__dirname, '..')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-obsidian-test-tools-'))
const ORIGINAL_DSH_HOME = process.env.DSH_HOME
process.env.DSH_HOME = path.join(ROOT, 'dsh-home')

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
    console.log(stack.split('\n').slice(0, 5).map((line) => `     ${line}`).join('\n'))
  }
}

async function expectToolError(promise, codeFragment, label) {
  let thrown = null
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== null, `${label}：期望抛错但没有`)
  assert.ok(thrown instanceof Error, `${label}：抛出的不是 Error`)
  if (codeFragment) {
    assert.ok(
      String(thrown.message).includes(`[${codeFragment}]`) || String(thrown.message).includes(codeFragment),
      `${label}：错误应保留 code ${codeFragment}，实际 message=${thrown.message}`,
    )
  }
  return thrown
}

async function main() {
  const vaultMod = await import(pathToFileURL(path.join(REPO, 'lib', 'vault.js')).href)
  const toolsMod = await import(pathToFileURL(path.join(REPO, 'lib', 'tools.js')).href)
  const { createVault } = vaultMod
  const { TOOL_NAMES, createTools } = toolsMod

  const base = path.join(ROOT, 'tools-fx')
  const vaultPath = path.join(base, 'vault')
  const backupDir = path.join(base, 'backups')
  fs.mkdirSync(vaultPath, { recursive: true })

  const vault = createVault({ vaultPath, backupDir, now: () => new Date(2024, 0, 2, 3, 4, 5) })
  /** 可变的配置对象：验证工具每次执行都重新读取配置。 */
  const config = { allowOpenInObsidian: false }
  const launcherCalls = []
  let currentVault = vault

  const tools = createTools({
    getVault: () => currentVault,
    getConfig: () => config,
  })
  const byName = new Map(tools.map((definition) => [definition.name, definition]))
  const exec = (name, args, execArg) => {
    const definition = byName.get(name)
    if (!definition) throw new Error(`tool not found: ${name}`)
    return definition.execute(args, execArg === undefined ? { signal: { aborted: false } } : execArg)
  }

  console.log(`fixtures: ${ROOT}`)
  console.log(`node ${process.version}`)
  console.log('')

  // ── 定义形状 ────────────────────────────────────────────────────────────
  await test('TOOL_NAMES: exactly the 10 frozen obsidian_* names in order', () => {
    assert.equal(TOOL_NAMES.length, 10)
    assert.deepEqual(
      [...TOOL_NAMES],
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
    assert.equal(tools.length, 10)
    assert.deepEqual(tools.map((definition) => definition.name), [...TOOL_NAMES])
  })

  await test('tool definitions: JSON-Schema parameters, Chinese description, output.schema/render', () => {
    const requiredByTool = {
      obsidian_status: [],
      obsidian_list: [],
      obsidian_read: ['path'],
      obsidian_search: ['query'],
      obsidian_write: ['path'],
      obsidian_manage: ['action'],
      obsidian_daily: [],
      obsidian_tags: [],
      obsidian_links: ['path'],
      obsidian_open: ['path'],
    }
    for (const definition of tools) {
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length >= 20, `${definition.name}: description too short`)
      assert.match(definition.description, /[\u4e00-\u9fff]/u, `${definition.name}: description should be Chinese`)
      assert.equal(definition.parameters.type, 'object', `${definition.name}: parameters.type`)
      assert.equal(definition.parameters.additionalProperties, false, `${definition.name}: additionalProperties`)
      assert.equal(typeof definition.parameters.properties, 'object')
      assert.deepEqual([...(definition.parameters.required || [])].sort(), [...requiredByTool[definition.name]].sort(),
        `${definition.name}: required`)
      assert.equal(typeof definition.output, 'object')
      assert.equal(definition.output.schema.type, 'object')
      assert.equal(typeof definition.output.render, 'function')
      assert.equal(typeof definition.execute, 'function')
      for (const propertyName of Object.keys(definition.parameters.properties)) {
        const property = definition.parameters.properties[propertyName]
        assert.ok(property && typeof property === 'object', `${definition.name}.${propertyName}: property schema`)
      }
    }
    // 关键枚举/默认值按 SPEC 冻结
    assert.deepEqual(byName.get('obsidian_search').parameters.properties.mode.enum, ['all', 'title', 'content', 'tag'])
    assert.deepEqual(byName.get('obsidian_write').parameters.properties.mode.enum, ['overwrite', 'create', 'append', 'prepend'])
    assert.equal(byName.get('obsidian_write').parameters.properties.mode.default, 'create')
    assert.deepEqual(byName.get('obsidian_manage').parameters.properties.action.enum, ['move', 'trash'])
    assert.deepEqual(byName.get('obsidian_daily').parameters.properties.mode.enum, ['read', 'append', 'create'])
    assert.equal(byName.get('obsidian_daily').parameters.properties.mode.default, 'read')
    assert.equal(byName.get('obsidian_list').parameters.properties.depth.default, 2)
    assert.equal(byName.get('obsidian_list').parameters.properties.depth.maximum, 5)
    assert.equal(byName.get('obsidian_list').parameters.properties.limit.default, 200)
    assert.equal(byName.get('obsidian_search').parameters.properties.limit.default, 50)
    assert.equal(byName.get('obsidian_list').parameters.properties.limit.maximum, 500)
    assert.equal(byName.get('obsidian_write').parameters.properties.backup.default, true)
    assert.deepEqual(byName.get('obsidian_tags').parameters.properties.action.enum, ['list'])
  })

  // ── render 契约（DSH 调用 render(args, value)） ─────────────────────────
  await test('render(args, value) uses the SECOND argument (regression for arity bug)', () => {
    for (const definition of tools) {
      const blocks = definition.output.render({ argsMarker: 'ARGS_SHOULD_NOT_APPEAR' }, { valueMarker: 'VALUE_SHOULD_APPEAR' })
      assert.ok(Array.isArray(blocks) && blocks.length === 1, `${definition.name}: render 返回 1 个 block`)
      assert.equal(blocks[0].type, 'text', `${definition.name}: block type text`)
      assert.equal(typeof blocks[0].text, 'string')
      assert.ok(blocks[0].text.includes('VALUE_SHOULD_APPEAR'), `${definition.name}: render 必须序列化第二个参数`)
      assert.ok(!blocks[0].text.includes('ARGS_SHOULD_NOT_APPEAR'), `${definition.name}: render 不能序列化第一个参数`)
    }
    // 真实工具返回值也能被 render
    return (async () => {
      const value = await exec('obsidian_status', {})
      const blocks = byName.get('obsidian_status').output.render({}, value)
      assert.ok(blocks[0].text.includes('vaultPath'), blocks[0].text.slice(0, 120))
    })()
  })

  await test('render: caps oversized text and flags truncation', () => {
    const blocks = byName.get('obsidian_status').output.render({}, { blob: 'x'.repeat(50000) })
    assert.ok(blocks[0].text.length <= 8100, `render text too long: ${blocks[0].text.length}`)
    assert.ok(blocks[0].text.includes('截断'), 'render should flag truncation')
  })

  // ── execute: 正常路径 ──────────────────────────────────────────────────
  await test('obsidian_status: returns vault status', async () => {
    const result = await exec('obsidian_status', {})
    assert.equal(result.ok, true)
    assert.equal(result.available, true)
    assert.equal(result.vaultPath, path.resolve(vaultPath))
    assert.equal(typeof result.noteCount, 'number')
  })

  await test('obsidian_list: entries with defaults and explicit dir/depth', async () => {
    vault.write({ path: 'list-fx/hello', content: '# Hello\n\nworld\n', mode: 'create' })
    const result = await exec('obsidian_list', { dir: 'list-fx' })
    assert.equal(result.dir, 'list-fx')
    assert.ok(result.entries.some((entry) => entry.path === 'list-fx/hello.md' && entry.type === 'note'))
    assert.equal(result.truncated, false)
    const root = await exec('obsidian_list', {})
    assert.equal(root.dir, '')
    assert.ok(root.entries.length >= 1)
  })

  await test('obsidian_read: structured note with Chinese title/content/frontmatter/tags', async () => {
    vault.write({
      path: 'read-fx/中文笔记',
      content: '# 中文标题\n\n正文内容在这里。\n',
      mode: 'create',
      frontmatter: { status: 'draft' },
      tags: ['标签甲'],
    })
    const result = await exec('obsidian_read', { path: 'read-fx/中文笔记' })
    assert.equal(result.path, 'read-fx/中文笔记.md')
    assert.equal(result.title, '中文标题')
    assert.ok(result.content.includes('正文内容在这里。'))
    assert.equal(result.frontmatter.status, 'draft')
    assert.ok(result.tags.includes('标签甲'))
  })

  await test('obsidian_search: results with score/matched/snippet/line', async () => {
    vault.write({ path: 'search-fx/hit', content: '# 搜索命中\n\n关键词 needle 在这里。\n', mode: 'create' })
    const result = await exec('obsidian_search', { query: 'needle' })
    assert.ok(result.total >= 1)
    assert.ok(result.results.some((item) => item.path === 'search-fx/hit.md' && item.matched === 'content'))
    assert.equal(typeof result.results[0].snippet, 'string')
    assert.equal(typeof result.results[0].line, 'number')
  })

  await test('obsidian_write: default create, append, overwrite, tags, frontmatter', async () => {
    const created = await exec('obsidian_write', {
      path: 'write-fx/note',
      content: '# 写\n\n正文\n',
      tags: ['甲', '乙'],
      frontmatter: { status: 'new' },
    })
    assert.equal(created.created, true)
    assert.equal(created.path, 'write-fx/note.md')
    const read = await exec('obsidian_read', { path: 'write-fx/note' })
    assert.ok(read.tags.includes('甲'))
    assert.equal(read.frontmatter.status, 'new')

    // 默认 mode=create：已存在必须报错（防误覆盖）
    await expectToolError(exec('obsidian_write', { path: 'write-fx/note', content: 'x' }), 'exists', 'write default create')

    const appended = await exec('obsidian_write', { path: 'write-fx/note', content: '追加行', mode: 'append' })
    assert.equal(appended.mode, 'append')
    const afterAppend = await exec('obsidian_read', { path: 'write-fx/note' })
    assert.ok(afterAppend.content.includes('追加行'))

    const overwritten = await exec('obsidian_write', { path: 'write-fx/note', content: '整篇替换', mode: 'overwrite' })
    assert.equal(overwritten.mode, 'overwrite')
    const afterOverwrite = await exec('obsidian_read', { path: 'write-fx/note' })
    assert.equal(afterOverwrite.content, '整篇替换\n')
    assert.equal(afterOverwrite.frontmatter.status, 'new', 'overwrite preserves frontmatter unless told otherwise')

    const prepended = await exec('obsidian_write', { path: 'write-fx/note', content: '开头', mode: 'prepend' })
    assert.equal(prepended.mode, 'prepend')
    const afterPrepend = await exec('obsidian_read', { path: 'write-fx/note' })
    assert.ok(afterPrepend.content.startsWith('开头'))
  })

  await test('obsidian_manage: move + trash', async () => {
    await exec('obsidian_write', { path: 'manage-fx/from', content: '移动我' })
    const moved = await exec('obsidian_manage', { action: 'move', from: 'manage-fx/from', to: 'manage-fx/to' })
    assert.equal(moved.action, 'move')
    assert.equal(moved.to, 'manage-fx/to.md')
    assert.ok(fs.existsSync(path.join(vaultPath, 'manage-fx', 'to.md')))
    const trashed = await exec('obsidian_manage', { action: 'trash', path: 'manage-fx/to' })
    assert.equal(trashed.action, 'trash')
    assert.equal(trashed.trashed, true)
    assert.ok(String(trashed.trashPath).startsWith('.trash/'))
    assert.equal(fs.existsSync(path.join(vaultPath, 'manage-fx', 'to.md')), false)
  })

  await test('obsidian_daily: read/append/create, date arg, template substitution', async () => {
    fs.mkdirSync(path.join(vaultPath, '.obsidian'), { recursive: true })
    fs.writeFileSync(
      path.join(vaultPath, '.obsidian', 'daily-notes.json'),
      JSON.stringify({ folder: '日记', format: 'YYYY-MM-DD', template: '模板/日记模板.md' }),
      'utf8',
    )
    fs.mkdirSync(path.join(vaultPath, '模板'), { recursive: true })
    fs.writeFileSync(path.join(vaultPath, '模板', '日记模板.md'), '# {{date}}\n\n', 'utf8')

    const missing = await exec('obsidian_daily', { date: '2024-05-06' })
    assert.equal(missing.created, false)
    assert.equal(missing.path, '日记/2024-05-06.md')
    assert.equal(missing.appended, false)

    const appended = await exec('obsidian_daily', { date: '2024-05-06', mode: 'append', content: '工具写入的日记。' })
    assert.equal(appended.created, true)
    assert.equal(appended.appended, true)
    assert.ok(appended.content.includes('工具写入的日记。'))
    assert.ok(appended.content.includes('# 2024-05-06'), 'template {{date}} should be substituted')

    const created = await exec('obsidian_daily', { date: '2024-05-07', mode: 'create' })
    assert.equal(created.created, true)
    assert.equal(created.path, '日记/2024-05-07.md')
  })

  await test('obsidian_tags: aggregates tags', async () => {
    const result = await exec('obsidian_tags', {})
    assert.ok(Array.isArray(result.tags))
    assert.ok(result.tags.some((entry) => entry.tag === '甲'))
    assert.equal(typeof result.total, 'number')
  })

  await test('obsidian_links: outgoing/backlinks/unresolved', async () => {
    await exec('obsidian_write', { path: 'links-fx/a', content: '# A\n\n[[b]] 与 [[ghost]]\n' })
    await exec('obsidian_write', { path: 'links-fx/b', content: '# B\n\n回到 [[a]]。\n' })
    const result = await exec('obsidian_links', { path: 'links-fx/a' })
    assert.deepEqual(result.outgoing, ['b', 'ghost'])
    assert.deepEqual(result.backlinks, ['links-fx/b.md'])
    assert.deepEqual(result.unresolved, ['ghost'])
  })

  await test('obsidian_open: disabled by config, launcher hook, URI shape/encoding', async () => {
    await exec('obsidian_write', { path: 'open-fx/中文 笔记', content: '# 打开\n\n' })

    const disabled = await exec('obsidian_open', { path: 'open-fx/中文 笔记' })
    assert.equal(disabled.opened, false)
    assert.equal(disabled.path, 'open-fx/中文 笔记.md')
    assert.ok(disabled.uri.startsWith('obsidian://open?vault='))
    assert.ok(disabled.uri.includes('&file=open-fx%2F%E4%B8%AD%E6%96%87%20%E7%AC%94%E8%AE%B0'), disabled.uri)
    assert.equal(disabled.uri.includes('.md'), false, 'URI file must be without extension')
    assert.ok(disabled.uri.includes(`vault=${encodeURIComponent(path.basename(vaultPath))}`))
    assert.equal(typeof disabled.hint, 'string')

    config.allowOpenInObsidian = true
    config.launcher = (uri) => launcherCalls.push(uri)
    const opened = await exec('obsidian_open', { path: 'open-fx/中文 笔记' })
    assert.equal(opened.opened, true)
    assert.equal(launcherCalls.length, 1)
    assert.equal(launcherCalls[0], opened.uri)

    config.launcher = () => {
      throw new Error('launcher exploded')
    }
    const failed = await exec('obsidian_open', { path: 'open-fx/中文 笔记' })
    assert.equal(failed.opened, false)
    assert.ok(failed.hint.includes('launcher exploded'))
    delete config.launcher
    config.allowOpenInObsidian = false
  })

  // ── execute: 取消 / 错误 ────────────────────────────────────────────────
  await test('all 10 tools honor exec.signal.aborted with 调用已取消。', async () => {
    for (const definition of tools) {
      const error = await expectToolError(
        definition.execute({ path: 'x', query: 'x', action: 'move' }, { signal: { aborted: true } }),
        null,
        `${definition.name} aborted`,
      )
      assert.equal(error.message, '调用已取消。')
    }
    // 没有 signal 时正常执行不报错
    const result = await exec('obsidian_status', {}, {})
    assert.equal(result.ok, true)
  })

  await test('errors preserve VaultError.code in message and .code', async () => {
    const notFound = await expectToolError(exec('obsidian_read', { path: 'no-such-note' }), 'not-found', 'read missing')
    assert.equal(notFound.code, 'not-found')
    const traversal = await expectToolError(exec('obsidian_read', { path: '../etc/passwd' }), 'invalid-path', 'traversal')
    assert.equal(traversal.code, 'invalid-path')
    const invalidMode = await expectToolError(
      exec('obsidian_write', { path: 'e', content: 'x', mode: 'bogus' }),
      'invalid-path',
      'bad mode',
    )
    assert.equal(invalidMode.code, 'invalid-path')
    const badTagsAction = await expectToolError(exec('obsidian_tags', { action: 'bogus' }), 'invalid-path', 'bad tags action')
    assert.equal(badTagsAction.code, 'invalid-path')
  })

  await test('vault unavailable / missing getVault: status reports, others throw vault-unavailable', async () => {
    const unavailable = createTools({ getVault: () => createVault({}), getConfig: () => ({}) })
    const statusTool = unavailable.find((definition) => definition.name === 'obsidian_status')
    const readTool = unavailable.find((definition) => definition.name === 'obsidian_read')
    const status = await statusTool.execute({}, { signal: { aborted: false } })
    assert.equal(status.available, false)
    assert.equal(status.error.code, 'vault-unavailable')
    await expectToolError(readTool.execute({ path: 'a' }, { signal: { aborted: false } }), 'vault-unavailable', 'unavailable read')

    const missing = createTools({ getVault: () => null, getConfig: () => ({}) })
    const missingStatus = await missing.find((definition) => definition.name === 'obsidian_status').execute({}, {})
    assert.equal(missingStatus.available, false)
    assert.equal(missingStatus.vaultPath, null)
    await expectToolError(
      missing.find((definition) => definition.name === 'obsidian_read').execute({ path: 'a' }, {}),
      'vault-unavailable',
      'missing vault read',
    )
  })

  await test('tools re-read getVault/getConfig on every call (hot config switch)', async () => {
    const secondBase = path.join(ROOT, 'second-fx')
    const secondVaultPath = path.join(secondBase, 'vault')
    fs.mkdirSync(secondVaultPath, { recursive: true })
    const secondVault = createVault({ vaultPath: secondVaultPath, backupDir: path.join(secondBase, 'backups') })
    secondVault.write({ path: 'switch-note', content: '# 第二仓库\n\nB 仓库内容\n', mode: 'create' })

    vault.write({ path: 'switch-note', content: '# 第一仓库\n\nA 仓库内容\n', mode: 'create' })
    const before = await exec('obsidian_read', { path: 'switch-note' })
    assert.equal(before.title, '第一仓库')

    currentVault = secondVault
    const after = await exec('obsidian_read', { path: 'switch-note' })
    assert.equal(after.title, '第二仓库', 'tool must read getVault() again for each call')

    currentVault = vault
  })

  await test('getVault throwing is normalized into a tool error, never crashes the definition', async () => {
    const throwing = createTools({
      getVault: () => {
        throw new Error('vault factory exploded')
      },
      getConfig: () => ({}),
    })
    const readTool = throwing.find((definition) => definition.name === 'obsidian_read')
    const error = await expectToolError(readTool.execute({ path: 'a' }, { signal: { aborted: false } }), null, 'throwing getVault')
    assert.equal(error.message, 'vault factory exploded')
    // status 不抛错（它用 getVaultOrNull 兜底）
    const statusTool = throwing.find((definition) => definition.name === 'obsidian_status')
    const status = await statusTool.execute({}, { signal: { aborted: false } })
    assert.equal(status.available, false)
  })

  // ── 汇总 ────────────────────────────────────────────────────────────────
  console.log('')
  console.log(`test-tools: ${passed} passed, ${failed} failed（fixtures: ${ROOT}）`)
  if (failed > 0) {
    console.log(`failed checks:\n - ${failures.join('\n - ')}`)
    process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error('test-tools crashed:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  })
  .finally(() => {
    if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = ORIGINAL_DSH_HOME
    try {
      fs.rmSync(ROOT, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
