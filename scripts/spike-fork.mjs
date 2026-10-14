#!/usr/bin/env node
/**
 * Spike for the v3 refactor (fork-based creation + form-A mirror injection).
 *
 * PART 1 (in-process, no app boot): constructs a real `Session` from the
 * shipped dsh-session package and answers:
 *   S1 — does `append('user/message', …)` accept a custom `source.kind`
 *        (the form-A hidden-context channel)?
 *   S2 — does `deriveMessages()` carry it into the model-visible history?
 *   S3 — what exact shape does `createUserMessage` (dsh-llm) produce, so the
 *        plugin can build the same literal without importing the package?
 *   S4 — does a seeded session (fork shape) accept the same append?
 *
 * PART 2 (isolated instance): the fork chain end to end:
 *   S5 — `session/fork {atSeq:0}` succeeds and returns a server-minted child.
 *   S6 — the child log's exact event sequence (header copy? end-seed? own
 *        header with parentSession?).
 *   S7 — the parent log is byte-identical after the fork (R06 purity).
 *   S8 — the child appears in `session/list` with `blank:true` (so an
 *        ambiguous-failure orphan is invisible in the sidebar).
 *   S9 — `session/selectModel` accepts a provider/model for the child.
 *
 * Usage: node scripts/spike-fork.mjs [--port 19545] [--skip-boot]
 * @module scripts/spike-fork
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as zlib from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const PORT = portFlag === -1 ? 19545 : Number(argv[portFlag + 1])
const SKIP_BOOT = argv.includes('--skip-boot')
const STORE = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai')

const log = (...args) => console.log(...args)

/** Decompress every zstd frame of one log (one-shot decompress stops at frame 1). */
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
    } catch { /* accidental magic */ }
  }
  return parts.join('')
}

// ══════════════════════════════════════════════════════════════════════════
// PART 1 — in-process Session/append/deriveMessages
// ══════════════════════════════════════════════════════════════════════════
{
  const { Session } = await import(pathToFileURL(join(STORE, 'dsh-session', 'lib', 'index.js')).href)
  let createUserMessage
  try {
    ;({ createUserMessage } = await import(pathToFileURL(join(STORE, 'dsh-llm', 'lib', 'index.js')).href))
  } catch (error) {
    log('S3: dsh-llm import failed:', String(error).slice(0, 120))
  }

  // S3 — the canonical shape a plugin literal must match.
  if (createUserMessage !== undefined) {
    const canonical = createUserMessage({ content: 'probe text', source: { kind: 'aux-chat-mirror' } })
    log('S3: createUserMessage output =', JSON.stringify(canonical, null, 1).slice(0, 600))
  }

  const baseHeader = (id, extra = {}) => ({ version: 4, id, createdAt: Date.now(), cwd: tmpdir(), isSeeded: false, ...extra })

  // S1/S2 — plain session, custom-source user/message append + derivation.
  const plain = Session.create('session-spike-plain-0001', undefined, baseHeader('session-spike-plain-0001'), 0, [])
  let s1 = 'no-throw'
  try {
    plain.append('user/message', {
      id: 'msg-spike-0001',
      role: 'user',
      content: [{ type: 'text', text: 'MIRROR-PAYLOAD-PLAIN' }],
      source: { kind: 'aux-chat-mirror', form: 'reference' },
    }, { surfaceOp: 'append' })
  } catch (error) {
    s1 = `THREW: ${String(error).slice(0, 200)}`
  }
  log('S1: append(custom source.kind) on plain session →', s1)
  if (s1 === 'no-throw') {
    const derived = plain.deriveMessages()
    const carried = derived.some((message) => JSON.stringify(message).includes('MIRROR-PAYLOAD-PLAIN'))
    log(`S2: deriveMessages carries the injection → ${carried} (total ${derived.length} messages)`)
    log('S2: derived[0] =', JSON.stringify(derived[0]).slice(0, 300))
  }

  // S4 — seeded (fork-shaped) session accepts the same append.
  const seededHeader = baseHeader('session-spike-seeded-0001', { isSeeded: true, parentSession: 'session-spike-parent' })
  const seed = [
    { type: 'session', seq: 0, time: Date.now(), data: { version: 4, id: 'session-spike-parent', createdAt: Date.now(), isSeeded: false } },
    { type: 'session/end-seed', seq: 1, time: Date.now(), data: { inherited: true } },
  ]
  try {
    const seeded = Session.create('session-spike-seeded-0001', seed, seededHeader, 1, [])
    seeded.append('user/message', {
      id: 'msg-spike-0002',
      role: 'user',
      content: [{ type: 'text', text: 'MIRROR-PAYLOAD-SEEDED' }],
      source: { kind: 'aux-chat-mirror', form: 'reference' },
    }, { surfaceOp: 'append' })
    const derived = seeded.deriveMessages()
    const carried = derived.some((message) => JSON.stringify(message).includes('MIRROR-PAYLOAD-SEEDED'))
    log(`S4: seeded session append+derive → carried=${carried} (total ${derived.length})`)
    log('S4: seed events derive to messages? →', derived.filter((m) => JSON.stringify(m).includes('session-spike-parent')).length, '(expect 0)')
  } catch (error) {
    log('S4: seeded session THREW:', String(error).slice(0, 300))
  }
}

