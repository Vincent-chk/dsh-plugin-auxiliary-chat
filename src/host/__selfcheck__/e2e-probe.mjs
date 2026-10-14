#!/usr/bin/env node
/**
 * Live probe against a REAL, ISOLATED DSH instance.
 *
 * It answers the two questions the offline self-check cannot:
 *
 *   Q1 — does the client-visible session payload contain the fork-INHERITED
 *        prefix (`seq < inheritedEventCount`)? That payload is exactly what
 *        `remote.session.follow`/`remote.session.page` hand the Chat view, so
 *        whatever is in it is what the transcript can draw.
 *   Q2 — does the mirror text reach the model through the auxiliary session's
 *        own system prompt (a `system/message` event), and is there no
 *        plugin-invented message event in the auxiliary log?
 *
 * The operator's own instance is never touched: throwaway `DSH_HOME` under the
 * system temp directory, private port, scratch tree removed on exit unless
 * `--keep` is passed.
 *
 *   node src/host/__selfcheck__/e2e-probe.mjs [--port 19540] [--keep] [--prompt]
 *
 * `--prompt` also sends one message to the auxiliary session, which is how the
 * system prompt gets committed to the log; it needs a working model credential
 * and is therefore opt-in.
 *
 * @module host/__selfcheck__/e2e-probe
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const PORT = portFlag === -1 ? 19540 : Number(argv[portFlag + 1])
const KEEP = argv.includes('--keep')
const PROMPT_AUX = argv.includes('--prompt')
// Opt IN to the sidebar hiding (archive + pre-step short-circuit) through the
// profile's user patch layer, so the A/B cost measurement is reproducible.
// Without the flag the plugin runs its DEFAULT config (hideFromSidebar: false).
const HIDE = argv.includes('--hide')
const DSH_HOME_SRC = process.env['DSH_HOME'] ?? join(process.env['HOME'] ?? '', '.dsh')
const DSH_CLI = join(DSH_HOME_SRC, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

if (!existsSync(DSH_CLI)) {
  console.error(`probe: no dsh CLI at ${DSH_CLI}`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'aux-probe-'))
const home = join(scratch, 'home')
const profileDir = join(home, 'profiles', 'probe')
mkdirSync(profileDir, { recursive: true })
const manifest = JSON.parse(readFileSync(join(DSH_HOME_SRC, 'profiles', 'desktop', 'package.json'), 'utf8'))
const bundles = manifest.dsh.profile.bundles.filter((bundle) => bundle !== pkg.name)
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify({ name: 'dsh-profile-probe', private: true, dependencies: { [pkg.name]: `link:${root}` }, dsh: { profile: { bundles: [...bundles, pkg.name] } } }, null, 2)}\n`,
)
writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
writeFileSync(
  join(profileDir, 'cordis.patch.yml'),
  HIDE ? `- id: aux-chat\n  config:\n    hideFromSidebar: true\n` : '[]\n',
)
symlinkSync(join(DSH_HOME_SRC, 'profiles', 'node_modules'), join(home, 'profiles', 'node_modules'), 'dir')
const scopeDir = join(profileDir, 'node_modules', ...pkg.name.split('/').slice(0, -1))
mkdirSync(scopeDir, { recursive: true })
symlinkSync(root, join(scopeDir, pkg.name.split('/').at(-1)), 'dir')

console.log(`probe: scratch=${scratch}`)
console.log(`probe: port=${String(PORT)} promptAux=${String(PROMPT_AUX)} hideFromSidebar=${HIDE ? 'true (opt-in)' : 'false (default)'}`)

const child = spawn(process.execPath, [DSH_CLI, '--profile', 'probe', '--port', String(PORT), '--no-open'], {
  cwd: profileDir,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (chunk) => { log += String(chunk) })
child.stderr.on('data', (chunk) => { log += String(chunk) })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForUrl(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
    if (match !== null) return match[0]
    if (/startup failed/.test(log)) return undefined
    await sleep(500)
  }
  return undefined
}

let cookie = ''
async function rpc(endpoint, args) {
  const response = await fetch(`http://127.0.0.1:${String(PORT)}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }) },
    body: JSON.stringify({ type: 'client-request', rpcId: `probe-${randomUUID()}`, method: endpoint, payload: { args } }),
  })
  return response.json()
}

/** Unwrap the gateway envelope; returns `{ok, value, error}`. */
const unwrap = (envelope) => envelope?.result ?? envelope

