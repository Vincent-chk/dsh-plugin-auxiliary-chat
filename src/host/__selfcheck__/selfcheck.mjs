#!/usr/bin/env node
/**
 * ⚠️ STALE (2026-10-14): this harness targets the retired single-command
 * `/aux-chat` API and no longer runs against the current two-phase
 * create + `/aux-init` design. It is kept for reference only. The live
 * offline gates are `scripts/build|smoke|verify|integration.mjs`,
 * `npm run race-check` (PRD v2.0 close/identity chain), and
 * `scripts/e2e-isolated.mjs` (real-stack contract probes).
 */
/**
 * Offline self-check for the host half.
 *
 * It runs against the SOURCES (Node's type stripping executes the `.ts` files
 * directly) with a fake Cordis context, and against the BUILT artifact
 * (`lib/index.js`) for the command surface. Nothing here needs a running DSH, a
 * profile, or network access.
 *
 * `DSH_HOME` is redirected into a scratch directory under `node_modules/.cache`
 * BEFORE the first import, so the run exercises the real create/dispose file
 * paths without ever touching `~/.dsh`.
 *
 *   node src/host/__selfcheck__/selfcheck.mjs
 *
 * @module host/__selfcheck__/selfcheck
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const scratch = join(repo, 'node_modules', '.cache', 'aux-chat-selfcheck')
// Captured before DSH_HOME is redirected, so scenario 5 can find a real profile.
const realHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profilesDir = process.env.DSH_PROFILES_DIR ?? join(realHome, 'profiles')
// The host half resolves Host packages from anchors that include
// `$DSH_PROFILES_DIR`; setting it here models a real deployment while DSH_HOME
// is redirected, so `Config` (resolved at module scope) is reachable.
process.env.DSH_PROFILES_DIR ??= profilesDir

rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
process.env.DSH_HOME = scratch

const { createAuxSession } = await import('../create.ts')
const { disposeAuxSession, sweepAuxSessions } = await import('../dispose.ts')
const { writeMarker } = await import('../registry.ts')
const { AuxChatError } = await import('../errors.ts')
const { apply } = await import('../apply.ts')
const { AuxChatRegistry } = await import('../registry.ts')

// ── assertion harness ────────────────────────────────────────────────────────
let failures = 0
const check = (condition, label, detail) => {
  if (condition) {
    console.log(`ok   ${label}`)
    return true
  }
  failures += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}
const row = (label, value) => console.log(`     ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)

// ── fake world ───────────────────────────────────────────────────────────────
const MAIN_ID = 'session-main-0001'
const AUX_ID = 'session-aux-0001'
const PROJECT = '--selfcheck-project--'

/** A minimal but structurally faithful main-session log, in surface order. */
const mainEvents = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 2, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '请看一下 README' }], source: { kind: 'user' } }, surfaceOp: 'append' },
  { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
  {
    type: 'assistant/message',
    seq: 3,
    time: 4,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'text', text: 'README 已读过' }, { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"README.md","limit":200}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    },
    surfaceOp: 'append',
  },
  { type: 'tool/result', seq: 4, time: 5, data: { message: { id: 'm3', role: 'tool', content: [{ type: 'text', text: '# project readme\n安装步骤...' }], source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1' } }, surfaceOp: 'append' },
  { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'session/title', seq: 6, time: 7, data: { title: '主会话标题', source: { kind: 'user' } } },
]
/** Surface nodes the fake session reports: user(1), assistant(3), tool-result(4). */
const MAIN_SURFACE = [1, 3, 4]
const MAIN_MESSAGE_SEQS = [1, 3, 4]

/** `Session.deriveEventMessage` reduced to the shipped switch. */
const deriveFake = (event) => {
  if (event?.type === 'user/message') return event.data
  if (event?.type === 'assistant/message' || event?.type === 'tool/result') return event.data.message
  return null
}

/** The helper values the lazy loader would import; a fake keeps this offline. */
const fakeDsh = {
  loaded: ['fake'],
  renderPrompt: () => 'SYSTEM-PROMPT-TEXT',
  renderContextSnapshot: () => 'CONTEXT-SNAPSHOT-TEXT',
}

const logDirOf = (id) => join(scratch, 'sessions', PROJECT, id)
const projCacheOf = (id) => join(scratch, 'storages', 'session_projcache', 'sessions', `${id}.json`)
const markerOf = (id) => join(scratch, 'aux-chat', 'sessions', `${id}.json`)

/** Build the artifacts a created session owns on disk. */
const materialize = (id) => {
  mkdirSync(logDirOf(id), { recursive: true })
  writeFileSync(join(logDirOf(id), 'session.jsonl.zst'), 'log\n')
  mkdirSync(dirname(projCacheOf(id)), { recursive: true })
  writeFileSync(projCacheOf(id), '{}\n')
}

/** One fake Cordis context; `live` is the agent registry it answers from. */
function makeCtx(live, services = {}) {
  const calls = {
    created: [],
    registered: [],
    unregistered: [],
    disposeSawLog: undefined,
    sections: [],
    sectionDisposed: [],
    agentCtx: undefined,
    listeners: [],
    archived: [],
  }
  const ctx = {
    baseUrl: undefined,
    logger: { info: () => {}, warn: () => {} },
    effect: (execute) => execute(),
    commands: {
      register: (definition) => {
        calls.registered.push(definition)
        return () => calls.unregistered.push(definition.name)
      },
    },
    get: (name) => services[name],
    on: (name, listener, options) => {
      calls.listeners.push({ name, listener, options })
      return () => calls.listeners.pop()
    },
    agents: {
      get: (id) => live.get(id),
      list: () => [...live.values()],
      create: async (createOptions) => {
        calls.created.push(createOptions)
        materialize(createOptions.sessionId)
        const agent = { id: createOptions.sessionId, options: createOptions.agentOptions, session: { id: createOptions.sessionId, header: {} } }
        live.set(agent.id, agent)
        const sectionCalls = []
        const agentCtx = {
          systemPrompt: {
            section: (section) => {
              sectionCalls.push(section)
              calls.sections.push(section)
              return () => calls.sectionDisposed.push(section.name)
            },
          },
        }
        calls.agentCtx = agentCtx
        createOptions.setup?.(agentCtx, agent)
        return {
          agent,
          dispose: async () => {
            // Proves the frozen order: teardown must still see the log present.
            calls.disposeSawLog = existsSync(logDirOf(createOptions.sessionId))
            live.delete(agent.id)
          },
        }
      },
    },
  }
  return { ctx, calls }
}

/** The dependency bundle create/dispose/sweep take. */
const makeDeps = (ctx, trace, options = {}) => ({
  ctx,
  registry: new AuxChatRegistry(),
  home: scratch,
  loadDsh: async () => fakeDsh,
  now: () => 1700000000000,
  owned: options.owned ?? new Set(),
  hideFromSidebar: options.hideFromSidebar !== false,
  mirrorHistory: options.mirrorHistory !== false,
  trace,
})

const expectAuxError = async (label, code, run) => {
  try {
    await run()
  } catch (error) {
    const ok = error instanceof AuxChatError && error.code === code
    check(ok, label, `${error?.code ?? error?.name}: ${error?.message}`)
    return ok ? error : undefined
  }
  check(false, label, 'no error thrown')
  return undefined
}

const outcome = async (handler, invocation) => {
  try {
    return await handler(invocation)
  } catch (error) {
    return { kind: 'error', text: `${error?.name}: ${error?.message}` }
  }
}

const live = new Map()
const mainAgent = {
  id: MAIN_ID,
  options: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  session: {
    id: MAIN_ID,
    header: { cwd: '/tmp/selfcheck-workspace' },
    surface: { nodes: MAIN_SURFACE },
    snapshotEvents: () => mainEvents,
    deriveEventMessage: deriveFake,
    append: () => {},
  },
}
live.set(MAIN_ID, mainAgent)

const captured = {}
const trace = []
const archiveCalls = []
const { ctx, calls } = makeCtx(live, {
  sessionPersistence: { resolveCurrentLog: async (id) => join(logDirOf(id), 'session.jsonl.zst') },
  workspaceRegistry: {
    archiveSession: async (id) => {
      archiveCalls.push(id)
      trace.push(`archive:${id}`)
    },
    archivedSessionIds: [],
  },
  permissionPresets: { names: ['standard', 'read-only'], current: () => 'standard', set: (_session, name) => trace.push(`preset:${name}`) },
  sessionProjections: {
    stateOf: (_session, key) => (key === 'todos' ? [{ content: 'do the thing', status: 'in_progress' }] : { current: { goal: { objective: 'ship it', phase: 'active' }, roundsStarted: 2 } }),
  },
  sessionTitle: { get: () => ({ title: '主会话标题' }), rename: (_session, title) => trace.push(`title:${title}`) },
  systemPrompt: {
    assemble: async (context) => {
      captured.assembleContext = context
      return { sections: [{ name: 'a', text: 'SYS' }], contexts: [], tools: [], variables: {} }
    },
  },
})
const deps = makeDeps(ctx, (event) => trace.push(event))

// ── scenario 1: create → dispose ─────────────────────────────────────────────
console.log('\n# scenario 1 — create then dispose (happy path)')
const created = await createAuxSession(deps, { sessionId: AUX_ID, mirrorOf: MAIN_ID })
row('info', created.info)
row('warnings', created.warnings)
check(created.warnings.length === 0, 'no warnings on the happy path', JSON.stringify(created.warnings))
check(created.info.sessionId === AUX_ID && created.info.mirrorOf === MAIN_ID, 'info carries the requested identity')
check(created.info.cwd === '/tmp/selfcheck-workspace', 'cwd mirrored from the main session header')
check(
  created.info.provider === 'deepseek-account' && created.info.model === 'deepseek-flash' && created.info.reasoningEffort === 'max',
  'model route snapshotted from the main agent',
)
check(created.info.permissionPreset === 'standard', 'permission preset snapshotted from the main session')
check(trace.includes('title:[辅助] 主会话标题'), 'title pinned with TITLE_PREFIX', JSON.stringify(trace.filter((e) => e.startsWith('title:'))))
check(trace.includes('preset:standard'), 'mirrored permission preset applied inside setup')
check(captured.assembleContext?.agent === mainAgent && captured.assembleContext?.scope === mainAgent, 'the system prompt is assembled with the Agent object as its scope key (ScopeKey is an object)')
check(deps.registry.has(AUX_ID), 'session registered')
check(deps.owned.has(AUX_ID), 'the created id is in the ownership set (archive short-circuit authorization)')
check(existsSync(markerOf(AUX_ID)), 'crash marker written')
check(created.hidden === true, 'the create result reports the session as hidden')
check(archiveCalls.length === 1 && archiveCalls[0] === AUX_ID, 'the session was archived exactly once', JSON.stringify(archiveCalls))
row('archive order', trace.filter((event) => event.startsWith('create:') || event.startsWith('archive:')))

const createOptions = calls.created[0]
check(createOptions.meta.origin === undefined && createOptions.meta.parentSession === undefined, 'meta carries neither origin nor parentSession')
check(createOptions.meta.isSeeded === false && createOptions.meta.cwd === '/tmp/selfcheck-workspace', 'meta carries cwd + isSeeded:false only')
check(createOptions.seed === undefined, 'NO seed is passed: the auxiliary session starts empty')
check(createOptions.inheritedEventCount === undefined, 'NO inheritedEventCount is passed')
check(
  Object.keys(createOptions.meta).length === 2,
  'meta has exactly the two keys we intend (no origin, no parentSession, no isSeeded:true)',
  JSON.stringify(createOptions.meta),
)

// The mirror must reach the model through the auxiliary agent's OWN prompt section.
const sections = calls.sections
check(sections.length === 1, 'exactly one system-prompt section was registered', String(sections.length))
const section = sections[0]
row('section', { name: section?.name, order: section?.order, interpolate: section?.interpolate, chars: section?.text?.length })
check(section?.name === 'aux-chat-mirror', 'section name is namespaced')
check(section?.order === 100, 'section order sits in the unused band between persona (0) and plan policy (500)')
check(section?.interpolate === false, 'section opts out of strict {{variable}} interpolation')
check(
  section.text.includes('SYSTEM-PROMPT-TEXT') && section.text.includes('CONTEXT-SNAPSHOT-TEXT'),
  'section carries the main session prompt + dynamic context',
)
check(section.text.includes('ship it') && section.text.includes('do the thing'), 'section carries goal + todo projections')
check(
  section.text.includes('deepseek-account/deepseek-flash') && section.text.includes('/tmp/selfcheck-workspace'),
  'section carries the main route + cwd',
)
check(calls.agentCtx?.systemPrompt !== undefined && calls.sections.length === 1, 'the section was registered through the setup agentCtx, not the root context')

// The conversation travels as a SUMMARY inside that section, never as events.
const planTrace = trace.find((event) => event.startsWith('create:plan'))
row('digest size', planTrace)
check(/digest=3msgs\/\d+chars/.test(planTrace ?? ''), 'the summary covers all three drawable main-session messages', String(planTrace))
check(section.text.includes('Summary of the main session conversation (a SUMMARY, not the verbatim history)'), 'the summary is labelled as a summary, not verbatim history')
check(/read the workspace files yourself/i.test(section.text), 'the summary tells the model to read files for exact content')
check(section.text.includes('user: 请看一下 README'), 'summary carries the main user prompt')
check(section.text.includes('assistant: README 已读过') && section.text.includes('[called read('), 'summary carries the assistant reply and its tool call')
check(section.text.includes('tool-result: # project readme'), 'summary carries the tool result')
check(!section.text.includes('session/end-seed') && !section.text.includes('"surfaceOp"'), 'the section carries prose only — no raw events')

const disposed = await disposeAuxSession(deps, AUX_ID)
row('dispose result', disposed)
check(disposed.logRemoved && disposed.cacheRemoved && disposed.markerRemoved, 'all three artifacts were found and removed')
check(calls.disposeSawLog === true, 'handle.dispose() ran BEFORE the log directory was deleted')
check(!existsSync(logDirOf(AUX_ID)) && !existsSync(projCacheOf(AUX_ID)) && !existsSync(markerOf(AUX_ID)), 'nothing is left on disk')
check(!deps.registry.has(AUX_ID), 'registry entry dropped')
check(!deps.owned.has(AUX_ID), 'the destroyed id left the ownership set')
const order = trace.filter((event) => event.startsWith('dispose:handle') || event.startsWith('artifact:'))
row('teardown order', order)
check(
  JSON.stringify(order) === JSON.stringify(['dispose:handle-start', 'dispose:handle-done', 'artifact:log removed=true', 'artifact:cache removed=true', 'artifact:marker removed=true']),
  'frozen order: dispose → log → projcache → marker',
)
trace.length = 0

// ── scenario 2: the three required error paths ───────────────────────────────
console.log('\n# scenario 2 — error paths')

// 2a. mirrorOf does not exist
const missing = await expectAuxError('mirrorOf missing is rejected', 'aux-chat/mirror-missing', () =>
  createAuxSession(deps, { sessionId: 'session-aux-0002', mirrorOf: 'session-absent-0001' }),
)
row('error text', missing === undefined ? '<none>' : `${missing.code}: ${missing.message}`)
check(calls.created.length === 1, 'nothing was created for the rejected mirrorOf', String(calls.created.length))

// 2b. sessionId already registered
await createAuxSession(deps, { sessionId: 'session-aux-0003', mirrorOf: MAIN_ID })
const duplicate = await expectAuxError('already-registered sessionId is rejected', 'aux-chat/duplicate-session-id', () =>
  createAuxSession(deps, { sessionId: 'session-aux-0003', mirrorOf: MAIN_ID }),
)
row('error text', duplicate === undefined ? '<none>' : `${duplicate.code}: ${duplicate.message}`)
check(calls.created.length === 2, 'the duplicate produced no second factory call', String(calls.created.length))

// 2c. disposing twice
const second = await expectAuxError('a repeated dispose is rejected', 'aux-chat/not-registered', () => disposeAuxSession(deps, AUX_ID))
row('error text', second === undefined ? '<none>' : `${second.code}: ${second.message}`)
check(trace.filter((event) => event.startsWith('artifact:')).length === 0, 'the repeated dispose touched no artifact')

// clean the surviving session from 2b
const cleaned = await disposeAuxSession(deps, 'session-aux-0003')
check(cleaned.logRemoved && cleaned.cacheRemoved && cleaned.markerRemoved, 'scenario 2b session disposed cleanly')
trace.length = 0

// ── scenario 3: boot sweep over a crashed leftover ───────────────────────────
console.log('\n# scenario 3 — boot sweep')
const DEAD_ID = 'session-dead-0001'
materialize(DEAD_ID)
await writeMarker({ sessionId: DEAD_ID, cwd: '/tmp/gone', createdAt: 1 }, scratch)
const swept = await sweepAuxSessions(deps)
row('sweep result', swept)
check(swept.swept.includes(DEAD_ID), 'the dead session was swept')
check(!existsSync(logDirOf(DEAD_ID)) && !existsSync(projCacheOf(DEAD_ID)) && !existsSync(markerOf(DEAD_ID)), 'swept session left nothing behind')
const alive = await createAuxSession(deps, { sessionId: 'session-aux-0004', mirrorOf: MAIN_ID })
check(alive.info.sessionId === 'session-aux-0004', 'a live session can still be created after a sweep')
const sweptAgain = await sweepAuxSessions(deps)
check(!sweptAgain.swept.includes('session-aux-0004'), 'a live session is never swept')
check(existsSync(markerOf('session-aux-0004')), 'its marker survives the second sweep')
await disposeAuxSession(deps, 'session-aux-0004')
trace.length = 0

// ── scenario 4: the built artifact and its command surface ───────────────────
console.log('\n# scenario 4 — built artifact + command surface')
const built = await import(pathToFileURL(join(repo, 'lib', 'index.js')).href)
check(typeof built.apply === 'function', 'lib/index.js exports the plugin face (apply, inject, Config, name)')
row('exports', Object.keys(built).sort())

const live2 = new Map([[MAIN_ID, mainAgent]])
const archived2 = []
const { ctx: ctx2, calls: calls2 } = makeCtx(live2, {
  sessionPersistence: { resolveCurrentLog: async (id) => join(logDirOf(id), 'session.jsonl.zst') },
  workspaceRegistry: { archiveSession: async (id) => { archived2.push(id) }, archivedSessionIds: [] },
})
const deps2 = makeDeps(ctx2, () => {})
built.apply(ctx2)
check(calls2.registered.length === 2, 'apply() registered exactly two commands', String(calls2.registered.length))
row('commands', calls2.registered.map((definition) => `${definition.name} recordInput=${String(definition.recordInput)}`))
check(calls2.registered.every((definition) => definition.recordInput === false), 'both commands set recordInput:false')
check(
  calls2.registered.map((definition) => definition.name).join(',') === 'aux-chat,aux-end',
  'the frozen command names are aux-chat and aux-end',
)

const createHandler = calls2.registered.find((definition) => definition.name === 'aux-chat').handler
const endHandler = calls2.registered.find((definition) => definition.name === 'aux-end').handler

const handlerCreated = await outcome(createHandler, {
  agent: mainAgent,
  rawInput: ` {"sessionId":"session-aux-0005","mirrorOf":"${MAIN_ID}"}`,
})
check(handlerCreated.kind === 'success', 'aux-chat returns success through the command channel', JSON.stringify(handlerCreated))
let payload
try {
  payload = JSON.parse(handlerCreated.text)
} catch {
  payload = undefined
}
check(payload?.ok === true && payload.info.sessionId === 'session-aux-0005', 'the success text is the frozen JSON payload')
check(payload?.hidden === false, 'the success payload reports whether the session was hidden (false under the default config)')
row('aux-chat success text', handlerCreated.text.slice(0, 160))

const handlerMissing = await outcome(createHandler, { agent: mainAgent, rawInput: ' {"sessionId":"session-aux-0006","mirrorOf":"session-absent-0002"}' })
check(handlerMissing.kind === 'error' && handlerMissing.text.startsWith('aux-chat/mirror-missing:'), 'a missing mirrorOf comes back as kind:error with the stable code')
row('aux-chat error text', handlerMissing.text)

const handlerNested = await outcome(createHandler, { agent: { id: 'session-aux-0005', session: {} }, rawInput: ' {"sessionId":"session-aux-0007","mirrorOf":"session-aux-0005"}' })
check(handlerNested.kind === 'error' && handlerNested.text.startsWith('aux-chat/nested-aux:'), 'an auxiliary session cannot create another one')

const handlerBadJson = await outcome(createHandler, { agent: mainAgent, rawInput: ' not-json' })
check(handlerBadJson.kind === 'error' && handlerBadJson.text.startsWith('aux-chat/bad-payload:'), 'a malformed payload is rejected without throwing')

const handlerEnded = await outcome(endHandler, { agent: live2.get('session-aux-0005'), rawInput: ' {"sessionId":"session-aux-0005"}' })
row('aux-end success text', handlerEnded.text)
let endPayload
try {
  endPayload = JSON.parse(handlerEnded.text)
} catch {
  endPayload = undefined
}
check(
  handlerEnded.kind === 'success' && endPayload?.ok === true && endPayload.logRemoved === true && endPayload.cacheRemoved === true && endPayload.markerRemoved === true,
  'aux-end returns the frozen dispose payload',
)
const handlerEndedAgain = await outcome(endHandler, { agent: mainAgent, rawInput: ' {"sessionId":"session-aux-0005"}' })
check(handlerEndedAgain.kind === 'error' && handlerEndedAgain.text.startsWith('aux-chat/not-registered:'), 'a repeated aux-end is a stable error, not a silent second delete')

// ── scenario 5: the real Session feeds the summary + the real loader ────────
console.log('\n# scenario 5 — real @deepseek-ai packages: loader + a REAL Session as the summary source')
const dshSessionEntry = join(profilesDir, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
if (!existsSync(dshSessionEntry)) {
  console.log(`SKIP — no DSH installation at ${dshSessionEntry}`)
} else {
  const { Session, SessionId, SessionLogOffset } = await import(pathToFileURL(dshSessionEntry).href)
  const { makeDshLoader } = await import('../dsh-modules.ts')

  // A profile-shaped baseUrl with NO node_modules of its own: resolution must
  // fall through to the installation root, exactly as it will on a real install.
  const loaderCtx = {
    baseUrl: pathToFileURL(join(profilesDir, 'desktop', 'cordis.yml')).href,
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    agents: {},
    commands: {},
  }
  const realModules = await makeDshLoader(loaderCtx)()
  row('resolved via', realModules.loaded ?? [])
  check(typeof realModules.renderPrompt === 'function', 'the lazy loader resolved the real renderPrompt')
  check(typeof realModules.renderContextSnapshot === 'function', 'the lazy loader resolved the real renderContextSnapshot')
  check(realModules.buildForkSeed === undefined, 'the loader no longer resolves buildForkSeed: the seed path is gone')

  /** A realistic main log the REAL Session can validate. */
  const realEvents = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '把 README 里的安装步骤跑一遍' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'system/message', seq: 2, time: 3, data: { turn: 1, step: 1, message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'system-prompt' } } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '先看 README' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"README.md"}' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, surfaceOp: 'append' },
    { type: 'tool/result', seq: 4, time: 5, data: { message: { id: 't1', role: 'tool', content: [{ type: 'text', text: 'npm i -D esbuild' }], source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1' } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const realSession = Session.create(
    SessionId('session-digest-source-1'),
    realEvents,
    { version: 4, id: 'session-digest-source-1', createdAt: 9, cwd: '/tmp/selfcheck-workspace', isSeeded: false },
    SessionLogOffset(0),
    [],
  )
  row('real surface nodes', [...realSession.surface.nodes])
  check(JSON.stringify([...realSession.surface.nodes]) === JSON.stringify([1, 2, 3, 4]), 'the real Session reports the surface in model-visible order')

  // Drive the plugin's own summary builder with the REAL Session object, so the
  // whole digest path (surface.nodes -> deriveEventMessage -> text) is exercised
  // against published behaviour instead of a stand-in.
  const liveReal = new Map()
  const realMain = { id: 'session-digest-main-1', options: { provider: 'real-provider', model: 'real-model' }, session: realSession }
  liveReal.set(realMain.id, realMain)
  const { ctx: ctxReal, calls: callsReal } = makeCtx(liveReal, {
    sessionPersistence: { resolveCurrentLog: async (id) => join(logDirOf(id), 'session.jsonl.zst') },
    workspaceRegistry: { archiveSession: async () => undefined, archivedSessionIds: [] },
  })
  const depsReal = makeDeps(ctxReal, () => {})
  const createdReal = await createAuxSession(depsReal, { sessionId: 'session-aux-real-1', mirrorOf: realMain.id })
  const realSection = callsReal.sections[0]
  row('real-section digest lines', realSection.text.split('\n').filter((line) => line.startsWith('- [seq')).join(' | '))
  check(realSection.text.includes('user: 把 README 里的安装步骤跑一遍'), 'the summary renders the real user message')
  check(realSection.text.includes('[called read({"path":"README.md"})]'), 'the summary renders the real tool call with its arguments')
  check(realSection.text.includes('tool-result: npm i -D esbuild'), 'the summary renders the real tool result')
  check(!realSection.text.includes('SYS'), 'the summary skips system messages (the main prompt is mirrored separately)')
  check(JSON.parse(JSON.stringify(createdReal.info)).provider === 'real-provider', 'the create path works with a real Session object')
  await disposeAuxSession(depsReal, 'session-aux-real-1')
}

// ── scenario 6: empty main session, summary caps, mirrorHistory:false ───────
console.log('\n# scenario 6 — empty main session, summary caps, mirrorHistory:false')

/** Build one MAIN session fixture from a list of surface nodes. */
const fixtureMain = (id, nodes, derive) => ({
  id,
  options: { provider: 'p', model: 'm' },
  session: {
    id,
    header: { cwd: '/tmp/selfcheck-workspace' },
    surface: { nodes },
    snapshotEvents: () => [],
    deriveEventMessage: derive,
    append: () => {},
  },
})

// 6a. A main session that has no drawable messages at all.
{
  const empty = fixtureMain('session-empty-main-0001', [], () => null)
  const live3 = new Map([[empty.id, empty]])
  const { ctx: ctx3, calls: calls3 } = makeCtx(live3, {
    sessionPersistence: { resolveCurrentLog: async (id) => join(logDirOf(id), 'session.jsonl.zst') },
    workspaceRegistry: { archiveSession: async () => undefined, archivedSessionIds: [] },
  })
  const deps3 = makeDeps(ctx3, () => {})
  const result = await createAuxSession(deps3, { sessionId: 'session-aux-0100', mirrorOf: empty.id })
  const section3 = calls3.sections[0]
  row('empty-main section', section3.text.split('\n').filter((line) => line.startsWith('### ')).join(' | '))
  check(/no messages to summarise/.test(section3.text), 'an empty main session says so instead of inventing a summary')
  check(section3.text.includes('- Goal active in the main session: none'), 'the facts half still reports an empty goal')
  check(calls3.created[0].seed === undefined && calls3.created[0].meta.isSeeded === false, 'an empty main session still creates an unseeded session')
  await disposeAuxSession(deps3, 'session-aux-0100')
}

// 6b. Caps: many long messages must be bounded by entries and by characters.
{
  const manyNodes = []
  const events = []
  for (let index = 0; index < 40; index += 1) {
    const seq = events.length
    events.push({ type: 'user/message', seq, time: seq, data: { id: `u${String(index)}`, role: 'user', content: [{ type: 'text', text: `message-${String(index)} ${'x'.repeat(3000)}` }], source: { kind: 'user' } } })
    manyNodes.push(seq)
  }
  const big = {
    id: 'session-big-main-0001',
    options: { provider: 'p', model: 'm' },
    session: {
      id: 'session-big-main-0001',
      header: { cwd: '/tmp/selfcheck-workspace' },
      surface: { nodes: manyNodes },
      snapshotEvents: () => events,
      deriveEventMessage: (event) => event.data,
      append: () => {},
    },
  }
  const liveBig = new Map([[big.id, big]])
  const { ctx: ctxBig, calls: callsBig } = makeCtx(liveBig, {
    sessionPersistence: { resolveCurrentLog: async (id) => join(logDirOf(id), 'session.jsonl.zst') },
    workspaceRegistry: { archiveSession: async () => undefined, archivedSessionIds: [] },
  })
  const depsBig = makeDeps(ctxBig, () => {})
  await createAuxSession(depsBig, { sessionId: 'session-aux-0101', mirrorOf: big.id })
  const bigSection = callsBig.sections[0]
  const digestLines = bigSection.text.split('\n').filter((line) => line.startsWith('- [seq'))
  row('capped summary', { entries: digestLines.length, chars: digestLines.join('\n').length })
  check(digestLines.length >= 1 && digestLines.length <= 12, 'the summary keeps at most MAX_DIGEST_MESSAGES=12 entries', String(digestLines.length))
  check(digestLines.every((line) => line.length <= 760), 'each entry is truncated (MAX_DIGEST_ENTRY_CHARS=700 plus the label)', String(Math.max(...digestLines.map((line) => line.length))))
  check(digestLines.join('\n').length <= 6000, 'the summary text is capped at MAX_DIGEST_CHARS=6000', String(digestLines.join('\n').length))
  check(!digestLines.join('\n').includes('message-0 '), 'the character cap drops whole OLD entries rather than slicing', digestLines[0].slice(0, 40))
  check(digestLines.at(-1).includes('message-39'), 'the summary always keeps the newest message (tail window)', digestLines.at(-1).slice(0, 40))
  check(!digestLines.join('\n').includes('truncated'), 'no half-written entry survives the cap')
  await disposeAuxSession(depsBig, 'session-aux-0101')
}

// 6c. mirrorHistory:false keeps the facts and drops every content block.
{
  const live4 = new Map([[MAIN_ID, mainAgent]])
  const { ctx: ctx4, calls: calls4 } = makeCtx(live4, {
    sessionPersistence: { resolveCurrentLog: async (id) => join(logDirOf(id), 'session.jsonl.zst') },
    workspaceRegistry: { archiveSession: async () => undefined, archivedSessionIds: [] },
    permissionPresets: { current: () => 'standard', defaultPreset: 'standard' },
    sessionProjections: {
      stateOf: (_session, key) => (key === 'todos' ? [{ content: 'do the thing', status: 'in_progress' }] : { current: { goal: { objective: 'ship it', phase: 'active' }, roundsStarted: 2 } }),
    },
  })
  const deps4 = makeDeps(ctx4, () => {}, { mirrorHistory: false })
  await createAuxSession(deps4, { sessionId: 'session-aux-0102', mirrorOf: MAIN_ID })
  const section4 = calls4.sections[0]
  row('mirrorHistory:false headings', section4.text.split('\n').filter((line) => line.startsWith('### ')).join(' | '))
  check(!section4.text.includes('Summary of the main session conversation'), 'mirrorHistory:false drops the conversation summary')
  check(!section4.text.includes('SYSTEM-PROMPT-TEXT') && !section4.text.includes('CONTEXT-SNAPSHOT-TEXT'), 'mirrorHistory:false drops the main prompt + context blocks')
  check(section4.text.includes('mirrorHistory: false'), 'the section tells the model that content mirroring was turned off')
  check(section4.text.includes('请看一下 README') === false, 'no main-session message text leaks into the section')
  check(section4.text.includes('/tmp/selfcheck-workspace') && section4.text.includes('standard'), 'the facts (cwd, preset) are still delivered')
  check(section4.text.includes('ship it') && section4.text.includes('do the thing'), 'goal + todo facts are still delivered')
  await disposeAuxSession(deps4, 'session-aux-0102')
}

// 6d. A failing summary must not orphan the session: facts survive, warning added.
{
  const broken = fixtureMain('session-broken-main-0001', [1], () => {
    throw new Error('projection exploded')
  })
  const live5 = new Map([[broken.id, broken]])
  const { ctx: ctx5, calls: calls5 } = makeCtx(live5, {
    sessionPersistence: { resolveCurrentLog: async (id) => join(logDirOf(id), 'session.jsonl.zst') },
    workspaceRegistry: { archiveSession: async () => undefined, archivedSessionIds: [] },
  })
  const deps5 = makeDeps(ctx5, () => {})
  const result5 = await createAuxSession(deps5, { sessionId: 'session-aux-0103', mirrorOf: broken.id })
  const section5 = calls5.sections[0]
  row('degraded warnings', result5.warnings)
  check(result5.warnings.some((warning) => warning.startsWith('mirror:')), 'a failing summary is reported as a warning')
  check(section5.text.includes('/tmp/selfcheck-workspace'), 'the facts half is still delivered when the summary fails')
  check(section5.text.includes('- Goal active in the main session'), 'the main-session state block is still delivered when the summary fails')
  check(calls5.created.length === 1, 'the session was created despite the summary failure')
  await disposeAuxSession(deps5, 'session-aux-0103')
}

// ── scenario 7: archiving (sidebar hiding) and its failure degradation ──────
console.log('\n# scenario 7 — archive the session, degrade without blocking creation')

/** One create attempt whose workspace registry is scripted by `script`. */
async function archiveRun(label, script) {
  const live4 = new Map([[MAIN_ID, mainAgent]])
  const archiveLog = []
  const { ctx: ctx4, calls: calls4 } = makeCtx(live4, {
    sessionPersistence: { resolveCurrentLog: async (id) => join(logDirOf(id), 'session.jsonl.zst') },
    workspaceRegistry: {
      archiveSession: async (id, options) => {
        archiveLog.push({ id, options })
        return script(archiveLog.length)
      },
      archivedSessionIds: [],
    },
  })
  const deps4 = makeDeps(ctx4, () => {})
  let result
  try {
    result = await createAuxSession(deps4, { sessionId: `session-aux-${label}`, mirrorOf: MAIN_ID })
  } catch (error) {
    result = { error }
  }
  return { result, archiveLog, deps4, label }
}

const okRun = await archiveRun('0200', async () => undefined)
row('archive calls (ok)', okRun.archiveLog)
check(
  okRun.result.hidden === true && !okRun.result.warnings.some((warning) => warning.startsWith('archive:')),
  'a successful archive is reported as hidden with no archive warning',
  JSON.stringify(okRun.result.warnings),
)
check(okRun.archiveLog.every((call) => call.options === undefined), 'archiveSession is called WITHOUT stopActivity')
await disposeAuxSession(okRun.deps4, 'session-aux-0200')

const failRun = await archiveRun('0201', async () => {
  throw new Error('registry offline')
})
row('warnings (failing archive)', failRun.result.warnings)
check(failRun.result.hidden === false, 'a failing archive reports hidden=false')
check(failRun.result.info.sessionId === 'session-aux-0201', 'creation still succeeded despite the archive failure')
check(failRun.result.warnings.some((warning) => warning.startsWith('archive:')), 'the archive failure is reported in warnings')
check(failRun.archiveLog.length === 1, 'a non-activity failure is not retried', String(failRun.archiveLog.length))
check(failRun.deps4.registry.has('session-aux-0201') && failRun.deps4.owned.has('session-aux-0201'), 'the session stays registered and owned, so it remains closable')
await disposeAuxSession(failRun.deps4, 'session-aux-0201')

const activeOnce = await archiveRun('0202', async (attempt) => {
  if (attempt === 1) {
    const error = new Error('session is active')
    error.name = 'WorkspaceActiveSessionError'
    error.sessionId = 'session-aux-0202'
    error.activity = [{ kind: 'something' }]
    throw error
  }
  return undefined
})
row('archive attempts (active once)', activeOnce.archiveLog.map((call) => call.id))
check(activeOnce.archiveLog.length === 2, 'WorkspaceActiveSessionError is retried exactly once', String(activeOnce.archiveLog.length))
check(activeOnce.result.hidden === true, 'the retry that succeeds reports hidden=true')
check(activeOnce.archiveLog.every((call) => call.options === undefined), 'the retry still passes no stopActivity')
await disposeAuxSession(activeOnce.deps4, 'session-aux-0202')

const alwaysActive = await archiveRun('0203', async () => {
  const error = new Error('session is active')
  error.name = 'WorkspaceActiveSessionError'
  throw error
})
check(alwaysActive.archiveLog.length === 2, 'a permanently active session is attempted twice and then given up', String(alwaysActive.archiveLog.length))
check(alwaysActive.result.hidden === false && alwaysActive.result.warnings.some((warning) => warning.startsWith('archive:')), 'giving up leaves a warning instead of failing creation')
await disposeAuxSession(alwaysActive.deps4, 'session-aux-0203')

// ── scenario 8: the archive short-circuit listener + Config ─────────────────
console.log('\n# scenario 8 — agent/pre-step short-circuit and Config')
const live5 = new Map([[MAIN_ID, mainAgent]])
const { ctx: ctx5, calls: calls5 } = makeCtx(live5, {
  sessionPersistence: { resolveCurrentLog: async (id) => join(logDirOf(id), 'session.jsonl.zst') },
  workspaceRegistry: { archiveSession: async () => undefined, archivedSessionIds: [] },
})
const built2 = await import(pathToFileURL(join(repo, 'lib', 'index.js')).href)
row('Config default', built2.Config?.['~standard']?.validate({}))
row('Config explicit', built2.Config?.['~standard']?.validate({ hideFromSidebar: true, mirrorHistory: false }))
check(
  built2.Config?.['~standard']?.validate({})?.value?.hideFromSidebar === false,
  'Config defaults hideFromSidebar to FALSE (hiding costs every other pre-step contribution)',
)
check(
  built2.Config?.['~standard']?.validate({})?.value?.mirrorHistory === true,
  'Config defaults mirrorHistory to true',
)
const badConfig = built2.Config?.['~standard']?.validate({ hideFromSidebar: 'nope' })
check(
  Array.isArray(badConfig?.issues) && badConfig.issues.length === 1,
  'Config rejects a non-boolean hideFromSidebar (schemastery standard-schema validation)',
  JSON.stringify(badConfig),
)

built2.apply(ctx5, { hideFromSidebar: true })
const preStep = calls5.listeners.filter((entry) => entry.name === 'agent/pre-step')
check(preStep.length === 1, 'exactly one agent/pre-step listener is registered', String(preStep.length))
check(preStep[0]?.options?.prepend === true, 'the listener is PREPENDED so it runs before the archive gate')
check(preStep[0]?.options?.prepend === true && calls5.registered.length === 2, 'the short-circuit is installed alongside the two commands')

const shortCircuit = preStep[0]?.listener
const auxOwned = 'session-aux-0300'
const created5Raw = await outcome(calls5.registered.find((definition) => definition.name === 'aux-chat').handler, {
  agent: mainAgent,
  rawInput: ` {"sessionId":"${auxOwned}","mirrorOf":"${MAIN_ID}"}`,
})
const created5 = created5Raw.kind === 'success' ? JSON.parse(created5Raw.text) : { error: created5Raw.text }
row('create with short-circuit installed', { kind: created5Raw.kind, hidden: created5.hidden })
check(created5Raw.kind === 'success' && created5.hidden === true, 'the command surface still creates and hides sessions with the short-circuit installed')

let nextCalls = 0
const decisionOwned = await shortCircuit({ agent: { id: auxOwned }, messages: ['kept'] }, async () => {
  nextCalls += 1
  return { kind: 'reject' }
})
row('owned decision', decisionOwned)
check(decisionOwned?.kind === 'enter' && decisionOwned?.messages?.[0] === 'kept', 'an owned session gets {kind:enter} with its own messages')
check(nextCalls === 0, 'an owned session NEVER reaches next(), so the archive gate cannot run')
check(
  calls5.listeners.filter((entry) => entry.name === 'agent/pre-step').length === 1 &&
    JSON.stringify(decisionOwned) === JSON.stringify({ kind: 'enter', messages: ['kept'] }),
  'the short-circuit returns the loop default decision shape verbatim',
)

const decisionForeign = await shortCircuit({ agent: { id: 'session-someone-else' }, messages: [] }, async () => {
  nextCalls += 1
  return { kind: 'reject' }
})
check(nextCalls === 1 && decisionForeign?.kind === 'reject', 'every other session falls through to next() untouched')

const decisionUnknown = await shortCircuit({}, async () => {
  nextCalls += 1
  return { kind: 'enter', messages: [] }
})
check(nextCalls === 2 && decisionUnknown?.kind === 'enter', 'a payload without an agent id falls through to next()')

await outcome(calls5.registered.find((definition) => definition.name === 'aux-end').handler, {
  agent: { id: auxOwned },
  rawInput: ` {"sessionId":"${auxOwned}"}`,
})
const afterDispose = await shortCircuit({ agent: { id: auxOwned }, messages: [] }, async () => {
  nextCalls += 1
  return { kind: 'reject' }
})
check(nextCalls === 3 && afterDispose?.kind === 'reject', 'a destroyed id is out of the ownership set and falls through again')

const defaultArchive = []
const { ctx: ctx6, calls: calls6 } = makeCtx(new Map([[MAIN_ID, mainAgent]]), {
  workspaceRegistry: { archiveSession: async (id) => { defaultArchive.push(id) }, archivedSessionIds: [] },
})
built2.apply(ctx6, {})
check(calls6.listeners.length === 0, 'the DEFAULT config registers NO short-circuit listener')
check(
  built2.Config?.['~standard']?.validate({})?.value?.hideFromSidebar === false,
  'the DEFAULT config is the one asserted above (no listener, no archiving)',
)
const createOff = await outcome(calls6.registered.find((definition) => definition.name === 'aux-chat').handler, {
  agent: mainAgent,
  rawInput: ` {"sessionId":"session-aux-0301","mirrorOf":"${MAIN_ID}"}`,
})
const payloadOff = JSON.parse(createOff.text)
check(payloadOff.hidden === false, 'the default config reports hidden=false and archives nothing')
check(defaultArchive.length === 0, 'the default config never calls workspaceRegistry.archiveSession', JSON.stringify(defaultArchive))
check(calls6.registered.length === 2, 'the commands are registered either way (the fallback path stays usable)')

// ── scenario 9: the four config combinations ────────────────────────────────
console.log('\n# scenario 9 — hideFromSidebar × mirrorHistory, all four combinations')
for (const hide of [false, true]) {
  for (const mirror of [false, true]) {
    const live9 = new Map([[MAIN_ID, mainAgent]])
    const archived9 = []
    const { ctx: ctx9, calls: calls9 } = makeCtx(live9, {
      sessionPersistence: { resolveCurrentLog: async (id) => join(logDirOf(id), 'session.jsonl.zst') },
      workspaceRegistry: { archiveSession: async (id) => { archived9.push(id) }, archivedSessionIds: [] },
      permissionPresets: { current: () => 'standard', defaultPreset: 'standard' },
      sessionProjections: {
        stateOf: (_session, key) => (key === 'todos' ? [{ content: 'do the thing', status: 'in_progress' }] : { current: { goal: { objective: 'ship it', phase: 'active' }, roundsStarted: 2 } }),
      },
      systemPrompt: { assemble: async () => ({ sections: [], contexts: [], tools: [], variables: {} }) },
    })
    const deps9 = makeDeps(ctx9, () => {}, { hideFromSidebar: hide, mirrorHistory: mirror })
    const id9 = `session-aux-04${hide ? '1' : '0'}${mirror ? '1' : '0'}`
    const result9 = await createAuxSession(deps9, { sessionId: id9, mirrorOf: MAIN_ID })
    const section9 = calls9.sections[0].text
    const expectedHidden = hide
    const expectedContent = mirror
    check(
      result9.hidden === expectedHidden && archived9.length === (hide ? 1 : 0),
      `[hide=${String(hide)} mirror=${String(mirror)}] archive follows hideFromSidebar`,
      JSON.stringify({ hidden: result9.hidden, archived: archived9.length }),
    )
    check(
      section9.includes('Summary of the main session conversation') === expectedContent &&
        section9.includes('SYSTEM-PROMPT-TEXT') === expectedContent,
      `[hide=${String(hide)} mirror=${String(mirror)}] content blocks follow mirrorHistory`,
    )
    check(
      section9.includes('/tmp/selfcheck-workspace') && section9.includes('ship it') && section9.includes('do the thing'),
      `[hide=${String(hide)} mirror=${String(mirror)}] facts are delivered in every combination`,
    )
    await disposeAuxSession(deps9, id9)
  }
}

// ── summary ─────────────────────────────────────────────────────────────────
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