if (SKIP_BOOT) process.exit(0)

// ══════════════════════════════════════════════════════════════════════════
// PART 2 — isolated instance: the fork chain
// ══════════════════════════════════════════════════════════════════════════
const DSH_HOME_SRC = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
const DSH_CLI = join(DSH_HOME_SRC, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(DSH_CLI)) {
  console.error(`spike: no dsh CLI at ${DSH_CLI}`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'aux-spike-'))
const home = join(scratch, 'home')
const profileDir = join(home, 'profiles', 'e2e')
mkdirSync(profileDir, { recursive: true })
const sourceManifest = join(DSH_HOME_SRC, 'profiles', 'desktop', 'package.json')
const manifest = JSON.parse(readFileSync(sourceManifest, 'utf8'))
const manifestBase = existsSync(join(DSH_HOME_SRC, 'profiles', 'desktop', 'pnpm-workspace.yaml'))
  ? readFileSync(join(DSH_HOME_SRC, 'profiles', 'desktop', 'pnpm-workspace.yaml'), 'utf8')
  : 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const bundles = manifest.dsh.profile.bundles.filter((bundle) => bundle !== pkg.name)
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify({ name: 'dsh-profile-spike', private: true, dependencies: { [pkg.name]: `link:${root}` }, dsh: { profile: { bundles: [...bundles, pkg.name] } } }, null, 2)}\n`,
)
writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), manifestBase)
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
symlinkSync(join(DSH_HOME_SRC, 'profiles', 'node_modules'), join(home, 'profiles', 'node_modules'), 'dir')
const scopeDir = join(profileDir, 'node_modules', ...pkg.name.split('/').slice(0, -1))
mkdirSync(scopeDir, { recursive: true })
symlinkSync(root, join(scopeDir, pkg.name.split('/').at(-1)), 'dir')

let bootLog = ''
const child = spawn(process.execPath, [DSH_CLI, '--profile', 'e2e', '--port', String(PORT), '--no-open'], {
  cwd: profileDir,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => { bootLog += String(chunk) })
child.stderr.on('data', (chunk) => { bootLog += String(chunk) })

async function waitForUrl(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = bootLog.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
    if (match !== null) return match[0]
    if (/startup failed/.test(bootLog)) return undefined
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return undefined
}

async function rpc(endpoint, args, cookie) {
  const response = await fetch(`http://127.0.0.1:${String(PORT)}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify({ type: 'client-request', rpcId: `spike-${endpoint.replace(/\W/g, '-')}-${String(Date.now())}`, method: endpoint, payload: { args } }),
  })
  return response.json()
}