/**
 * The session's current last committed seq.
 *
 * `throughSeq: -1` means "no events" in the page protocol (`end = min(-1+1, …)`
 * in `paginate`, dsh-api-session-controller/lib/index.js:1350-1380), so the
 * cursor has to come from the projection baseline the client also reads.
 */
async function cursorOf(sessionId) {
  const baseline = unwrap(await rpc('session/projections', { request: { sessionId } }))
  return typeof baseline?.value?.asOfSeq === 'number' ? baseline.value.asOfSeq : -1
}

/** One client-visible history page: exactly what the Chat view can draw. */
async function readPage(sessionId, maxMessages = 200) {
  const cursor = await cursorOf(sessionId)
  const envelope = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: cursor, maxMessages } })
  const result = unwrap(envelope)
  if (result?.ok !== true) {
    if (process.env['PROBE_DEBUG'] === '1') console.log(`probe: session/page FAILED ${JSON.stringify(result).slice(0, 400)}`)
    return { error: result?.error ?? envelope, records: [] }
  }
  return { records: result.value.records.map((record) => record.event), error: undefined }
}

/** Poll a session's page until `predicate` holds. */
async function waitFor(sessionId, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = { records: [] }
  while (Date.now() < deadline) {
    last = await readPage(sessionId)
    if (predicate(last.records)) return last
    await sleep(1000)
  }
  return last
}

const preview = (event) => {
  const data = event?.data ?? {}
  const text =
    typeof data === 'object' && data !== null
      ? event.type === 'user/message'
        ? data.content?.map((block) => block.text ?? `<${String(block.type)}>`).join(' ').slice(0, 70)
        : event.type === 'system/message'
          ? data.message?.content?.map((block) => block.text ?? '').join(' ').slice(0, 70)
          : event.type === 'assistant/message'
            ? data.message?.content?.map((block) => block.text ?? '').join(' ').slice(0, 70)
            : ''
      : ''
  return String(text ?? '').replace(/\s+/g, ' ')
}

const dump = (records, label, inheritedCut) => {
  console.log(`\n--- ${label} (${String(records.length)} records) ---`)
  for (const event of records) {
    const inherited = inheritedCut !== undefined && event.seq <= inheritedCut
    console.log(
      `  seq=${String(event.seq).padStart(4)} ${inherited ? 'INHERITED' : 'own      '} ${String(event.type).padEnd(18)} ${preview(event)}`,
    )
  }
}

