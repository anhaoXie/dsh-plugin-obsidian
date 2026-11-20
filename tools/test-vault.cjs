#!/usr/bin/env node
/**
 * test-vault.cjs — 离线测试 lib/vault.js（SPEC §3）。
 *
 * 全部 fixture 位于 os.tmpdir() 下；进程内把 DSH_HOME 指向临时目录，
 * 保证默认备份目录绝不会落到真实 ~/.dsh。绝不接触真实 Obsidian vault。
 *
 * 运行：node tools/test-vault.cjs
 */
'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO = path.resolve(__dirname, '..')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-obsidian-test-vault-'))
const ORIGINAL_DSH_HOME = process.env.DSH_HOME
process.env.DSH_HOME = path.join(ROOT, 'dsh-home')

let passed = 0
let failed = 0
let skipped = 0
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

function skip(name, reason) {
  skipped += 1
  console.log(`SKIP ${name} :: ${reason}`)
}

let lib = null
function requireLib() {
  if (!lib) throw new Error('lib not loaded yet')
  return lib
}

let fxSeq = 0
/** 每个测试独立的 vault + backupDir。 */
function freshVault(options = {}) {
  const { createVault } = requireLib()
  fxSeq += 1
  const base = path.join(ROOT, `fx-${fxSeq}`)
  const vaultPath = path.join(base, 'vault')
  const backupDir = path.join(base, 'backups')
  fs.mkdirSync(vaultPath, { recursive: true })
  const vault = createVault({
    vaultPath,
    backupDir,
    now: () => new Date(2024, 0, 2, 3, 4, 5),
    ...options,
  })
  return { base, vaultPath, backupDir, vault }
}

/** 断言抛出 VaultError 且 code 属于 codes。 */
function expectVaultError(fn, codes, label) {
  const { VaultError } = requireLib()
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== null, `${label || 'expected VaultError'}：没有抛错`)
  assert.ok(thrown instanceof VaultError, `${label || 'expected VaultError'}：抛出了 ${thrown && thrown.name}: ${thrown && thrown.message}`)
  const wanted = Array.isArray(codes) ? codes : [codes]
  assert.ok(wanted.includes(thrown.code), `${label || 'code'}：期望 ${wanted.join('|')}，实际 ${thrown.code}（${thrown.message}）`)
  return thrown
}

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8')
}

function walkFiles(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      out.push(full)
      continue
    }
    if (entry.isDirectory()) walkFiles(full, out)
    else out.push(full)
  }
  return out
}

function runNodeChild(script, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['-e', script, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('exit', (code) => resolvePromise({ code, stderr }))
    child.on('error', (error) => resolvePromise({ code: -1, stderr: String(error) }))
  })
}

