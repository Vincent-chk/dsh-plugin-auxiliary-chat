#!/usr/bin/env node
/**
 * Verify that the built package satisfies every hard condition client-modules
 * enforces at composition time, without needing a running DSH. Run it after
 * `node scripts/build.mjs`; pass a profile directory to also check that the
 * profile can resolve the package.
 *
 *   node scripts/verify.mjs [--profile-dir /Users/you/.dsh/profiles/desktop]
 * @module scripts/verify
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCopyChecks, runCopyTruthChecks } from './copy-gates.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const failures = []
const notes = []

/** @param condition - whether the check held. @param message - what was checked. */
const check = (condition, message) => (condition ? notes.push(`ok   ${message}`) : failures.push(`FAIL ${message}`))

// ── package.json ────────────────────────────────────────────────────────────
check(typeof pkg.name === 'string' && pkg.name.length > 0, 'package.json declares a name')
check(typeof pkg.version === 'string', 'package.json declares a version')
check(pkg.main !== undefined, 'package.json declares "main" (the Host half the Loader imports)')

const clientDecl = pkg.dsh?.client
check(clientDecl !== undefined, 'package.json declares dsh.client')
check(clientDecl?.platform === 'web', 'dsh.client.platform is "web" (any other value is ignored)')
check(
  clientDecl?.inject === undefined || (Array.isArray(clientDecl.inject) && clientDecl.inject.every((s) => typeof s === 'string')),
  'dsh.client.inject is an array of strings',
)
check(
  clientDecl?.external === undefined ||
    (Array.isArray(clientDecl.external) && clientDecl.external.every((s) => typeof s === 'string')),
  'dsh.client.external is an array of strings',
)
check(
  clientDecl?.immediately === undefined || typeof clientDecl.immediately === 'boolean',
  'dsh.client.immediately is a boolean',
)

const clientExport = pkg.exports?.['./client']
const clientRel =
  typeof clientExport === 'string' ? clientExport : typeof clientExport?.default === 'string' ? clientExport.default : undefined
check(clientRel !== undefined, 'exports["./client"] is a string or an object with a string default')

// ── the built artifacts ─────────────────────────────────────────────────────
check(existsSync(join(root, pkg.main)), `main artifact exists (${String(pkg.main)})`)
const clientPath = clientRel === undefined ? undefined : join(root, clientRel)
if (clientPath !== undefined) {
  check(existsSync(clientPath), `client artifact exists (${clientRel})`)
  if (existsSync(clientPath)) {
    const source = readFileSync(clientPath, 'utf8')
    check(source.startsWith('window.__ModuleLoader__.load('), 'client artifact calls window.__ModuleLoader__.load(...) as its first statement')
    check(source.includes(`id: ${JSON.stringify(pkg.name)}`), 'client artifact registers under the package name')
    check(/factory:\s*\(require\)\s*=>/.test(source), 'client artifact registers a factory taking `require`')
    check(/return module\.exports;/.test(source), 'factory returns module.exports')
    const stat = statSync(clientPath)
    check(stat.size > 0, `client artifact is non-empty (${String(stat.size)} bytes)`)
  }
}

// ── the patch layer ─────────────────────────────────────────────────────────
const patchRel = pkg.dsh?.bundle?.patch
if (patchRel !== undefined) {
  const patchPath = join(root, typeof patchRel === 'string' ? patchRel : patchRel[0])
  check(existsSync(patchPath), `bundle patch exists (${String(patchRel)})`)
  if (existsSync(patchPath)) {
    const text = readFileSync(patchPath, 'utf8')
    const ids = [...text.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((match) => match[1])
    check(ids.length === [...new Set(ids)].length, 'patch row ids are unique')
    const names = [...text.matchAll(/^\s*name:\s*'?([^'\s]+)'?/gm)].map((match) => match[1])
    check(
      names.filter((name) => name === pkg.name).length === 1,
      `exactly one patch row names the package (${String(names.filter((n) => n === pkg.name).length)} found)`,
    )
  }
} else {
  notes.push('note dsh.bundle.patch is absent: install this plugin as a plain profile patch row instead')
}

// ── optional: profile resolution ────────────────────────────────────────────
const flag = process.argv.indexOf('--profile-dir')
if (flag !== -1) {
  const profileDir = resolve(process.argv[flag + 1] ?? '')
  check(existsSync(join(profileDir, 'package.json')), `profile directory exists (${profileDir})`)
  try {
    const resolved = createRequire(join(profileDir, 'noop.js')).resolve(`${pkg.name}/package.json`)
    check(true, `profile resolves ${pkg.name} -> ${resolved}`)
    const installed = JSON.parse(readFileSync(resolved, 'utf8'))
    check(installed.name === pkg.name, 'resolved manifest name matches')
    check(installed.dsh?.client?.platform === 'web', 'resolved manifest still declares dsh.client.platform = web')
  } catch (error) {
    failures.push(`FAIL profile cannot resolve ${pkg.name}: ${String(error.message)}`)
    failures.push('     fix: add the dependency to the profile package.json and run pnpm install, or `dsh plugin --profile <p> add <spec>`')
  }
}

// ── copy governance gates (refactor plan v2, P0/WP0.2 + WP0.3) ──────────────
for (const result of [...runCopyChecks(root), ...runCopyTruthChecks(root)]) {
  check(result.ok, result.message)
}

for (const line of notes) console.log(line)
for (const line of failures) console.error(line)
console.log(
  failures.length === 0
    ? `verify: ${String(notes.length)} checks passed for ${pkg.name}@${pkg.version}`
    : `verify: ${String(failures.length)} FAILED`,
)
process.exit(failures.length === 0 ? 0 : 1)