try {
  const url = await waitForUrl()
  if (url === undefined) {
    console.error('probe: instance did not come up\n--- boot log tail ---\n' + log.slice(-4000))
    process.exit(1)
  }
  const auth = await fetch(url, { redirect: 'manual' })
  cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0]
  console.log(`probe: booted, cookie=${cookie === '' ? 'MISSING' : 'ok'}`)

  const MAIN = 'session-probe-main-0001'
  const created = unwrap(await rpc('session/create', { request: { cwd: join(scratch, 'ws'), sessionId: MAIN } }))
  console.log(`probe: session/create -> ${JSON.stringify(created).slice(0, 160)}`)

  // Give the main session one real turn so the fork has something to inherit.
  const promptResult = await rpc('session/prompt', {
    request: { requestId: randomUUID(), sessionId: MAIN, mode: 'queue', content: [{ type: 'text', text: 'Reply with the single word: ping' }] },
  })
  console.log(`probe: main session/prompt -> ${JSON.stringify(unwrap(promptResult)).slice(0, 200)}`)
  const mainPage = await waitFor(MAIN, (records) => records.some((event) => event.type === 'turn/end'), 90_000)
  dump(mainPage.records, 'MAIN session page (what the client can draw)', undefined)
  if (process.env['PROBE_DEBUG'] === '1') {
    const listing = unwrap(await rpc('session/list', { _request: {} }))
    console.log(`probe: session/list -> ${JSON.stringify(listing).slice(0, 600)}`)
    console.log('--- boot log tail ---\n' + log.slice(-3000))
  }

  // Create the auxiliary session mirroring it.
  const auxId = 'session-probe-aux-0001'
  const exec = unwrap(
    await rpc('commands/execute', {
      agentId: MAIN,
      line: `/aux-chat ${JSON.stringify({ sessionId: auxId, mirrorOf: MAIN })}`,
      submittedAttachments: [],
    }),
  )
  const commandResult = exec?.value?.result ?? exec
  console.log(`\nprobe: /aux-chat -> ${String(commandResult?.kind)} ${String(commandResult?.text).slice(0, 400)}`)

  const auxPage = await readPage(auxId)
  const marker = auxPage.records.find((event) => event.type === 'session/end-seed' && event.data?.inherited === true)
  const inheritedCut = marker?.seq
  console.log(`probe: inherited marker at seq ${String(inheritedCut)} (inheritedEventCount=${marker === undefined ? 'n/a' : String(inheritedCut + 1)})`)
  dump(auxPage.records, 'AUX session page RIGHT AFTER CREATE (what the client can draw)', inheritedCut)

  const inherited = inheritedCut === undefined ? [] : auxPage.records.filter((event) => event.seq <= inheritedCut)
  const drawableAll = auxPage.records.filter((event) => ['user/message', 'assistant/message'].includes(event.type))
  console.log(
    `\nVERDICT Q1a: client-visible records inherited from the main session = ${String(inherited.length)} (expected 0: the session is not seeded)`,
  )
  console.log(`VERDICT Q1b: drawable transcript rows in the whole auxiliary page = ${String(drawableAll.length)} (expected 0: a clean chat page)`)
  console.log(`VERDICT Q1c: an inherited cut marker exists = ${String(marker !== undefined)} (expected false)`)
  console.log(`VERDICT Q1d: whole auxiliary page = ${JSON.stringify(auxPage.records.map((event) => `${String(event.seq)}:${event.type}`))}`)

  // Durable evidence of the archive: the workspace registry file the sidebar reads.
  const readArchive = () => {
    try {
      return JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8')).global.archivedSessionIds ?? []
    } catch {
      return []
    }
  }
  if (commandResult?.kind === 'success') {
    const payload = JSON.parse(commandResult.text)
    const archived = readArchive()
    console.log(`VERDICT Q3a: aux-chat payload hidden = ${String(payload.hidden)}`)
    console.log(`VERDICT Q3b: archive set on disk = ${JSON.stringify(archived)}`)
    console.log(`VERDICT Q3c: the auxiliary session is durably archived = ${String(archived.includes(auxId))}`)
  }

  // Control: a session this plugin does NOT own must stay blocked while archived.
  const PLAIN = 'session-probe-plain-0001'
  unwrap(await rpc('session/create', { request: { cwd: join(scratch, 'ws'), sessionId: PLAIN } }))
  const archivedPlain = unwrap(await rpc('workspace/archiveSession', { request: { sessionId: PLAIN } }))
  console.log(`probe: workspace/archiveSession(control) -> ${JSON.stringify(archivedPlain).slice(0, 160)}`)
  await rpc('session/prompt', {
    request: { requestId: randomUUID(), sessionId: PLAIN, mode: 'queue', content: [{ type: 'text', text: 'control prompt' }] },
  })
  const plainPage = await waitFor(PLAIN, (records) => records.some((event) => event.type === 'turn/end'), 60_000)
  const plainEnd = plainPage.records.findLast((event) => event.type === 'turn/end')
  const plainSteps = plainPage.records.filter((event) => event.type === 'step/start').length
  console.log(`VERDICT Q4 (control): archived NON-owned session turn/end reason = ${JSON.stringify(plainEnd?.data?.reason)}; step/start events = ${String(plainSteps)}`)

  if (PROMPT_AUX) {
    const auxPrompt = await rpc('session/prompt', {
      request: { requestId: randomUUID(), sessionId: auxId, mode: 'queue', content: [{ type: 'text', text: 'Reply with the single word: pong' }] },
    })
    console.log(`\nprobe: aux session/prompt -> ${JSON.stringify(unwrap(auxPrompt)).slice(0, 200)}`)
    const after = await waitFor(auxId, (records) => records.some((event) => event.type === 'turn/end' && event.seq > (inheritedCut ?? 0)), 90_000)
    dump(after.records.filter((event) => event.seq > (inheritedCut ?? -1)), 'AUX session page — OWN events only (after one prompt)', inheritedCut)
    const ownEnd = after.records.findLast((event) => event.type === 'turn/end' && event.seq > (inheritedCut ?? 0))
    const ownSteps = after.records.filter((event) => event.type === 'step/start' && event.seq > (inheritedCut ?? 0)).length
    console.log(`VERDICT Q3d (archived OWN session): turn/end reason = ${JSON.stringify(ownEnd?.data?.reason)}; step/start events = ${String(ownSteps)}`)
    console.log(`VERDICT Q3e: the archive gate was bypassed for the owned session = ${String(ownSteps > 0)}`)
    const ownSystem = after.records.find((event) => event.type === 'system/message' && event.seq > (inheritedCut ?? 0))
    const ownUser = after.records.filter((event) => event.type === 'user/message' && event.seq > (inheritedCut ?? 0))
    const systemText = ownSystem?.data?.message?.content?.map((block) => block.text ?? '').join('') ?? ''
    console.log(`\nVERDICT Q2a: own system/message present = ${String(ownSystem !== undefined)}`)
    console.log(`VERDICT Q2b: own system/message carries the mirror section = ${String(systemText.includes('Auxiliary session context mirror'))}`)
    const fromUser = ownUser.filter((event) => event.data?.source?.kind === 'user')
    const runtimeContext = ownUser.filter((event) => event.data?.source?.kind !== 'user')
    console.log(`VERDICT Q2c: own user/message events = ${String(ownUser.length)} (typed by the user: ${String(fromUser.length)}; injected: ${String(runtimeContext.length)})`)
    console.log(`VERDICT Q2c2: injected kinds = ${JSON.stringify([...new Set(runtimeContext.map((event) => event.data?.source?.kind))])} (the loop's runtime context is MISSING when the short-circuit is on)`)
    console.log(`VERDICT Q2d: any plugin-invented source kinds = ${JSON.stringify([...new Set(ownUser.map((event) => event.data?.source?.kind))])}`)
    const mirrorAt = systemText.indexOf('Auxiliary session context mirror')
    const identityAt = systemText.indexOf('You are an AI agent powered by DeepSeek Harness')
    const firstToolAt = systemText.indexOf('## ')
    console.log(`VERDICT Q2e: rendered prompt chars=${String(systemText.length)}; identity@${String(identityAt)}; mirror@${String(mirrorAt)}; firstBlockHeading@${String(firstToolAt)}`)
    console.log(`VERDICT Q2e sample: …${systemText.slice(Math.max(0, mirrorAt - 160), mirrorAt + 200).replace(/\s+/g, ' ')}…`)
    const otherInvented = after.records.filter((event) => event.seq > (inheritedCut ?? 0) && ['user/message', 'assistant/message', 'developer/message'].includes(event.type) && event.data?.source?.kind !== 'user' && event.data?.source?.kind !== 'agent-instructions')
    console.log(`VERDICT Q2f: non-user surface messages in the auxiliary log = ${String(otherInvented.length)}`)
    const summaryHeader = systemText.includes('Summary of the main session conversation (a SUMMARY, not the verbatim history)')
    const summaryCredit = systemText.includes('read the workspace files yourself')
    const mainPromptSeen = systemText.includes('Reply with the single word: ping')
    console.log(`VERDICT Q2g: summary block present in the delivered prompt = ${String(summaryHeader)}; self-describing caveat = ${String(summaryCredit)}; main-session prompt text carried in the summary = ${String(mainPromptSeen)}`)
    const digestLines = systemText.split('\n').filter((line) => line.startsWith('- [seq '))
    console.log(`VERDICT Q2h: summary entries in the delivered prompt = ${String(digestLines.length)}; first = ${JSON.stringify(digestLines[0] ?? null)}`)
  }

  const ended = unwrap(await rpc('commands/execute', { agentId: auxId, line: `/aux-end ${JSON.stringify({ sessionId: auxId })}`, submittedAttachments: [] }))
  console.log(`\nprobe: /aux-end -> ${JSON.stringify(ended?.value?.result ?? ended).slice(0, 200)}`)
  console.log(`probe: marker removed = ${String(!existsSync(join(home, 'aux-chat', 'sessions', `${auxId}.json`)))}`)
} finally {
  child.kill('SIGTERM')
  await sleep(1500)
  try { child.kill('SIGKILL') } catch { /* already gone */ }
  if (!KEEP) rmSync(scratch, { recursive: true, force: true })
  else console.log(`probe: kept ${scratch}`)
}