async function main() {
  const mod = await import(pathToFileURL(path.join(REPO, 'lib', 'vault.js')).href)
  lib = mod
  const { createVault, discoverVault, VaultError, parseFrontmatter, serializeFrontmatter, formatDate } = mod

  console.log(`fixtures: ${ROOT}`)
  console.log(`node ${process.version}`)
  console.log('')

  // ── discoverVault ───────────────────────────────────────────────────────
  await test('discoverVault: reads registry, prefers open:true vault, ignores missing/broken', () => {
    const { vaultPath } = freshVault()
    const registry = path.join(ROOT, 'obsidian.json')
    fs.writeFileSync(
      registry,
      JSON.stringify({
        vaults: {
          closed: { path: path.join(ROOT, 'does-not-exist'), open: false },
          open: { path: vaultPath, open: true },
        },
      }),
      'utf8',
    )
    assert.equal(discoverVault(registry), path.resolve(vaultPath))
    assert.equal(discoverVault(path.join(ROOT, 'missing-registry.json')), null)
    const broken = path.join(ROOT, 'broken-registry.json')
    fs.writeFileSync(broken, '{ this is not json', 'utf8')
    assert.equal(discoverVault(broken), null)
  })

  // ── vault 不可用 ────────────────────────────────────────────────────────
  await test('unavailable vault: createVault never throws, status reports, methods throw vault-unavailable', () => {
    const empty = createVault({})
    assert.equal(empty.available, false)
    assert.equal(empty.root, null)
    const status = empty.status()
    assert.equal(status.ok, true)
    assert.equal(status.available, false)
    assert.equal(status.vaultPath, null)
    assert.equal(status.error.code, 'vault-unavailable')
    expectVaultError(() => empty.list(), 'vault-unavailable', 'list')
    expectVaultError(() => empty.read({ path: 'a.md' }), 'vault-unavailable', 'read')
    expectVaultError(() => empty.write({ path: 'a.md', content: 'x' }), 'vault-unavailable', 'write')
    expectVaultError(() => empty.search({ query: 'x' }), 'vault-unavailable', 'search')
    expectVaultError(() => empty.tags(), 'vault-unavailable', 'tags')
    expectVaultError(() => empty.daily(), 'vault-unavailable', 'daily')

    const missing = createVault({ vaultPath: path.join(ROOT, 'no-such-vault-dir') })
    assert.equal(missing.available, false)
    assert.equal(missing.status().error.code, 'vault-unavailable')
    expectVaultError(() => missing.list(), 'vault-unavailable', 'missing-dir list')
  })

  // ── 路径安全 ────────────────────────────────────────────────────────────
  await test('path safety: absolute / drive / UNC / traversal / hidden / illegal chars are rejected', () => {
    const { vault, vaultPath } = freshVault()
    const badPaths = [
      'C:\\Windows\\win.ini',
      'C:/Windows/win.ini',
      '/etc/passwd',
      '\\\\server\\share\\note',
      '../escape',
      '..\\escape',
      'a/../../b',
      'a/../b',
      '.obsidian/app.json',
      '.git/config',
      '.trash/x',
      '.hidden-note',
      'a<b',
      'a|b',
      'a?b',
      'a*b',
      'a"b',
      'a:b',
      'a\u0001b',
      '   ',
      '',
      'con',
      'con.md',
      'aux.md',
      'a/b.',
      'a/b /c',
      '.',
    ]
    for (const badPath of badPaths) {
      expectVaultError(() => vault.read({ path: badPath }), 'invalid-path', `read ${JSON.stringify(badPath)}`)
      expectVaultError(() => vault.write({ path: badPath, content: 'x' }), 'invalid-path', `write ${JSON.stringify(badPath)}`)
    }
    expectVaultError(() => vault.list({ dir: '../' }), 'invalid-path', 'list traversal dir')

    // 逃逸目标绝不能出现在 vault 外
    const outsideCandidate = path.join(path.dirname(vaultPath), 'escape.md')
    assert.equal(fs.existsSync(outsideCandidate), false)
    assert.equal(fs.existsSync(path.join(ROOT, 'escape.md')), false)
  })

  await test('path safety: .md suffix auto-add, backslashes normalized, case-insensitive .MD kept', () => {
    const { vault } = freshVault()
    assert.equal(vault.normalizePath('note'), 'note.md')
    assert.equal(vault.normalizePath('dir\\note'), 'dir/note.md')
    assert.equal(vault.normalizePath('dir//note.md'), 'dir/note.md')
    assert.equal(vault.normalizePath('dir/note.MD'), 'dir/note.MD')
    const written = vault.write({ path: 'a\\b\\c', content: '# C\n\n内容\n', mode: 'create' })
    assert.equal(written.path, 'a/b/c.md')
    assert.ok(fs.existsSync(path.join(vault.root, 'a', 'b', 'c.md')))
    assert.equal(vault.read({ path: 'a/b/c' }).path, 'a/b/c.md')
  })

  // ── write / read ────────────────────────────────────────────────────────
  await test('write+read: Chinese content, no BOM, LF only, title from heading, metadata', () => {
    const { vault, vaultPath } = freshVault()
    const result = vault.write({
      path: '01-笔记/我的笔记',
      content: '# 我的标题\r\n\r\n这是中文正文。\r\n',
      mode: 'create',
    })
    assert.equal(result.path, '01-笔记/我的笔记.md')
    assert.equal(result.mode, 'create')
    assert.equal(result.created, true)
    assert.ok(result.bytes > 0)
    const file = path.join(vaultPath, '01-笔记', '我的笔记.md')
    const raw = readUtf8(file)
    assert.equal(raw.charCodeAt(0), '#'.charCodeAt(0), 'file must not start with BOM')
    assert.equal(raw.includes('\r'), false, 'file must use LF only')
    assert.ok(raw.endsWith('\n'))
    const note = vault.read({ path: '01-笔记/我的笔记' })
    assert.equal(note.path, '01-笔记/我的笔记.md')
    assert.equal(note.title, '我的标题')
    assert.ok(note.content.startsWith('# 我的标题'))
    assert.ok(note.content.includes('这是中文正文。'))
    assert.equal(note.truncated, false)
    assert.equal(note.size, Buffer.byteLength(raw, 'utf8'))
    assert.equal(Buffer.byteLength(note.content, 'utf8') > 0, true)
    assert.equal(Number.isNaN(Date.parse(note.mtime)), false)
    assert.ok(fs.statSync(file).isFile())
  })

  await test('read: title precedence frontmatter.title > first # heading > filename', () => {
    const { vault } = freshVault()
    // 1) frontmatter.title 胜出（Lead 决策：作者意图优先于正文标题）
    vault.write({
      path: 'fm-title',
      content: '# 正文标题\n\n正文\n',
      mode: 'create',
      frontmatter: { title: '作者意图标题' },
    })
    assert.equal(vault.read({ path: 'fm-title' }).title, '作者意图标题')
    // list 的 title 也走同一优先级
    const listed = vault.list().entries.find((entry) => entry.path === 'fm-title.md')
    assert.equal(listed.title, '作者意图标题')

    // 2) 空字符串 / 非字符串 frontmatter.title 视为未提供 → 回退到 # 标题
    vault.write({ path: 'blank-fm-title', content: '# 标题优先\n\n正文\n', mode: 'create', frontmatter: { title: '   ' } })
    assert.equal(vault.read({ path: 'blank-fm-title' }).title, '标题优先')
    vault.write({ path: 'numeric-fm-title', content: '# 数字标题\n\n正文\n', mode: 'create', frontmatter: { title: 123 } })
    assert.equal(vault.read({ path: 'numeric-fm-title' }).title, '数字标题')

    // 3) 没有 frontmatter.title 也没有 # 标题 → 文件名（去 .md）
    vault.write({ path: 'plain-name', content: '没有标题的内容。\n', mode: 'create' })
    assert.equal(vault.read({ path: 'plain-name.md' }).title, 'plain-name')
  })

  await test('read: missing note -> not-found, directory -> not-a-file', () => {
    const { vault, vaultPath } = freshVault()
    expectVaultError(() => vault.read({ path: 'nope.md' }), 'not-found', 'missing note')
    fs.mkdirSync(path.join(vaultPath, 'dir.md'))
    expectVaultError(() => vault.read({ path: 'dir.md' }), 'not-a-file', 'dir as note')
    vault.write({ path: 'file-as-dir', content: '# F\n\n', mode: 'create' })
    expectVaultError(() => vault.list({ dir: 'file-as-dir' }), 'not-found', 'note as dir')
  })

  // ── frontmatter 解析 / 序列化 ───────────────────────────────────────────
  await test('frontmatter parse: scalars, quoted, inline array, block array, block scalar, nested raw', () => {
    const sample = [
      '---',
      'title: "Hello: World"',
      'count: 3',
      'draft: false',
      'tags: [alpha, "beta, gamma"]',
      'aliases:',
      '  - one',
      '  - two',
      'meta:',
      '  created: 2024-01-01',
      '  deep:',
      '    x: 1',
      'desc: |',
      '  line one',
      '  line two',
      'folded: >',
      '  fold',
      '  me',
      '---',
      'body text',
    ].join('\n')
    const parsed = parseFrontmatter(sample)
    assert.equal(parsed.body, 'body text')
    assert.ok(parsed.raw.includes('created: 2024-01-01'))
    assert.equal(parsed.data.title, 'Hello: World')
    assert.equal(parsed.data.count, 3)
    assert.equal(parsed.data.draft, false)
    assert.deepEqual(parsed.data.tags, ['alpha', 'beta, gamma'])
    assert.deepEqual(parsed.data.aliases, ['one', 'two'])
    assert.equal(parsed.data.desc, 'line one\nline two\n')
    assert.equal(parsed.data.folded, 'fold me\n')
    assert.equal(typeof parsed.data.meta, 'string')
    assert.ok(parsed.data.meta.includes('created: 2024-01-01'))
    // JSON 输出不应包含嵌套标记
    assert.ok(!Object.keys(parsed.data).includes('__nested'))

    // 未修改的嵌套映射原样写回
    const roundTrip = serializeFrontmatter(parsed.data)
    assert.ok(roundTrip.includes('meta:\n  created: 2024-01-01'), roundTrip)
    assert.ok(roundTrip.includes('title: "Hello: World"'), roundTrip)
    assert.ok(roundTrip.includes('tags: [alpha, "beta, gamma"]'), roundTrip)

    // 被修改的嵌套键按标量覆盖
    parsed.data.meta = 'plain'
    const modified = serializeFrontmatter(parsed.data)
    assert.ok(modified.includes('meta: plain'), modified)
    assert.ok(!modified.includes('created: 2024-01-01'))
  })

  await test('write/frontmatter: merge preserves unknown keys, tags set, null deletes, null frontmatter removes block', () => {
    const { vault, vaultPath } = freshVault()
    const file = path.join(vaultPath, 'fm', 'note.md')
    vault.write({
      path: 'fm/note',
      content: '# FM\n\n正文\n',
      mode: 'create',
      frontmatter: { status: 'draft', priority: 2, drafted: true, nested: { a: 1 } },
      tags: ['笔记', '测试'],
    })
    let note = vault.read({ path: 'fm/note' })
    assert.equal(note.frontmatter.status, 'draft')
    assert.equal(note.frontmatter.priority, 2)
    assert.equal(note.frontmatter.drafted, true)
    // SPEC：嵌套映射不解析，读取时保留原始文本
    assert.equal(typeof note.frontmatter.nested, 'string')
    assert.equal(note.frontmatter.nested, '  a: 1')
    assert.ok(note.frontmatterRaw.includes('status: draft'))
    assert.ok(note.tags.includes('笔记'))
    assert.ok(note.tags.includes('测试'))
    assert.ok(readUtf8(file).startsWith('---\n'))

    // overwrite：未出现的 frontmatter 键保留
    vault.write({ path: 'fm/note', content: '# FM 更新\n\n新正文\n', mode: 'overwrite', frontmatter: { status: 'done' } })
    note = vault.read({ path: 'fm/note' })
    assert.equal(note.frontmatter.status, 'done')
    assert.equal(note.frontmatter.priority, 2, 'unknown keys must be preserved')
    assert.ok(note.tags.includes('笔记'), 'existing tags preserved on overwrite')
    assert.ok(note.content.includes('新正文'))

    // append：合并新 frontmatter 键且保留正文
    vault.write({ path: 'fm/note', content: '追加段\n', mode: 'append', frontmatter: { reviewed: true } })
    note = vault.read({ path: 'fm/note' })
    assert.equal(note.frontmatter.reviewed, true)
    assert.equal(note.frontmatter.status, 'done')
    assert.ok(note.content.includes('新正文'))
    assert.ok(note.content.includes('追加段'))

    // tags 替换
    vault.write({ path: 'fm/note', content: note.content, mode: 'overwrite', tags: ['x'] })
    note = vault.read({ path: 'fm/note' })
    assert.deepEqual(note.frontmatter.tags, ['x'])

    // 单键 null 删除
    vault.write({ path: 'fm/note', content: note.content, mode: 'overwrite', frontmatter: { reviewed: null } })
    note = vault.read({ path: 'fm/note' })
    assert.equal(note.frontmatter.reviewed, undefined)
    assert.equal(note.frontmatter.status, 'done')

    // frontmatter: null 删除整个块
    vault.write({ path: 'fm/note', content: '只剩正文\n', mode: 'overwrite', frontmatter: null })
    note = vault.read({ path: 'fm/note' })
    assert.deepEqual(note.frontmatter, {})
    assert.equal(note.frontmatterRaw, '')
    assert.equal(readUtf8(file).startsWith('---'), false)
    assert.ok(note.content.includes('只剩正文'))
  })

  await test('write: content with a leading frontmatter block is recognized as frontmatter', () => {
    const { vault } = freshVault()
    vault.write({ path: 'fm-in-content', content: '---\ntags: [内嵌]\nstatus: 记录\n---\n# 标题\n\n正文\n', mode: 'create' })
    const note = vault.read({ path: 'fm-in-content' })
    assert.deepEqual(note.frontmatter.tags, ['内嵌'])
    assert.equal(note.frontmatter.status, '记录')
    assert.equal(note.title, '标题')
    assert.ok(note.content.includes('正文'))
    assert.equal(note.content.includes('tags: [内嵌]'), false)
  })

  await test('write: append/prepend ordering and missing-file creation', () => {
    const { vault } = freshVault()
    vault.write({ path: 'order', content: 'BODY', mode: 'create' })
    vault.write({ path: 'order', content: 'TAIL', mode: 'append' })
    vault.write({ path: 'order', content: 'HEAD', mode: 'prepend' })
    const note = vault.read({ path: 'order' })
    assert.equal(note.content, 'HEAD\nBODY\nTAIL\n')
    const createdByAppend = vault.write({ path: 'append-new', content: 'fresh', mode: 'append' })
    assert.equal(createdByAppend.created, true)
    assert.equal(vault.read({ path: 'append-new' }).content, 'fresh\n')
  })

  await test('write: mode create on existing -> exists; invalid arguments rejected', () => {
    const { vault } = freshVault()
    vault.write({ path: 'dup', content: 'a', mode: 'create' })
    expectVaultError(() => vault.write({ path: 'dup', content: 'b', mode: 'create' }), 'exists', 'create existing')
    expectVaultError(() => vault.write({ path: 'z', content: 'x', mode: 'bogus' }), 'invalid-path', 'bad mode')
    expectVaultError(() => vault.write({ path: 'z', content: 123 }), 'invalid-path', 'bad content')
    expectVaultError(() => vault.write({ path: 'z', content: 'x', frontmatter: [] }), 'invalid-path', 'bad frontmatter')
    expectVaultError(() => vault.write({ path: 'z', content: 'x', tags: 'nope' }), 'invalid-path', 'bad tags')
    expectVaultError(
      () => vault.write({ path: 'missing-parent/note', content: 'x', createDirs: false }),
      'not-found',
      'missing parent without createDirs',
    )
  })

  // ── 备份 + 原子写 ───────────────────────────────────────────────────────
  await test('atomic overwrite + backup path; no temp files left behind', () => {
    const { vault, vaultPath, backupDir } = freshVault()
    const first = vault.write({ path: 'backed/note', content: 'old content', mode: 'create' })
    assert.equal(first.backupPath, null, 'create has no old file to back up')
    const originalRaw = readUtf8(path.join(vaultPath, 'backed', 'note.md'))
    const second = vault.write({ path: 'backed/note', content: 'new content', mode: 'overwrite' })
    assert.equal(second.created, false)
    assert.equal(typeof second.backupPath, 'string')
    assert.ok(fs.existsSync(second.backupPath), 'backup file must exist')
    assert.ok(second.backupPath.startsWith(backupDir), second.backupPath)
    assert.ok(second.backupPath.includes('20240102-030405-000'), second.backupPath)
    assert.ok(second.backupPath.endsWith('note.md'), second.backupPath)
    assert.equal(readUtf8(second.backupPath), originalRaw, 'backup must be the pre-write bytes')
    assert.equal(readUtf8(path.join(vaultPath, 'backed', 'note.md')), 'new content\n')

    const noBackup = vault.write({ path: 'backed/note', content: 'third', mode: 'overwrite', backup: false })
    assert.equal(noBackup.backupPath, null)

    const leftovers = walkFiles(vaultPath).filter((file) => file.includes('.dsh-obsidian-tmp') || file.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], 'no temp files may remain after atomic renames')
  })

  await test('backup default root honors DSH_HOME (never writes real ~/.dsh)', () => {
    const base = path.join(ROOT, 'default-backup-fx')
    const vaultPath = path.join(base, 'vault')
    fs.mkdirSync(vaultPath, { recursive: true })
    const vault = createVault({ vaultPath })
    vault.write({ path: 'note', content: 'one', mode: 'create' })
    const result = vault.write({ path: 'note', content: 'two', mode: 'overwrite' })
    assert.ok(result.backupPath, 'backupPath expected')
    assert.ok(result.backupPath.startsWith(path.join(ROOT, 'dsh-home', 'obsidian-backups')), result.backupPath)
  })

  // ── 并发写 ──────────────────────────────────────────────────────────────
  await test('concurrent writes from 4 processes are atomic (single complete content, no temp files)', async () => {
    const { vaultPath, backupDir } = freshVault()
    const moduleUrl = pathToFileURL(path.join(REPO, 'lib', 'vault.js')).href
    const childScript = [
      "const moduleUrl = process.argv[1]",
      "const vaultPath = process.argv[2]",
      "const index = process.argv[3]",
      "const backupDir = process.argv[4]",
      'import(moduleUrl).then(({ createVault }) => {',
      '  const vault = createVault({ vaultPath, backupDir, now: () => new Date() })',
      '  for (let i = 0; i < 40; i += 1) {',
      "    vault.write({ path: 'race/race.md', content: 'child' + index + '-' + i, mode: 'overwrite', backup: false, createDirs: true })",
      '  }',
      "}).catch((error) => { console.error('child failed', error && error.stack ? error.stack : error); process.exit(1) })",
    ].join('\n')
    const runs = await Promise.all(
      [0, 1, 2, 3].map((index) => runNodeChild(childScript, [moduleUrl, vaultPath, String(index), backupDir])),
    )
    for (const run of runs) assert.equal(run.code, 0, `child exit ${run.code}: ${run.stderr}`)
    const raceFile = path.join(vaultPath, 'race', 'race.md')
    assert.ok(fs.existsSync(raceFile), 'race file should exist')
    const raw = readUtf8(raceFile)
    assert.match(raw, /^child[0-3]-\d+\n$/, `atomic write must leave exactly one complete child content, got ${JSON.stringify(raw)}`)
    assert.equal(raw.includes('\r'), false)
    const leftovers = fs.readdirSync(path.join(vaultPath, 'race')).filter((name) => name.includes('.tmp') || name.includes('dsh-obsidian-tmp'))
    assert.deepEqual(leftovers, [])
  })

  // ── list ────────────────────────────────────────────────────────────────
  await test('list: depth, folders-first, limit truncation, hidden/ignored dirs excluded', () => {
    const { vault, vaultPath } = freshVault()
    vault.write({ path: 'a/one', content: '# One\n\n', mode: 'create' })
    vault.write({ path: 'a/two', content: '# Two\n\n', mode: 'create' })
    vault.write({ path: 'a/sub/three', content: '# Three\n\n', mode: 'create' })
    vault.write({ path: 'b/four', content: '# Four\n\n', mode: 'create' })
    vault.write({ path: 'root', content: '# Root\n\n', mode: 'create' })
    fs.mkdirSync(path.join(vaultPath, '.hidden'), { recursive: true })
    fs.writeFileSync(path.join(vaultPath, '.hidden', 'secret.md'), '# secret\n', 'utf8')

    const rootList = vault.list()
    assert.equal(rootList.dir, '')
    assert.equal(rootList.truncated, false)
    const paths = rootList.entries.map((entry) => entry.path)
    for (const expected of ['a', 'b', 'root.md']) assert.ok(paths.includes(expected), `missing ${expected} in ${paths}`)
    assert.ok(!paths.some((entryPath) => entryPath.startsWith('.hidden')), 'hidden dir must not be listed')
    assert.ok(!paths.some((entryPath) => entryPath.includes('.obsidian')))
    assert.equal(rootList.entries.find((entry) => entry.path === 'a').type, 'folder')
    const rootNote = rootList.entries.find((entry) => entry.path === 'root.md')
    assert.equal(rootNote.type, 'note')
    assert.equal(rootNote.title, 'Root')
    assert.equal(typeof rootNote.size, 'number')
    assert.equal(typeof rootNote.mtime, 'string')

    const depthOne = vault.list({ dir: 'a', depth: 1 })
    const depthOnePaths = depthOne.entries.map((entry) => entry.path)
    assert.ok(depthOnePaths.includes('a/one.md'))
    assert.ok(depthOnePaths.includes('a/two.md'))
    assert.ok(depthOnePaths.includes('a/sub'))
    assert.ok(!depthOnePaths.includes('a/sub/three.md'), 'depth 1 must not descend')

    const depthTwo = vault.list({ dir: 'a', depth: 2 })
    assert.ok(depthTwo.entries.map((entry) => entry.path).includes('a/sub/three.md'))

    const limited = vault.list({ depth: 2, limit: 2 })
    assert.equal(limited.entries.length, 2)
    assert.equal(limited.truncated, true)

    expectVaultError(() => vault.list({ dir: 'no-such-dir' }), 'not-found', 'list missing dir')
  })

  // ── search ──────────────────────────────────────────────────────────────
  await test('search: scoring (title100/tag60/content40/path30), matched field, snippets, limits', () => {
    const { vault } = freshVault()
    vault.write({ path: 'a-title-hit', content: '# Beta Guide\n\n普通内容。\n', mode: 'create' })
    vault.write({ path: 'body-only', content: '# 另一篇\n\n这里有 beta 关键词。\n', mode: 'create' })
    vault.write({ path: 'tagged', content: '# 标签笔记\n\n无关内容。\n', mode: 'create', frontmatter: { tags: ['beta'] } })
    vault.write({ path: 'beta-folder/path-note', content: '# 路径笔记\n\n无关。\n', mode: 'create' })

    const all = vault.search({ query: 'beta' })
    assert.equal(all.total, 4)
    assert.equal(all.truncated, false)
    assert.equal(all.results.length, 4)
    const byPath = new Map(all.results.map((item) => [item.path, item]))
    assert.equal(byPath.get('a-title-hit.md').matched, 'title')
    assert.equal(byPath.get('a-title-hit.md').score, 140, 'title + content hits accumulate')
    assert.equal(byPath.get('tagged.md').matched, 'tag')
    assert.equal(byPath.get('tagged.md').score, 60)
    assert.equal(byPath.get('body-only.md').matched, 'content')
    assert.equal(byPath.get('body-only.md').score, 40)
    assert.equal(byPath.get('beta-folder/path-note.md').matched, 'path')
    assert.equal(byPath.get('beta-folder/path-note.md').score, 30)
    // 排序：分高在前
    assert.deepEqual(
      all.results.map((item) => item.score),
      [...all.results.map((item) => item.score)].sort((a, b) => b - a),
    )
    // 正文命中行号（1 基，含 frontmatter 行）
    assert.equal(byPath.get('body-only.md').line, 3)
    assert.ok(byPath.get('body-only.md').snippet.includes('beta'))
    assert.equal(typeof byPath.get('body-only.md').snippet, 'string')

    const titleOnly = vault.search({ query: 'beta', mode: 'title' })
    assert.equal(titleOnly.total, 1)
    assert.equal(titleOnly.results[0].path, 'a-title-hit.md')

    const contentOnly = vault.search({ query: 'beta', mode: 'content' })
    assert.ok(contentOnly.results.some((item) => item.path === 'body-only.md'))
    assert.ok(!contentOnly.results.some((item) => item.path === 'tagged.md'))

    const tagMode = vault.search({ query: 'beta', mode: 'tag' })
    assert.deepEqual(tagMode.results.map((item) => item.path), ['tagged.md'])

    const filtered = vault.search({ query: '', tag: 'beta' })
    assert.equal(filtered.total, 1)
    assert.equal(filtered.results[0].path, 'tagged.md')
    assert.equal(filtered.results[0].matched, 'tag')

    const limited = vault.search({ query: 'beta', limit: 1 })
    assert.equal(limited.results.length, 1)
    assert.equal(limited.total, 4)
    assert.equal(limited.truncated, true)

    const upper = vault.search({ query: 'BETA' })
    assert.equal(upper.total, 4, 'search must be case-insensitive')

    expectVaultError(() => vault.search({ query: '' }), 'invalid-path', 'empty query')
    expectVaultError(() => vault.search({ query: 'x', mode: 'bogus' }), 'invalid-path', 'bad mode')
  })

  await test('search: query is literal (not regex) and scoped to dir', () => {
    const { vault } = freshVault()
    vault.write({ path: 'literal-axb', content: '# 一\n\naxb\n', mode: 'create' })
    vault.write({ path: 'literal-dot', content: '# 二\n\na.b\n', mode: 'create' })
    vault.write({ path: 'scope/in-scope', content: '# 三\n\nneedle\n', mode: 'create' })
    vault.write({ path: 'other/out-scope', content: '# 四\n\nneedle\n', mode: 'create' })

    const dot = vault.search({ query: 'a.b' })
    assert.deepEqual(dot.results.map((item) => item.path), ['literal-dot.md'])
    const scoped = vault.search({ query: 'needle', dir: 'scope' })
    assert.equal(scoped.total, 1)
    assert.equal(scoped.results[0].path, 'scope/in-scope.md')
    const unfiltered = vault.search({ query: 'needle' })
    assert.equal(unfiltered.total, 2)
  })

  await test('search: title scoring uses resolved frontmatter.title (not just # heading)', () => {
    const { vault } = freshVault()
    vault.write({
      path: 'fm-title-search',
      content: '# 无关正文标题\n\n普通内容。\n',
      mode: 'create',
      frontmatter: { title: 'needle 作者标题' },
    })
    const titleHit = vault.search({ query: 'needle', mode: 'title' })
    assert.equal(titleHit.total, 1)
    assert.equal(titleHit.results[0].path, 'fm-title-search.md')
    assert.equal(titleHit.results[0].matched, 'title')
    assert.equal(titleHit.results[0].title, 'needle 作者标题')
  })

  // ── daily ───────────────────────────────────────────────────────────────
  await test('daily: read never creates; append creates once; create is idempotent; date format tokens', () => {
    const { vault, vaultPath } = freshVault()
    const read = vault.daily()
    assert.equal(read.path, '2024-01-02.md')
    assert.equal(read.date, '2024-01-02')
    assert.equal(read.created, false)
    assert.equal(read.content, '')
    assert.equal(read.bytes, 0)
    assert.equal(fs.existsSync(path.join(vaultPath, '2024-01-02.md')), false, 'read must not create')

    const appended = vault.daily({ mode: 'append', content: '今天第一段' })
    assert.equal(appended.created, true)
    assert.equal(appended.appended, true)
    assert.ok(appended.content.includes('今天第一段'))
    assert.equal(fs.existsSync(path.join(vaultPath, '2024-01-02.md')), true)

    const second = vault.daily({ mode: 'append', content: '第二段' })
    assert.equal(second.created, false)
    assert.equal(second.appended, true)
    assert.ok(second.content.includes('今天第一段'))
    assert.ok(second.content.includes('第二段'))

    const created = vault.daily({ mode: 'create' })
    assert.equal(created.created, false, 'create on existing must not error and not recreate')
    assert.ok(created.content.includes('第二段'))

    assert.equal(formatDate(new Date(2024, 4, 7, 9, 5), 'YYYY-MM-DD ddd YY/M/D dddd'), '2024-05-07 Tue 24/5/7 Tuesday')
    assert.equal(formatDate(new Date(2024, 4, 7), '[Day] D'), 'Day 7')
    assert.equal(formatDate(new Date(2024, 11, 31), 'YYYY'), '2024')

    expectVaultError(() => vault.daily({ date: '2024-13-01' }), 'invalid-path', 'invalid date')
    expectVaultError(() => vault.daily({ date: 'not-a-date' }), 'invalid-path', 'malformed date')
    expectVaultError(() => vault.daily({ mode: 'bogus' }), 'invalid-path', 'bad mode')
  })

  await test('daily: folder/format/template auto-detected from .obsidian/daily-notes.json with token substitution', () => {
    const { vault, vaultPath } = freshVault()
    fs.mkdirSync(path.join(vaultPath, '.obsidian'), { recursive: true })
    fs.writeFileSync(
      path.join(vaultPath, '.obsidian', 'daily-notes.json'),
      JSON.stringify({ folder: '日记', format: 'YYYY/MM/DD', template: '模板/日记模板.md' }),
      'utf8',
    )
    fs.mkdirSync(path.join(vaultPath, '模板'), { recursive: true })
    fs.writeFileSync(path.join(vaultPath, '模板', '日记模板.md'), '# {{title}}\n\n日期 {{date}} 时间 {{time}}\n\n', 'utf8')

    const result = vault.daily({ date: '2024-03-04', mode: 'append', content: '内容 X' })
    assert.equal(result.path, '日记/2024/03/04.md')
    assert.equal(result.date, '2024/03/04')
    assert.equal(result.created, true)
    assert.ok(result.content.includes('# 04'), `title token: ${JSON.stringify(result.content)}`)
    assert.ok(result.content.includes('日期 2024/03/04'), `date token: ${JSON.stringify(result.content)}`)
    assert.ok(result.content.includes('时间 03:04'), `time token: ${JSON.stringify(result.content)}`)
    assert.ok(result.content.includes('内容 X'))
    assert.equal(fs.existsSync(path.join(vaultPath, '日记', '2024', '03', '04.md')), true)
  })

  // ── tags ────────────────────────────────────────────────────────────────
  await test('tags: frontmatter arrays/strings + inline tags, skips code, sorted by count', () => {
    const { vault } = freshVault()
    vault.write({ path: 'tag-one', content: '# T1\n\n内联 #Beta 和 #alpha。\n', mode: 'create', frontmatter: { tags: ['alpha'] } })
    vault.write({
      path: 'tag-two',
      content: '# T2\n\n```\n#Fenced\n```\n行内 `#CodeTag` 不算。\n',
      mode: 'create',
      frontmatter: { tags: 'alpha, gamma' },
    })
    vault.write({ path: 'tag-heading', content: '# 标题不是标签\n\n## 二级标题\n', mode: 'create' })
    const result = vault.tags()
    assert.equal(result.truncated, false)
    assert.equal(result.total, 3)
    const tags = result.tags.map((entry) => entry.tag)
    assert.deepEqual(tags, ['alpha', 'Beta', 'gamma'])
    const alpha = result.tags.find((entry) => entry.tag === 'alpha')
    assert.equal(alpha.count, 2)
    assert.equal(alpha.notes.length, 2)
    assert.equal(result.tags.find((entry) => entry.tag === 'Beta').count, 1)
    assert.ok(!tags.includes('Fenced'), 'tags inside fenced code must be skipped')
    assert.ok(!tags.includes('CodeTag'), 'tags inside inline code must be skipped')
    assert.ok(!tags.includes('#Fenced'))
  })

  // ── links ───────────────────────────────────────────────────────────────
  await test('links: outgoing dedupe, backlinks, unresolved, path resolution by basename', () => {
    const { vault } = freshVault()
    vault.write({ path: 'a', content: '# A\n\n[[b]] 与 [[b#标题|别名]] 和 ![[c]] 以及 [[missing]] 和 [[#self]]\n', mode: 'create' })
    vault.write({ path: 'b', content: '# B\n\n回到 [[a]]。\n', mode: 'create' })
    vault.write({ path: 'c', content: '# C\n\n无链接。\n', mode: 'create' })
    vault.write({ path: 'dir/target', content: '# Target\n\n', mode: 'create' })
    vault.write({ path: 'ref', content: '# Ref\n\n引用 [[target]]。\n', mode: 'create' })

    const linksA = vault.links({ path: 'a' })
    assert.deepEqual(linksA.outgoing, ['b', 'c', 'missing'])
    assert.deepEqual(linksA.backlinks, ['b.md'])
    assert.deepEqual(linksA.unresolved, ['missing'])
    assert.equal(linksA.truncated, false)

    const linksB = vault.links({ path: 'b.md' })
    assert.deepEqual(linksB.outgoing, ['a'])
    assert.deepEqual(linksB.backlinks, ['a.md'])

    const target = vault.links({ path: 'dir/target.md' })
    assert.deepEqual(target.backlinks, ['ref.md'])
    assert.deepEqual(target.unresolved, [])

    expectVaultError(() => vault.links({ path: 'nope' }), 'not-found', 'links missing note')
  })

  // ── manage ──────────────────────────────────────────────────────────────
  await test('manage: move creates dirs, overwrite rules, trash soft/hard, errors', () => {
    const { vault, vaultPath } = freshVault()
    const sourceResult = vault.write({ path: 'x/one', content: 'move me', mode: 'create' })
    assert.equal(sourceResult.created, true)
    const moved = vault.manage({ action: 'move', from: 'x/one', to: 'y/two' })
    assert.deepEqual(moved, { action: 'move', from: 'x/one.md', to: 'y/two.md' })
    assert.equal(fs.existsSync(path.join(vaultPath, 'y', 'two.md')), true)
    assert.equal(fs.existsSync(path.join(vaultPath, 'x', 'one.md')), false)
    assert.equal(vault.read({ path: 'y/two' }).content, 'move me\n')

    expectVaultError(() => vault.manage({ action: 'move', from: 'x/one', to: 'y/nine' }), 'not-found', 'move missing source')

    vault.write({ path: 'dest', content: 'destination', mode: 'create' })
    vault.write({ path: 'src2', content: 'source2', mode: 'create' })
    expectVaultError(
      () => vault.manage({ action: 'move', from: 'src2', to: 'dest' }),
      'exists',
      'move onto existing without overwrite',
    )
    vault.manage({ action: 'move', from: 'src2', to: 'dest', overwrite: true })
    assert.equal(vault.read({ path: 'dest' }).content, 'source2\n')

    vault.write({ path: 'trash-me', content: '# Trash\n\n', mode: 'create' })
    const trashed = vault.manage({ action: 'trash', path: 'trash-me' })
    assert.equal(trashed.action, 'trash')
    assert.equal(trashed.path, 'trash-me.md')
    assert.equal(trashed.hard, false)
    assert.equal(trashed.trashed, true)
    assert.ok(trashed.trashPath.startsWith('.trash/'), trashed.trashPath)
    assert.ok(trashed.trashPath.endsWith('trash-me.md'))
    assert.equal(fs.existsSync(path.join(vaultPath, 'trash-me.md')), false)
    assert.equal(fs.existsSync(path.join(vaultPath, trashed.trashPath)), true)
    assert.ok(!vault.list().entries.some((entry) => entry.path.startsWith('.trash')))

    vault.write({ path: 'hard-me', content: '# Hard\n\n', mode: 'create' })
    const hard = vault.manage({ action: 'trash', path: 'hard-me', hard: true })
    assert.equal(hard.hard, true)
    assert.equal(hard.trashPath, null)
    assert.equal(fs.existsSync(path.join(vaultPath, 'hard-me.md')), false)

    expectVaultError(() => vault.manage({ action: 'trash', path: 'ghost' }), 'not-found', 'trash missing')
    expectVaultError(() => vault.manage({ action: 'bogus' }), 'invalid-path', 'bad action')
  })

  // ── BOM / 大文件 ────────────────────────────────────────────────────────
  await test('BOM stripping: BOM + CRLF file reads clean and parses frontmatter', () => {
    const { vault, vaultPath } = freshVault()
    const file = path.join(vaultPath, 'bom-note.md')
    fs.writeFileSync(file, '\uFEFF---\r\ntags: [bom]\r\n---\r\n# BOM 标题\r\n\r\n正文内容\r\n', 'utf8')
    const note = vault.read({ path: 'bom-note' })
    assert.deepEqual(note.frontmatter.tags, ['bom'])
    assert.equal(note.title, 'BOM 标题')
    assert.ok(note.content.includes('正文内容'))
    assert.equal(note.content.includes('\r'), false)
    assert.equal(note.frontmatterRaw.includes('\r'), false)
    assert.equal(note.content.charCodeAt(0) === 0xfeff, false)
  })

  await test('truncation + too-large: maxReadBytes, maxBytes param, maxFileBytes guard', () => {
    const { vaultPath, backupDir } = freshVault()
    const small = createVault({ vaultPath, backupDir, maxReadBytes: 20 })
    small.write({ path: 'long', content: '0123456789012345678901234567890', mode: 'create' })
    const truncated = small.read({ path: 'long' })
    assert.equal(truncated.truncated, true)
    assert.equal(truncated.content.length, 20)
    const explicit = small.read({ path: 'long', maxBytes: 5 })
    assert.equal(explicit.truncated, true)
    assert.equal(explicit.content.length, 5)
    const full = small.read({ path: 'long', maxBytes: 1000 })
    assert.equal(full.truncated, false)

    const hardLimited = createVault({ vaultPath, backupDir, maxFileBytes: 64 })
    hardLimited.write({ path: 'big', content: 'x'.repeat(200), mode: 'create' })
    expectVaultError(() => hardLimited.read({ path: 'big' }), 'too-large', 'maxFileBytes guard')
    expectVaultError(() => small.read({ path: 'long', maxBytes: -1 }), 'invalid-path', 'bad maxBytes')
  })

  // ── symlink / junction 逃逸 ─────────────────────────────────────────────
  await test('symlink escape: junction pointing outside the vault is rejected (outside-vault)', () => {
    const { base, vaultPath, vault } = freshVault()
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'secret.md'), '# secret\n\noutside\n', 'utf8')
    const junctionPath = path.join(vaultPath, 'evil')
    let created = false
    try {
      fs.symlinkSync(outside, junctionPath, 'junction')
      created = true
    } catch {
      try {
        fs.symlinkSync(outside, junctionPath, 'dir')
        created = true
      } catch {
        created = false
      }
    }
    if (!created) {
      skip('symlink escape: junction pointing outside the vault is rejected', '无法创建 junction/symlink（权限）')
      return
    }
    try {
      expectVaultError(() => vault.write({ path: 'evil/note.md', content: 'x' }), 'outside-vault', 'write through junction')
      expectVaultError(
        () => vault.read({ path: 'evil/secret.md' }),
        ['outside-vault', 'not-found', 'not-a-file'],
        'read through junction',
      )
      expectVaultError(
        () => vault.list({ dir: 'evil' }),
        ['outside-vault', 'not-found'],
        'list through junction',
      )
      assert.equal(fs.existsSync(path.join(outside, 'note.md')), false, 'must not write outside the vault')
    } finally {
      try {
        fs.rmdirSync(junctionPath)
      } catch {
        /* 清理失败可忽略（临时目录） */
      }
    }
  })

  // ── status ──────────────────────────────────────────────────────────────
  await test('status: counts, bytes, name, daily defaults, obsidian config objects', () => {
    const { vault, vaultPath } = freshVault()
    vault.write({ path: 'a/one', content: '# 1\n\n', mode: 'create' })
    vault.write({ path: 'b/two', content: '# 2\n\n', mode: 'create' })
    vault.write({ path: 'root', content: '# R\n\n', mode: 'create' })
    vault.write({ path: 'b/sub/deep/three', content: '# 3\n\n', mode: 'create' })
    fs.mkdirSync(path.join(vaultPath, '.obsidian'), { recursive: true })
    fs.writeFileSync(path.join(vaultPath, '.obsidian', 'app.json'), JSON.stringify({ theme: 'moon' }), 'utf8')
    fs.writeFileSync(path.join(vaultPath, '.obsidian', 'note.md'), '# ignored\n', 'utf8')

    const status = vault.status()
    assert.equal(status.ok, true)
    assert.equal(status.available, true)
    assert.equal(status.vaultPath, path.resolve(vaultPath))
    assert.equal(status.name, path.basename(vaultPath))
    assert.equal(status.noteCount, 4)
    assert.equal(status.folderCount, 4, 'a, b, b/sub, b/sub/deep')
    const expectedBytes = ['a/one.md', 'b/two.md', 'root.md', 'b/sub/deep/three.md']
      .map((rel) => fs.statSync(path.join(vaultPath, rel)).size)
      .reduce((sum, size) => sum + size, 0)
    assert.equal(status.totalBytes, expectedBytes)
    assert.deepEqual(status.daily, { folder: '', format: 'YYYY-MM-DD', template: '' })
    assert.deepEqual(status.obsidianConfig.appJson, { theme: 'moon' })
    assert.equal(status.obsidianConfig.corePlugins, null)
    assert.equal(status.obsidianConfig.dailyNotes, null)

    fs.writeFileSync(
      path.join(vaultPath, '.obsidian', 'daily-notes.json'),
      JSON.stringify({ folder: '日记', format: 'YYYY/MM/DD', template: '模板/日记模板' }),
      'utf8',
    )
    const detected = vault.status()
    assert.deepEqual(detected.daily, { folder: '日记', format: 'YYYY/MM/DD', template: '模板/日记模板' })
    assert.equal(detected.obsidianConfig.dailyNotes.folder, '日记')
  })

  // ── 汇总 ────────────────────────────────────────────────────────────────
  console.log('')
  console.log(`test-vault: ${passed} passed, ${failed} failed, ${skipped} skipped（fixtures: ${ROOT}）`)
  if (failed > 0) {
    console.log(`failed checks:\n - ${failures.join('\n - ')}`)
    process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error('test-vault crashed:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  })
  .finally(() => {
    if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = ORIGINAL_DSH_HOME
    try {
      fs.rmSync(ROOT, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响测试结论 */
    }
  })
