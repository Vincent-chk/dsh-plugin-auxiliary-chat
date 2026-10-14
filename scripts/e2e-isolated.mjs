#!/usr/bin/env node
/**
 * End-to-end check against a REAL, ISOLATED DSH instance.
 *
 * Boots the composed desktop profile in a throwaway `DSH_HOME` on a private
 * port, then asserts the three things only a live host can prove: the plugin's
 * host half activated, its browser row is in the boot graph with its declared
 * dependencies ahead of it, and the bundle route serves the artifact on disk.
 * The operator's own instance is never touched — different DSH_HOME, different
 * port, and the scratch tree is removed on exit.
 *
 * Usage: node scripts/e2e-isolated.mjs [--port 19520] [--keep]
 * @module scripts/e2e-isolated
 */
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const PORT = portFlag === -1 ? 19520 : Number(argv[portFlag + 1])
const KEEP = argv.includes('--keep')
// Opt-in: also mount the SHIPPED right Sidebar, so the coexistence guard (this
// plugin must yield the `rightbar` seat to it) is exercised for real.
const WITH_OFFICIAL_RIGHTBAR = argv.includes('--with-official-rightbar')
const DSH_HOME_SRC = process.env['DSH_HOME'] ?? join(process.env['HOME'] ?? '', '.dsh')
const DSH_CLI = join(DSH_HOME_SRC, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const passes = []
const failures = []
const check = (ok, label) => (ok ? passes.push(label) : failures.push(`FAIL ${label}`))

if (!existsSync(DSH_CLI)) {
  console.error(`e2e: no dsh CLI at ${DSH_CLI}`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'aux-e2e-'))
const home = join(scratch, 'home')
const profileDir = join(home, 'profiles', 'e2e')
mkdirSync(profileDir, { recursive: true })

// Mirror the operator's profile composition, then append this plugin as a bundle.
const sourceManifest = join(DSH_HOME_SRC, 'profiles', 'desktop', 'package.json')
const manifest = JSON.parse(readFileSync(sourceManifest, 'utf8'))
const manifestBase = existsSync(join(DSH_HOME_SRC, 'profiles', 'desktop', 'pnpm-workspace.yaml'))
  ? readFileSync(join(DSH_HOME_SRC, 'profiles', 'desktop', 'pnpm-workspace.yaml'), 'utf8')
  : 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const bundles = manifest.dsh.profile.bundles.filter((bundle) => bundle !== pkg.name)
if (WITH_OFFICIAL_RIGHTBAR) {
  for (const name of ['@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-ui-sidebar-files']) {
    if (!bundles.includes(name)) bundles.push(name)
  }
}
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify({ name: 'dsh-profile-e2e', private: true, dependencies: { [pkg.name]: `link:${root}` }, dsh: { profile: { bundles: [...bundles, pkg.name] } } }, null, 2)}\n`,
)
writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), manifestBase)
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
// The profile's dependencies come from the real profiles/node_modules, one level up.
symlinkSync(join(DSH_HOME_SRC, 'profiles', 'node_modules'), join(home, 'profiles', 'node_modules'), 'dir')
const scopeDir = join(profileDir, 'node_modules', ...pkg.name.split('/').slice(0, -1))
mkdirSync(scopeDir, { recursive: true })
symlinkSync(root, join(scopeDir, pkg.name.split('/').at(-1)), 'dir')

const logPath = join(scratch, 'boot.log')
const child = spawn(process.execPath, [DSH_CLI, '--profile', 'e2e', '--port', String(PORT), '--no-open'], {
  cwd: profileDir,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (chunk) => { log += String(chunk) })
child.stderr.on('data', (chunk) => { log += String(chunk) })

/** Poll until the launcher prints its authenticated URL. */
async function waitForUrl(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
    if (match !== null) return match[0]
    if (/startup failed/.test(log)) return undefined
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return undefined
}



/**
 * Decompress one session log IN FULL. `zlib.zstdDecompressSync` stops after
 * the FIRST frame, and session logs are appended as one zstd frame per
 * write — so walk every frame magic and decompress each frame separately.
 * An accidental magic inside compressed data fails to decode and is skipped.
 */
function readLogText(path) {
  const buf = readFileSync(path)
  const parts = []
  const offsets = [0]
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
  }
  for (const offset of offsets) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offset)).toString('utf8'))
    } catch { /* not a real frame start */ }
  }
  return parts.join('')
}

/** One authenticated RPC call over the gateway's HTTP carrier. */
async function rpc(endpoint, args, cookie) {
  const response = await fetch(`http://127.0.0.1:${String(PORT)}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify({ type: 'client-request', rpcId: `e2e-${endpoint.replace(/\W/g, '-')}-${String(Date.now())}`, method: endpoint, payload: { args } }),
  })
  return response.json()
}

