#!/usr/bin/env node
/**
 * Read-only smoke test against the REAL Obsidian vault.
 *
 * Safety property this script proves by construction: it snapshots SHA-256 +
 * byte size of every file in the vault before and after the read-only probe and
 * fails if anything changed. It never calls a mutating method, and it refuses
 * to run if the target is not an Obsidian vault.
 *
 * Usage: node tools/smoke-real-vault.cjs ["C:\path\to\vault"]
 * Default target: %DSH_OBSIDIAN_VAULT% or C:\Users\<user>\Documents\Obsidian Vault
 */

'use strict'

const { readdirSync, statSync, readFileSync, existsSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { join, relative } = require('node:path')
const { homedir } = require('node:os')
const { pathToFileURL } = require('node:url')

const DEFAULT_VAULT = process.env.DSH_OBSIDIAN_VAULT
  || join(homedir(), 'Documents', 'Obsidian Vault')

const repo = join(__dirname, '..')
let passed = 0
let failed = 0
function ok(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS ${name}`) } else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ` :: ${detail}`}`) }
}
function section(t) { console.log(`\n--- ${t} ---`) }

function snapshot(root) {
  const out = new Map()
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const buffer = readFileSync(full)
        out.set(relative(root, full), `${buffer.length}:${createHash('sha256').update(buffer).digest('hex')}`)
      } catch { /* unreadable: skip */ }
    }
  }
  walk(root)
  return out
}

async function main() {
  const vaultPath = process.argv[2] || DEFAULT_VAULT
  section('target')
  ok('vault path exists', existsSync(vaultPath), vaultPath)
  ok('vault has .obsidian/', existsSync(join(vaultPath, '.obsidian')), vaultPath)
  if (!existsSync(vaultPath) || !existsSync(join(vaultPath, '.obsidian'))) {
    console.log(`\nsmoke-real-vault: cannot continue (not a vault): ${vaultPath}`)
    process.exitCode = 1
    return
  }

  const mod = await import(pathToFileURL(join(repo, 'lib', 'vault.js')).href)
  const vault = mod.createVault({ vaultPath })

  section('read-only probe (every mutating call is absent from this file)')
  const before = snapshot(vaultPath)
  ok('vault has readable markdown files', before.size > 0, `${before.size} files`)

  const status = vault.status()
  ok('status reports the real vault path', String(status.vaultPath).replace(/\\/g, '/').toLowerCase()
    .endsWith(String(vaultPath).replace(/\\/g, '/').toLowerCase()), status.vaultPath)
  ok('status counts the real note set (>=7 .md files)', status.noteCount >= 7, String(status.noteCount))
  ok('status exposes daily config', Boolean(status.daily && typeof status.daily.format === 'string'),
    JSON.stringify(status.daily))

  const tree = vault.list({ dir: '', depth: 2, limit: 500 })
  const paths = tree.entries.map((e) => e.path)
  ok('root listing includes 首页.md', paths.includes('首页.md'), JSON.stringify(paths).slice(0, 300))
  ok('root listing includes the 日记 folder', tree.entries.some((e) => e.type === 'folder' && e.path === '日记'),
    JSON.stringify(tree.entries.filter((e) => e.type === 'folder').map((e) => e.path)))
  ok('root listing hides .obsidian', !paths.some((p) => p.startsWith('.obsidian')), JSON.stringify(paths).slice(0, 300))

  const home = vault.read({ path: '首页.md' })
  // 首页.md carries frontmatter title 首页 and a body heading 我的知识体系:
  // the frontmatter title is the authoring intent, so it must win.
  ok('reads 首页.md with the frontmatter title', home.title === '首页', home.title)
  ok('parses the real wikilinks from 首页.md',
    home.links.includes('收件箱') && home.links.includes('为什么笔记要原子化'), JSON.stringify(home.links))
  ok('body keeps the first heading as content', home.content.includes('# 我的知识体系'),
    JSON.stringify(home.content.slice(0, 80)))
  ok('body is non-empty Chinese text', home.content.length > 10 && /[\u4e00-\u9fff]/.test(home.content),
    String(home.content.length))
  ok('frontmatter keeps type/created/tags from the real file',
    home.frontmatter.type === 'MOC' && String(home.frontmatter.created) === '2026-10-23'
    && Array.isArray(home.frontmatter.tags) && home.frontmatter.tags.includes('MOC'),
    JSON.stringify(home.frontmatter))

  const search = vault.search({ query: '笔记', limit: 20 })
  ok('search finds hits for 笔记', search.results.length > 0, JSON.stringify(search.results.map((r) => r.path)))
  ok('search snippets are single-line', search.results.every((r) => !r.snippet.includes('\n')))

  const tags = vault.tags()
  ok('tag aggregation works on the real vault', tags.tags.length > 0,
    JSON.stringify(tags.tags.slice(0, 10).map((t) => `${t.tag}:${t.count}`)))

  const links = vault.links({ path: '首页.md' })
  ok('links() returns arrays', Array.isArray(links.outgoing) && Array.isArray(links.backlinks) && Array.isArray(links.unresolved))

  let rejected = null
  try { vault.read({ path: '../outside.md' }) } catch (error) { rejected = error }
  ok('traversal is rejected on the real vault', rejected !== null && /invalid-path|outside-vault/.test(rejected.code || rejected.message),
    rejected && rejected.message)

  let protectedWrite = null
  try {
    vault.write({ path: '.obsidian/evil.md', content: 'x', mode: 'create' })
  } catch (error) {
    protectedWrite = error
  }
  ok('writes into .obsidian/ are refused', protectedWrite !== null, protectedWrite && `${protectedWrite.code || ''} ${protectedWrite.message}`)

  const after = snapshot(vaultPath)
  const changed = []
  for (const [file, digest] of before) {
    if (after.get(file) !== digest) changed.push(file)
  }
  for (const file of after.keys()) {
    if (!before.has(file)) changed.push(`+${file}`)
  }
  ok('vault is byte-identical after the smoke test', changed.length === 0, changed.slice(0, 10).join(', '))

  console.log(`\nsmoke-real-vault: ${passed} passed, ${failed} failed (${before.size} files verified unchanged)`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('smoke-real-vault crashed:', error && error.stack || error)
  process.exitCode = 1
})
