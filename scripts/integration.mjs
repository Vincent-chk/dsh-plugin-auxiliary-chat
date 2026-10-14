#!/usr/bin/env node
/**
 * Cross-half integration guard.
 *
 * The contract file is shared by two independently authored halves, so this
 * script is the machine check that they still agree: constant values, the slot
 * identity pair the sidebar validates at click time, the command names the
 * transport contract freezes, and the host half's runtime import surface.
 *
 * It reads BUILD ARTIFACTS (`lib/*.js`), not sources, so it catches a half that
 * was never rebuilt as well as one that drifted.
 * @module scripts/integration
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const passes = []

/**
 * @param {boolean} ok - whether the assertion held.
 * @param {string} label - human-readable assertion.
 */
function check(ok, label) {
  if (ok) passes.push(label)
  else failures.push(`FAIL ${label}`)
}

const contract = readFileSync(join(root, 'src/contract.ts'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const hostArtifact = join(root, 'lib/index.js')
const clientArtifact = join(root, 'lib/client.js')

/**
 * Pull one contract constant's VALUE, following a single alias hop.
 *
 * The contract expresses identity by aliasing (`export const PANEL_ID =
 * PACKAGE_NAME`) rather than repeating a literal, so a literal-only reader
 * would report a false mismatch — and repetition is exactly what this guard
 * exists to prevent.
 * @param name - exported constant name.
 * @returns its literal value, or undefined when unresolvable.
 */
function contractConst(name) {
  const literals = new Map()
  const aliases = new Map()
  for (const match of contract.matchAll(/export const (\w+)\s*=\s*([^\n]+)/g)) {
    const [, key, raw] = match
    const literal = raw.match(/^'([^']*)'\s*$/)
    if (literal !== null) literals.set(key, literal[1])
    else aliases.set(key, raw.trim())
  }
  const seen = new Set()
  let current = name
  while (!seen.has(current)) {
    seen.add(current)
    if (literals.has(current)) return literals.get(current)
    const next = aliases.get(current)
    if (next === undefined) return undefined
    current = next
  }
  return undefined
}

const PANEL_ID = contractConst('PANEL_ID')
const PACKAGE_NAME = contractConst('PACKAGE_NAME')
const SLOT_AUX_CHAT = contractConst('SLOT_AUX_CHAT')
const LOCALE_NS = contractConst('LOCALE_NS')

// ── contract self-consistency ────────────────────────────────────────────────
check(PACKAGE_NAME === pkg.name, `contract PACKAGE_NAME equals package.json name (${String(PACKAGE_NAME)})`)
check(PANEL_ID === PACKAGE_NAME, 'contract PANEL_ID aliases PACKAGE_NAME (entry id == main key)')
check(typeof SLOT_AUX_CHAT === 'string' && SLOT_AUX_CHAT !== '', `contract SLOT_AUX_CHAT is set (${String(SLOT_AUX_CHAT)})`)
check(typeof LOCALE_NS === 'string' && LOCALE_NS !== '', `contract LOCALE_NS is set (${String(LOCALE_NS)})`)

// ── the client half must register the pair the sidebar validates ─────────────
if (!existsSync(clientArtifact)) {
  failures.push('FAIL client artifact lib/client.js is absent — run `node scripts/build.mjs --half client`')
} else {
  const client = readFileSync(clientArtifact, 'utf8')
  const panelId = PANEL_ID ?? ''
  check(client.includes('__ModuleLoader__.load('), 'client artifact registers a factory')
  check(client.includes(`"${pkg.name}"`) || client.includes(`'${pkg.name}'`), `client artifact registers under ${pkg.name}`)
  // The auxiliary chat is an in-conversation right-hand split, NOT a global
  // panel: it must occupy the frame's rightbar and put its toggle in the
  // conversation header, and it must NOT come back as a sidebar entry.
  check(
    client.includes("'conversation.session.header.utilities'") || client.includes('"conversation.session.header.utilities"'),
    'client half registers the conversation-header toggle',
  )
  // The transport rides `remote.commands`, which Cordis resolves as a service
  // PATH: an undeclared one throws at access time instead of yielding
  // undefined, so both levels must appear in the exported inject array.
  check(
    /inject\s*=\s*\[[^\]]*["']remote["'][^\]]*\]/.test(client) && client.includes('remote.commands'),
    'client half declares remote + remote.commands in its inject list',
  )
  check(client.includes("'rightbar'") || client.includes('"rightbar"'), 'client half occupies the frame rightbar')
  check(
    client.includes("'rightbar.session'") || client.includes('"rightbar.session"'),
    'client half declares the session-scoped rightbar.session child',
  )
  check(!client.includes('sidebar.panellist'), 'client half no longer registers a sidebar entry')
  check(!client.includes("name: \"main\"") && !client.includes("name: 'main'"), 'client half no longer registers a keyed main panel')
  if (panelId !== '') {
    // The id and the key must both appear; build.mjs inlines contract constants.
    const occurrences = client.split(panelId).length - 1
    check(occurrences >= 2, `client artifact references PANEL_ID at least twice (id + key): ${String(occurrences)}`)
  }
  check(
    client.includes("'conversation.content'") || client.includes('"conversation.content"'),
    'client half renders the reusable conversation.content factory',
  )
  check(
    client.includes('SessionProvider'),
    'client half binds an explicit SessionProvider (required for a non-selected session)',
  )
  for (const spec of [...client.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])) {
    const SEED = new Set([
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-dockkit',
    ])
    const declared = new Set(pkg.dsh?.client?.external ?? [])
    check(SEED.has(spec) || declared.has(spec), `client require is a seed word or declared external: ${spec}`)
  }
  // PRD v2.0 close/identity contract must survive into the client artifact:
  // the close watchdog + failure state, and the generation binding.
  check(client.includes('closeFailed'), 'client half carries the closeFailed state (E07)')
  check(client.includes('closeOperationId'), 'client half mints and reuses close operation ids (§6.3/§9)')
  check(client.includes('hostGeneration'), 'client half binds and echoes the host generation (§4.2)')
}

// ── the host half must register the frozen command names ────────────────────
if (!existsSync(hostArtifact)) {
  failures.push('FAIL host artifact lib/index.js is absent — run `node scripts/build.mjs --half host`')
} else {
  const host = readFileSync(hostArtifact, 'utf8')
  check(host.includes('aux-init'), 'host half registers the aux-init command name')
  check(host.includes('aux-end'), 'host half registers the aux-end command name')
  check(host.includes('aux-end'), 'host half registers the aux-end command name')
  check(
    /recordInput:\s*false/.test(host),
    'host half sets recordInput:false (keeps the JSON payload out of the session log)',
  )
  check(host.includes('aux-chat/stale-generation'), 'host half refuses stale-generation closes (T12)')
  check(host.includes('reclaim-mismatch'), 'host half refuses reclaims that would rebind a parent')
  for (const forbidden of ['react', 'react-dom', '@deepseek-ai/dsh-client-']) {
    const pattern = new RegExp(`from\\s*['"]${forbidden.replace(/[/@]/g, (c) => `\\${c}`)}`)
    check(!pattern.test(host), `host half does not import ${forbidden}`)
  }
  check(host.includes('export'), 'host artifact has ESM exports')
}

for (const line of passes) console.log(`ok   ${line}`)
for (const line of failures) console.error(line)
console.log(
  failures.length === 0
    ? `integration: ${String(passes.length)} cross-half checks passed for ${pkg.name}@${pkg.version}`
    : `integration: ${String(failures.length)} FAILED`,
)
process.exit(failures.length === 0 ? 0 : 1)