try {
  const url = await waitForUrl()
  if (url === undefined) {
    console.error('spike: instance did not come up\n--- boot log ---\n' + bootLog)
    process.exit(1)
  }
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0]
  log('S5: instance booted, auth cookie obtained')

  const ws = join(scratch, 'ws')
  mkdirSync(ws, { recursive: true })
  const mainId = 'session-spike-main-0001'
  const created = await rpc('session/create', { request: { cwd: ws, sessionId: mainId } }, cookie)
  log('S5: main create ok =', created?.result?.ok)

  // Give the parent a real user message so the log has >1 frame.
  await rpc('session/prompt', { request: { requestId: 'spike-req-1', sessionId: mainId, mode: 'queue', content: [{ type: 'text', text: 'parent history fact: the magic word is ZEBRA-42' }] } }, cookie)
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const findLog = (id) => {
    for (const project of readdirSync(join(home, 'sessions'))) {
      const candidate = join(home, 'sessions', project, id, 'session.v4.jsonl.zstd')
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }
  const parentLog = findLog(mainId)
  const parentHashBefore = parentLog === undefined ? 'MISSING' : createHash('sha256').update(readFileSync(parentLog)).digest('hex')

  // S5 — fork at seq 0.
  const forked = await rpc('session/fork', { request: { sessionId: mainId, atSeq: 0 } }, cookie)
  const forkResult = forked?.result?.value
  const childId = forkResult?.sessionId
  log('S5: fork ok =', forked?.result?.ok, ' childId =', childId, forked?.result?.ok ? '' : JSON.stringify(forked?.result).slice(0, 300))

  if (typeof childId === 'string' && childId !== '') {
    // S6 — the child log's exact event sequence.
    const childLog = findLog(childId)
    if (childLog === undefined) {
      log('S6: child log NOT materialized on disk (deferred materialization?)')
    } else {
      const text = readLogText(childLog)
      const events = text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return { type: 'UNPARSEABLE' } } })
      log(`S6: child log events (${events.length}):`)
      for (const event of events.slice(0, 8)) {
        log('   ', event.type, event.type === 'session' ? `id=${String(event.id ?? event.data?.id)} parentSession=${String(event.parentSession ?? event.data?.parentSession)} isSeeded=${String(event.isSeeded ?? event.data?.isSeeded)}` : '')
      }
    }
    // S7 — the parent log is untouched.
    const parentHashAfter = parentLog === undefined ? 'MISSING' : createHash('sha256').update(readFileSync(parentLog)).digest('hex')
    log(`S7: parent log unchanged → ${parentHashBefore === parentHashAfter}`)
    // S8 — the child in session/list: present? blank?
    const listed = await rpc('session/list', { _request: {} }, cookie)
    if (listed?.result?.ok !== true) log('S8: list RPC error =', JSON.stringify(listed?.result).slice(0, 200))
    const items = listed?.result?.value?.items ?? []
    const row = items.find((item) => item.sessionId === childId)
    log('S8: child in session/list →', row === undefined ? 'ABSENT' : `present blank=${String(row.blank)} parentSessionId=${String(row.parentSessionId)} running=${String(row.running)}`)
    log('S8: full list rows =', items.map((item) => `${String(item.sessionId).slice(-8)}(blank=${String(item.blank)},parent=${String(item.parentSessionId ?? '-')})`).join(' '))
    // S9 — selectModel on the child.
    const selected = await rpc('session/selectModel', { request: { sessionId: childId, provider: 'deepseek-official', model: 'deepseek-flash' } }, cookie)
    log('S9: selectModel ok =', selected?.result?.ok, selected?.result?.ok ? JSON.stringify(selected?.result?.value).slice(0, 160) : JSON.stringify(selected?.result).slice(0, 240))
  }
} finally {
  child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  try { child.kill('SIGKILL') } catch { /* already gone */ }
  rmSync(scratch, { recursive: true, force: true })
}
