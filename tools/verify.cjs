#!/usr/bin/env node
/**
 * One-command offline verification for dsh-plugin-obsidian.
 *
 * Runs every suite under tools/:
 *   test-vault.cjs  test-tools.cjs  test-api.cjs   (host-core, offline unit/integration)
 *   check-client.cjs                                (client-ui contract + shallow render)
 *   harness-host.cjs                                (Lead: real apply() + real HTTP + real tool execution)
 *
 * Usage: node tools/verify.cjs [--only <substring>]
 *
 * A suite is SKIPPED (not passed) when its file is absent, so this can run while
 * the plugin is still being assembled. Exit code 0 requires every present suite
 * to exit 0 and at least one suite to have run.
 */

'use strict'

const { existsSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const TOOLS = __dirname
const SUITES = [
  'test-vault.cjs',
  'test-tools.cjs',
  'test-api.cjs',
  'check-client.cjs',
  'harness-host.cjs',
]

const onlyIndex = process.argv.indexOf('--only')
const only = onlyIndex === -1 ? null : String(process.argv[onlyIndex + 1] || '')

const results = []
const started = Date.now()

for (const suite of SUITES) {
  if (only !== null && !suite.includes(only)) continue
  const file = join(TOOLS, suite)
  if (!existsSync(file)) {
    results.push({ suite, status: 'SKIP', detail: 'file not present yet' })
    console.log(`\n===== SKIP ${suite} (not present yet) =====`)
    continue
  }
  console.log(`\n===== RUN ${suite} =====`)
  const run = spawnSync(process.execPath, [file], { stdio: 'inherit', cwd: join(TOOLS, '..') })
  const status = run.status === 0 ? 'PASS' : `FAIL (exit ${run.status})`
  results.push({ suite, status, detail: `exit ${run.status}` })
  console.log(`===== ${status} ${suite} =====`)
}

const ran = results.filter((r) => r.status !== 'SKIP')
const failedSuites = results.filter((r) => r.status !== 'PASS' && r.status !== 'SKIP')

console.log('\n================ VERIFICATION SUMMARY ================')
for (const r of results) console.log(`${r.status.padEnd(14)} ${r.suite}  (${r.detail})`)
console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`)

if (ran.length === 0) {
  console.log('RESULT: NOTHING RAN')
  process.exitCode = 1
} else if (failedSuites.length > 0) {
  console.log(`RESULT: FAIL (${failedSuites.length} suite(s) failed)`)
  process.exitCode = 1
} else {
  console.log(`RESULT: PASS (${ran.length} suite(s))`)
}