try {
  const url = await waitForUrl()
  if (url === undefined) {
    console.error('e2e: instance did not come up\n--- boot log ---\n' + log)
    process.exit(1)
  }
  check(true, 'isolated instance booted')

  // Auth: the token URL sets the cookie, then redirects to the app root.
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0]
  check(cookie !== '', 'token exchange returned an auth cookie')

  const indexResponse = await fetch(`http://127.0.0.1:${String(PORT)}/`, { headers: { cookie } })
  const html = await indexResponse.text()
  const graphMatch = html.match(/__DSH_BOOT__"\]\s*=\s*(\{.*?\})\s*;?\s*<\/script>/s) ?? html.match(/__DSH_BOOT__\s*=\s*(\{.*?\})\s*;?\s*<\/script>/s)
  check(graphMatch !== null, 'boot graph is injected into the index')
  if (graphMatch !== null) {
    const graph = JSON.parse(graphMatch[1].trim().replace(/;$/, '').replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'))
    const ids = graph.entries.map((entry) => entry.id)
    const mine = graph.entries.find((entry) => entry.id === pkg.name)
    check(mine !== undefined, `boot graph carries ${pkg.name}`)
    if (mine !== undefined) {
      check(ids.indexOf(pkg.name) > 0, 'plugin row is not the first row')
      // WHICH PATH DOES THIS COMPOSITION PUT THE PLUGIN ON?
      // `ui-sidebar-right` is mounted unconditionally by the web-app bundle patch,
      // and the desktop profile includes that bundle — so the REAL app renders the
      // auxiliary chat as a tab type inside the shipped right Sidebar (path B),
      // never as its own `rightbar` occupant (path A). An earlier round of this
      // plugin was designed and verified against path A and was therefore dead on
      // the real machine; this assertion exists so that mistake cannot recur.
      const shippedRightSidebar = ids.includes('@deepseek-ai/dsh-client-ui-sidebar-right')
      check(
        shippedRightSidebar,
        `the shipped right Sidebar is in the boot graph, so this composition runs PATH B (${shippedRightSidebar ? 'present' : 'ABSENT — the plugin would fall back to path A and the guide entry would not exist'})`,
      )
      if (shippedRightSidebar) {
        const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
        check(client.includes('sidebar.right.pane.tab'), 'path B body is registered in the artifact')
        check(client.includes('useTabInfo'), 'path B body reads the tab identity/lifetime hook')
        check(!client.includes('auxc-tabs'), 'no internal tab strip is shipped (the host owns tabs)')
      }

      for (const dep of mine.inject ?? []) {
        const at = ids.indexOf(dep)
        check(at === -1 || at < ids.indexOf(pkg.name), `declared dependency precedes this row: ${dep}`)
      }
      const bundleResponse = await fetch(`http://127.0.0.1:${String(PORT)}/${mine.url}`, { headers: { cookie } })
      check(bundleResponse.status === 200, `bundle route answers 200 (${String(bundleResponse.status)})`)
      const served = Buffer.from(await bundleResponse.arrayBuffer())
      const disk = readFileSync(join(root, 'lib/client.js'))
      check(served.subarray(0, disk.length).equals(disk.subarray(0, disk.length)), 'served bundle is byte-identical to lib/client.js')
    }
  }

  if (WITH_OFFICIAL_RIGHTBAR) {
    // Both rows must coexist: the shipped one and this plugin's.
    const official = html.includes('@deepseek-ai/dsh-client-ui-sidebar-right')
    check(official, 'shipped right Sidebar row is in the boot graph')
    check(html.includes(pkg.name), 'this plugin still activates beside the shipped right Sidebar')
  }

  const inventory = await rpc('pluginInventory/list', {}, cookie)
  const entries = inventory?.result?.value?.entries ?? []
  const row = entries.find((entry) => entry.moduleName === pkg.name)
  check(row !== undefined, 'host entry is listed in the plugin inventory')
  check(row?.fiberPhase === 'active', `host fiber phase is active (${String(row?.fiberPhase)})`)
  const failed = entries.filter((entry) => entry.fiberPhase === 'failed').map((entry) => entry.entryId)
  check(failed.length === 0, `no failed fibers${failed.length === 0 ? '' : `: ${failed.join(', ')}`}`)

  // The host half must be reachable through the frozen command transport.
  const created = await rpc('session/create', { request: { cwd: join(scratch, 'ws'), sessionId: 'session-e2e-main-0001' } }, cookie)
  check(created?.result?.ok === true, 'main session created for the probe')
  // Two-phase creation, exactly as the client performs it: the plain session
  // exists first, and `/aux-init` runs INSIDE it (never inside the main
  // session, whose transcript must stay untouched).
  const auxId = 'session-e2e-aux-0001'
  const blank = await rpc('session/create', { request: { cwd: join(scratch, 'ws'), sessionId: auxId } }, cookie)
  check(blank?.result?.ok === true, 'plain auxiliary session created first')
  const exec = await rpc('commands/execute', {
    agentId: auxId,
    line: `/aux-init ${JSON.stringify({ sessionId: auxId, mirrorOf: 'session-e2e-main-0001' })}`,
    submittedAttachments: [],
  }, cookie)
  const result = exec?.result?.value?.result
  check(result?.kind === 'success', `aux-init command succeeded (${String(result?.kind)}: ${String(result?.text).slice(0, 160)})`)
  let hostGeneration = ''
  if (result?.kind === 'success') {
    const payload = JSON.parse(result.text)
    check(payload.ok === true, 'init payload reports ok')
    check(typeof payload.info?.permissionPreset === 'string', 'payload carries the mirrored permission preset')
    check(payload.downgrade === 'summary' || payload.downgrade === 'none', 'payload reports the context delivery mode')
    // PRD v2.0 §4.2: every create result names the Host boot generation.
    hostGeneration = typeof payload.info?.hostGeneration === 'string' ? payload.info.hostGeneration : ''
    check(hostGeneration.startsWith('gen-'), `init payload carries the host boot generation (${hostGeneration || 'MISSING'})`)
  }
  // The main session's own log must not carry the creation lifecycle (R06).
  const mainMarked = existsSync(join(home, 'aux-chat', 'sessions', 'session-e2e-main-0001.json'))
  check(mainMarked === false, 'main session was never registered as auxiliary')

  // ── Sidebar hiding (default ON): the archive set must contain the child,
  // a prompt must still traverse the FULL pre-step chain (gate bridged, not
  // vetoed), and the idle re-archiver must re-hide the row afterwards.
  const readArchived = () => {
    try {
      const state = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
      const ids = state?.global?.archivedSessionIds
      return Array.isArray(ids) ? ids : []
    } catch {
      return []
    }
  }
  check(readArchived().includes(auxId), 'the auxiliary session is archived (hidden from sidebar + search)')
  const prompted = await rpc('session/prompt', {
    request: {
      requestId: 'e2e-req-0001',
      sessionId: auxId,
      mode: 'queue',
      content: [{ type: 'text', text: 'e2e gate-bridge probe: reply with the number 2 only' }],
    },
  }, cookie)
  check(prompted?.result?.ok === true, `prompt accepted on the archived auxiliary session (${String(prompted?.result?.ok)})`)
  await new Promise((resolve) => setTimeout(resolve, 4000))
  const auxLogText = (() => {
    let projects = []
    try {
      projects = readdirSync(join(home, 'sessions'))
    } catch { /* none */ }
    for (const project of projects) {
      const candidate = join(home, 'sessions', project, 'session-e2e-aux-0001', 'session.v4.jsonl.zstd')
      try {
        return readLogText(candidate)
      } catch { /* keep scanning */ }
    }
    return ''
  })()
  check(auxLogText.includes('"step/start"'), 'the archived session produced a step/start (the gate did not block it)')
  check(auxLogText.includes('Current runtime context'), 'the FULL pre-step chain ran (runtime context injected — not the round-6 veto)')
  check(auxLogText.includes('"request/header"'), 'the turn reached the model request boundary (a gate-blocked turn never does)')
  check(readArchived().includes(auxId), 'the idle re-archiver re-hid the session after the turn')
  // ── PRD v2.0 reclaim (E12/T16): a live registered child is re-attached,
  // never duplicated; a wrong parent and a foreign id are both refused.
  const reclaim = await rpc('commands/execute', {
    agentId: auxId,
    line: `/aux-init ${JSON.stringify({ sessionId: auxId, mirrorOf: 'session-e2e-main-0001', mode: 'reclaim' })}`,
    submittedAttachments: [],
  }, cookie)
  const reclaimResult = reclaim?.result?.value?.result
  check(reclaimResult?.kind === 'success', `reclaim of the live child succeeded (${String(reclaimResult?.kind)})`)
  if (reclaimResult?.kind === 'success') {
    const payload = JSON.parse(reclaimResult.text)
    check(payload.reclaimed === true && payload.info?.sessionId === auxId, 'reclaim reports reclaimed:true for the SAME child')
  }
  const wrongParent = await rpc('commands/execute', {
    agentId: auxId,
    line: `/aux-init ${JSON.stringify({ sessionId: auxId, mirrorOf: 'session-e2e-main-OTHER', mode: 'reclaim' })}`,
    submittedAttachments: [],
  }, cookie)
  check(
    String(wrongParent?.result?.value?.result?.text ?? '').startsWith('aux-chat/reclaim-mismatch:'),
    `reclaim with a wrong parent is refused (${String(wrongParent?.result?.value?.result?.text).slice(0, 80)})`,
  )
  const foreignId = 'session-e2e-aux-0002'
  await rpc('session/create', { request: { cwd: join(scratch, 'ws'), sessionId: foreignId } }, cookie)
  const foreignReclaim = await rpc('commands/execute', {
    agentId: foreignId,
    line: `/aux-init ${JSON.stringify({ sessionId: foreignId, mirrorOf: 'session-e2e-main-0001', mode: 'reclaim' })}`,
    submittedAttachments: [],
  }, cookie)
  check(
    String(foreignReclaim?.result?.value?.result?.text ?? '').startsWith('aux-chat/session-not-created:'),
    `reclaim of a never-auxiliary session is refused (${String(foreignReclaim?.result?.value?.result?.text).slice(0, 80)})`,
  )
  await rpc('commands/execute', { agentId: foreignId, line: `/aux-end ${JSON.stringify({ sessionId: foreignId })}`, submittedAttachments: [] }, cookie).catch(() => undefined)
  // ── PRD v2.0 T12: a close carrying a DEAD host generation is refused and
  // touches nothing; the close with the captured binding succeeds and echoes
  // its operation id.
  const staleEnd = await rpc('commands/execute', {
    agentId: auxId,
    line: `/aux-end ${JSON.stringify({ sessionId: auxId, operationId: 'close-op-stale', hostGeneration: 'gen-dead-boot' })}`,
    submittedAttachments: [],
  }, cookie)
  check(
    String(staleEnd?.result?.value?.result?.text ?? '').startsWith('aux-chat/stale-generation:'),
    `a stale-generation close is refused (${String(staleEnd?.result?.value?.result?.text).slice(0, 80)})`,
  )
  check(existsSync(join(home, 'aux-chat', 'sessions', `${auxId}.json`)), 'the refused stale close left the resource untouched (marker still present)')
  const operationId = 'close-op-e2e-0001'
  const ended = await rpc('commands/execute', {
    agentId: auxId,
    line: `/aux-end ${JSON.stringify({ sessionId: auxId, operationId, ...(hostGeneration === '' ? {} : { hostGeneration }) })}`,
    submittedAttachments: [],
  }, cookie)
  const endResult = ended?.result?.value?.result
  check(endResult?.kind === 'success', `aux-end command succeeded (${String(endResult?.kind)})`)
  if (endResult?.kind === 'success') {
    const payload = JSON.parse(endResult.text)
    check(payload.operationId === operationId, `aux-end echoes the close operation id (${String(payload.operationId)})`)
  }
  check(existsSync(join(home, 'sessions')) === false || !existsSync(join(home, 'aux-chat', 'sessions', `${auxId}.json`)), 'crash marker removed by destroy')
} finally {
  child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  try { child.kill('SIGKILL') } catch { /* already gone */ }
  if (!KEEP) rmSync(scratch, { recursive: true, force: true })
}

for (const line of passes) console.log(`ok   ${line}`)
for (const line of failures) console.error(line)
console.log(failures.length === 0 ? `e2e: ${String(passes.length)} checks passed` : `e2e: ${String(failures.length)} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
