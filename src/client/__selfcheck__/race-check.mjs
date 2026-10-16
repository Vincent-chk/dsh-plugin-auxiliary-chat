#!/usr/bin/env node
/**
 * Offline race & lifecycle self-check for the PRD v2.0 close/identity chain.
 *
 * Drives the REAL `AuxChatController` (src/client/store.ts, imported as source
 * so the check always tracks the code, not a built artifact) against
 * programmable fake deps, and asserts the topology requirements that no
 * screenshot can prove:
 *
 *   C01  R01 — the parent captured at mount never follows the navigation.
 *   C02  T01/V10 — a SILENT close AFTER switching to B still targets A/a
 *         (dispose + closeIn both bound to the captured ids) and the close
 *         copy names A, not B.
 *   C03  E06/T04 — a creation that settles after its pending tab was closed
 *         is rolled back and installs nothing.
 *   C04  T05 — a late continuation cannot clobber a NEWER instance opened
 *         under the same tab id; the old resource is released.
 *   C05  T14 — ten concurrent silent closes produce exactly one dispose chain.
 *   C06  E07 — a failing close keeps the tab, records the exact target, and
 *         the retry reuses the SAME operationId; success removes the tab.
 *   C07  §6.3 — a hanging close trips the watchdog into closeFailed.
 *   C08  R10 — "already closed elsewhere" converges instead of failing.
 *   C09  decision 2026-10-16 — silent close never branches on content.
 *   C10  E12 — a recorded reload-binding restores the ORIGINAL child (no
 *         second create), scoped to this window's owner.
 *   C11  T16 — a refused reclaim shows `ended` and 新建 mints a NEW
 *         generation instead of reviving or re-forking.
 *   C12  T12 — the close carries the captured host generation.
 *   C17  round 3 — removal-first: the gesture returns WITHOUT a veto, the
 *         framework removes the tab (abort lands before the dispose
 *         settles), and the background dispose still completes exactly once.
 *   C18  round 3 — a dispose failure after the tab is gone auto-retries the
 *         SAME operationId once and converges silently (no warning).
 *   C19  round 3 — a dispose that keeps failing after the retry surfaces
 *         exactly one console warning and leaves no unhandled rejection.
 *   C20  issue #2 — an occurrence release with a LIVE tab record detaches
 *         (no dispose, reference + binding kept) and the remount of the same
 *         tabKey RECLAIMS the same child without a second create or retain.
 *   C21  issue #2 — a creation settling after the occurrence was released
 *         (record alive) is KEPT and bound for the remount; the record-gone
 *         twin stays C15's rollback.
 *   C22  issue #2 — a superseding occurrence under the same tab id reclaims
 *         the child, and the stale occurrence's late abort is ignored.
 *   C23  issue #2 — a reclaim settling after a record-alive release keeps
 *         the child alive and referenced for the next remount.
 *
 * Run: node src/client/__selfcheck__/race-check.mjs
 * @module client/__selfcheck__/race-check
 */
import { AuxChatController } from '../store.ts'
import { setCopyLang } from '../../locale.ts'

const checks = []
const failures = []
function check(label, condition, detail) {
  const ok = Boolean(condition)
  checks.push({ label, ok })
  if (!ok) failures.push(`${label}${detail === undefined ? '' : `  [${detail}]`}`)
}

// ── storage shims (reload-binding) ─────────────────────────────────────────
const localMap = new Map()
const sessionMap = new Map()
globalThis.localStorage = {
  getItem: (k) => (localMap.has(k) ? localMap.get(k) : null),
  setItem: (k, v) => localMap.set(k, String(v)),
  removeItem: (k) => localMap.delete(k),
}
globalThis.sessionStorage = {
  getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
  setItem: (k, v) => sessionMap.set(String(k), String(v)),
}

// ── fake platform faces ─────────────────────────────────────────────────────
const MAIN_A = 'session-main-AAAA'
const MAIN_B = 'session-main-BBBB'
let auxCounter = 0
const nextAuxId = () => `session-aux-${String((auxCounter += 1)).padStart(4, '0')}`
void nextAuxId

function makeSessions() {
  const rows = {
    [MAIN_A]: { id: MAIN_A, title: '主会话A：重构调研', cwd: '/w/a' },
    [MAIN_B]: { id: MAIN_B, title: '主会话B：发布准备', cwd: '/w/b' },
  }
  const state = { ids: [MAIN_A, MAIN_B], byId: rows }
  return {
    list: {
      getSnapshot: () => state,
      subscribe: () => () => undefined,
    },
    retain: (id) => {
      retainCalls.push(id)
      return makeReference(id)
    },
  }
}

/** Every `sessions.retain` the fake served, to prove no double-retain (C20). */
const retainCalls = []

/**
 * Committed-layout records the fake `tabsIn` serves. EMPTY by default, which
 * routes every abort through the record-gone destructor — the pre-issue-#2
 * behaviour the older cases assert. Cases C20+ push records to exercise the
 * occurrence-release DETACH path.
 */
const sidebarRecords = []

function makeReference(id) {
  const snapshot = { running: false, promptAttempted: false, pendingSubmissions: [] }
  return {
    sessionId: id,
    binding: {
      sessionId: id,
      eventSource: { getSnapshot: () => ({ entries: [] }), subscribe: () => () => undefined },
      ctx: {},
      session: { getSnapshot: () => snapshot, subscribe: () => () => undefined },
    },
    ready: Promise.resolve(),
    release: () => {},
  }
}

function makeSidebar() {
  const calls = { closeIn: [], close: [], focus: [], openTab: [] }
  const tabs = new Map()
  return {
    calls,
    _tabs: tabs,
    openTab: (kind, opts) => calls.openTab.push({ kind, opts }),
    focus: (id) => calls.focus.push(id),
    close: (id) => {
      calls.close.push(id)
      const rec = tabs.get(id)
      if (rec) rec.abort.abort()
    },
    closeIn: (sessionId, tabId) => {
      calls.closeIn.push({ sessionId, tabId })
      const rec = tabs.get(tabId)
      if (rec) rec.abort.abort()
    },
    active: () => undefined,
    isExpanded: () => true,
    toggleExpanded: () => {},
    tabsIn: (sessionId) => sidebarRecords.filter((rec) => rec.sessionId === sessionId).map((rec) => rec.tab),
    mounted: { getSnapshot: () => MAIN_A, subscribe: () => () => undefined },
  }
}

/** Module-wide so ids minted by different harnesses never collide. */
let createCounter = 0

const sidebar = makeSidebar()

/** Programmable deps: every call is recorded; outcomes are scripted per test. */
function makeDeps() {
  const log = { create: [], reclaim: [], dispose: [] }
  const modes = { create: 'ok', reclaim: 'gone', dispose: 'ok' }
  const deferreds = []
  const reclaimDeferreds = []
  const deps = {
    sessions: makeSessions(),
    retainSource: 'auxChatPanel',
    client: {
      get: (name) => (name === 'sidebarRight' ? sidebar : undefined),
    },
    closeTimeoutMs: 60,
    async create(cwd, mainSessionId) {
      // v3 channel: the child id is SERVER-MINTED (fork); the fake mints it
      // here and returns it with the outcome, exactly like the real remote.
      const auxSessionId = `session-aux-${String((createCounter += 1)).padStart(4, '0')}`
      log.create.push({ auxSessionId, cwd, mainSessionId })
      if (modes.create === 'defer') {
        await new Promise((resolve) => deferreds.push({ auxSessionId, resolve }))
      } else if (modes.create === 'fail') {
        throw new Error('aux-chat/internal: boom')
      }
      return { cwd, warnings: [], downgrade: 'full', hostGeneration: 'gen-host-1', sessionId: auxSessionId }
    },
    async reclaim(auxSessionId, mainSessionId) {
      log.reclaim.push({ auxSessionId, mainSessionId })
      if (modes.reclaim === 'defer') {
        return await new Promise((resolve) => reclaimDeferreds.push({ auxSessionId, resolve }))
      }
      if (modes.reclaim === 'reclaimed') {
        return { kind: 'reclaimed', outcome: { cwd: '/w/a', warnings: [], downgrade: 'summary', hostGeneration: 'gen-host-1', reclaimed: true } }
      }
      return { kind: 'gone' }
    },
    async dispose(auxSessionId, options) {
      log.dispose.push({ auxSessionId, options })
      if (modes.dispose === 'fail') {
        modes.dispose = 'ok'
        throw new Error('aux-chat/dispose-failed: teardown refused')
      }
      if (modes.dispose === 'hang') {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    },
    async handoff() {
      return { ok: true, message: '' }
    },
    present: () => {},
  }
  return { deps, log, modes, deferreds, reclaimDeferreds }
}

// Pin the copy language: Node >=21 exposes navigator.language (en-US), which
// would flip the dictionary to en and break the zh assertions below.
setCopyLang('zh')

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One silent close gesture (round 3, removal-first): the shipped handler must
 * return normally — the framework removes the tab itself while the protocol
 * disposes in the background. Any throw fails the calling check loudly.
 */
async function silentClose(controller, tabId) {
  controller.handleTabClose({ id: tabId })
  await settle()
}

/** Build a controller + one live tab bound to MAIN_A, ready phase. */
async function readyRuntime(script = {}) {
  const harness = makeDeps()
  Object.assign(harness.modes, script)
  const controller = new AuxChatController(harness.deps)
  const abort = new AbortController()
  controller.ensureTabSession(abort.signal, { tabId: 'tab-1', mainSessionId: MAIN_A, tabKey: 'content-1' })
  await settle()
  const runtime = controller.tabRuntime('tab-1')
  return { controller, harness, runtime, abort }
}

// ══ C01: the captured parent never follows navigation (R01) ════════════════
{
  const { controller, runtime } = await readyRuntime()
  controller.setMainSession(MAIN_B)
  check('C01: runtime parent stays A after navigation to B', runtime.mainSessionId === MAIN_A, runtime.mainSessionId)
  check('C01: the auxiliary session exists and is ready', runtime.phase === 'ready' && typeof runtime.sessionId === 'string', runtime.phase)
  controller.closeTabSession('tab-1', 'check done')
  await settle()
}

// ══ C02: close confirmed after A→B still targets A/a (T01/V10) ═════════════
{
  const { controller, harness, runtime } = await readyRuntime()
  runtime.hasOwnTurn = true
  controller.setMainSession(MAIN_B)
  await silentClose(controller, 'tab-1')
  check('C02: close copy names A (not the currently mounted B)', runtime.mainTitle === '主会话A：重构调研', String(runtime.mainTitle))
  check('C02: the silent protocol owns the captured tab', runtime.phase === 'closed' || runtime.phase === 'closing', runtime.phase)
  check('C02: no confirmation state exists on the runtime', runtime.closeState === undefined, String(runtime.closeState))
  await settle()
  const dispose = harness.log.dispose.at(-1)
  check('C02: dispose hit the captured child with the captured host generation', dispose?.auxSessionId === runtime.sessionId && dispose?.options?.hostGeneration === 'gen-host-1', JSON.stringify(dispose))
  const closeIn = sidebar.calls.closeIn.at(-1)
  check('C02: tab removed from A, never from B', closeIn?.sessionId === MAIN_A && closeIn?.tabId === 'tab-1', JSON.stringify(closeIn))
  check('C02: runtime reached closed', controller.tabRuntime('tab-1')?.phase === 'closed', controller.tabRuntime('tab-1')?.phase)
}

// ══ C03: late creation success after the pending tab closed (E06/T04) ══════
{
  const harness = makeDeps()
  harness.modes.create = 'defer'
  const controller = new AuxChatController(harness.deps)
  const abort = new AbortController()
  controller.ensureTabSession(abort.signal, { tabId: 'tab-1', mainSessionId: MAIN_A, tabKey: 'content-1' })
  await settle()
  abort.abort()
  await settle()
  const deferred = harness.deferreds.at(-1)
  deferred.resolve()
  await settle()
  check('C03: the late child was rolled back (disposed)', harness.log.dispose.some((d) => d.auxSessionId === deferred.auxSessionId), JSON.stringify(harness.log.dispose))
  check('C03: nothing was installed into the closed tab', controller.tabRuntime('tab-1') === undefined, String(controller.tabRuntime('tab-1')))
}

// copy-truth: preparingTitle preparingBody
// ══ C04: a late continuation cannot clobber a newer same-tab-id instance (T05)
{
  const harness = makeDeps()
  harness.modes.create = 'defer'
  const controller = new AuxChatController(harness.deps)
  const first = new AbortController()
  controller.ensureTabSession(first.signal, { tabId: 'tab-1', mainSessionId: MAIN_A, tabKey: 'content-1' })
  await settle()
  const firstDeferred = harness.deferreds[0]
  first.abort()
  await settle()
  const second = new AbortController()
  controller.ensureTabSession(second.signal, { tabId: 'tab-1', mainSessionId: MAIN_A, tabKey: 'content-1' })
  await settle()
  check('C04: the new occurrence is creating independently', controller.tabRuntime('tab-1')?.phase === 'creating', controller.tabRuntime('tab-1')?.phase)
  firstDeferred.resolve()
  const secondDeferred = harness.deferreds[1]
  secondDeferred.resolve()
  await settle()
  const runtime = controller.tabRuntime('tab-1')
  check('C04: the new instance survived and bound the NEW session', runtime?.phase === 'ready' && runtime?.sessionId !== firstDeferred.auxSessionId, `${runtime?.phase} ${runtime?.sessionId}`)
  check("C04: the old occurrence's session was rolled back", harness.log.dispose.some((d) => d.auxSessionId === firstDeferred.auxSessionId), JSON.stringify(harness.log.dispose))
  check('C04: exactly one session remains retained', controller.referenceFor(runtime.sessionId) !== undefined && controller.referenceFor(firstDeferred.auxSessionId) === undefined, '')
  controller.closeTabSession('tab-1', 'check done')
  await settle()
}

// ══ C05: ten concurrent confirms → one logical close (T14) ═════════════════
{
  const { controller, harness, runtime } = await readyRuntime()
  runtime.hasOwnTurn = true
  await Promise.all(Array.from({ length: 10 }, () => silentClose(controller, 'tab-1')))
  await settle()
  const disposes = harness.log.dispose.filter((d) => d.auxSessionId === runtime.sessionId)
  check('C05: exactly one dispose ran for the silent close', disposes.length === 1, String(disposes.length))
  check('C05: the runtime closed exactly once', controller.tabRuntime('tab-1')?.phase === 'closed', controller.tabRuntime('tab-1')?.phase)
}

// copy-truth: closeFailedTitle closeFailedBody retryClose
// ══ C06: failing close keeps the tab; retry reuses the operationId (E07) ═══
{
  const { controller, harness, runtime } = await readyRuntime()
  runtime.hasOwnTurn = true
  harness.modes.dispose = 'fail'
  await silentClose(controller, 'tab-1')
  await settle()
  check('C06: a failed close enters closeFailed', controller.tabRuntime('tab-1')?.phase === 'closeFailed', controller.tabRuntime('tab-1')?.phase)
  check('C06: the failure records the exact target', (controller.tabRuntime('tab-1')?.closeError ?? '').includes('teardown refused'), controller.tabRuntime('tab-1')?.closeError)
  const firstOp = harness.log.dispose.at(-1)?.options?.operationId
  check('C06: the first attempt minted an operation id', typeof firstOp === 'string' && firstOp.startsWith('close-'), String(firstOp))
  await controller.retryClose('tab-1')
  await settle()
  const retry = harness.log.dispose.at(-1)
  check('C06: the retry targets the same child with the SAME operation id', retry?.auxSessionId === runtime.sessionId && retry?.options?.operationId === firstOp, JSON.stringify(retry))
  check('C06: the retry closed the tab', controller.tabRuntime('tab-1')?.phase === 'closed', controller.tabRuntime('tab-1')?.phase)
  const closeIn = sidebar.calls.closeIn.at(-1)
  check('C06: removal still bound to A', closeIn?.sessionId === MAIN_A, JSON.stringify(closeIn))
}

// copy-truth: closingTitle closingBody closingBodyLong
// ══ C07: a hanging close trips the watchdog (§6.3) ═════════════════════════
{
  const { controller, harness } = await readyRuntime()
  harness.modes.dispose = 'hang'
  const t0 = Date.now()
  const inFlight = silentClose(controller, 'tab-1') // not awaited yet
  check('C07: the closing feedback flips synchronously (100ms budget)', controller.tabRuntime('tab-1')?.phase === 'closing', controller.tabRuntime('tab-1')?.phase)
  await settle(100) // past the 60ms watchdog, before the 500ms dispose settles
  const phase = controller.tabRuntime('tab-1')?.phase
  check('C07: a hanging close becomes closeFailed via the watchdog', phase === 'closeFailed', String(phase))
  check('C07: the watchdog fired within the configured bound', Date.now() - t0 < 450, String(Date.now() - t0))
  check('C07: the timeout names the original target', (controller.tabRuntime('tab-1')?.closeError ?? '').includes('未完成'), controller.tabRuntime('tab-1')?.closeError)
  harness.modes.dispose = 'ok'
  await controller.retryClose('tab-1')
  await inFlight.catch(() => undefined)
  await settle(20)
  check('C07: recovery by retry after the timeout', controller.tabRuntime('tab-1')?.phase === 'closed', controller.tabRuntime('tab-1')?.phase)
}

// ══ C08: already-closed convergence (R10/T05) ══════════════════════════════
{
  const harness = makeDeps()
  harness.deps.dispose = async (auxSessionId, options) => {
    harness.log.dispose.push({ auxSessionId, options })
    throw new Error('aux-chat/not-registered: session is not an auxiliary session of this plugin (already destroyed, or never created here)')
  }
  const controller = new AuxChatController(harness.deps)
  controller.ensureTabSession(new AbortController().signal, { tabId: 'tab-1', mainSessionId: MAIN_A, tabKey: 'content-8' })
  await settle()
  const runtime = controller.tabRuntime('tab-1')
  runtime.hasOwnTurn = true
  await silentClose(controller, 'tab-1')
  await settle()
  check('C08: not-registered converges to closed instead of closeFailed', controller.tabRuntime('tab-1')?.phase === 'closed', controller.tabRuntime('tab-1')?.phase)
  const hintKey = [...localMap.keys()].find((k) => k.endsWith('.content-8'))
  check('C08: the binding hint was cleared', hintKey === undefined, JSON.stringify([...localMap.keys()]))
  // Stale-generation (host restarted meanwhile) converges the same way.
  const harness2 = makeDeps()
  harness2.deps.dispose = async (auxSessionId, options) => {
    harness2.log.dispose.push({ auxSessionId, options })
    throw new Error('aux-chat/stale-generation: close request was captured on Host generation "gen-old" but this Host is generation "gen-new"')
  }
  const controller2 = new AuxChatController(harness2.deps)
  controller2.ensureTabSession(new AbortController().signal, { tabId: 'tab-1', mainSessionId: MAIN_A, tabKey: 'content-8b' })
  await settle()
  controller2.tabRuntime('tab-1').hasOwnTurn = true
  await silentClose(controller2, 'tab-1')
  await settle()
  check('C08: stale-generation converges to closed (host restart ended the resource)', controller2.tabRuntime('tab-1')?.phase === 'closed', controller2.tabRuntime('tab-1')?.phase)
}

// ══ C09: silent close never branches on content (decision 2026-10-16) ═════
{
  const { controller, harness } = await readyRuntime()
  let threwEmpty = false
  try {
    controller.handleTabClose({ id: 'tab-1', kind: 'aux-chat' })
  } catch {
    threwEmpty = true
  }
  check('C09: an empty idle tab enters the silent protocol without a veto', threwEmpty === false && controller.tabRuntime('tab-1')?.phase === 'closing', controller.tabRuntime('tab-1')?.phase)
  await settle()
  check('C09: the empty tab was disposed and closed', harness.log.dispose.length === 1 && controller.tabRuntime('tab-1')?.phase === 'closed', String(controller.tabRuntime('tab-1')?.phase))
  const second = await readyRuntime()
  second.runtime.hasQueue = true
  second.runtime.hasOwnTurn = true
  second.runtime.running = true
  let threwBusy = false
  try {
    second.controller.handleTabClose({ id: 'tab-1', kind: 'aux-chat' })
  } catch {
    threwBusy = true
  }
  await settle()
  const busyPhase = second.controller.tabRuntime('tab-1')?.phase
  check('C09: a running/queued tab takes the SAME silent path (no dialog state, no veto)', threwBusy === false && busyPhase === 'closed' && second.controller.tabRuntime('tab-1')?.closeState === undefined, String(busyPhase))
}

// ══ C10: a recorded reload-binding restores the ORIGINAL child (E12) ═══════
{
  // Capture the owner identity the earlier blocks minted, so the restore
  // below is exact rather than a hardcoded value.
  const ORIGINAL_OWNER = sessionMap.get('aux-chat.owner')
  const first = await readyRuntime()
  const boundId = first.runtime.sessionId
  check('C10: a ready pane recorded its binding', localMap.size === 1, JSON.stringify([...localMap.keys()]))
  first.controller.dispose()
  const harness = makeDeps()
  harness.modes.reclaim = 'reclaimed'
  const controller = new AuxChatController(harness.deps)
  controller.ensureTabSession(new AbortController().signal, { tabId: 'tab-9', mainSessionId: MAIN_A, tabKey: 'content-1' })
  await settle()
  const runtime = controller.tabRuntime('tab-9')
  check('C10: the reloaded pane reclaimed the SAME child id', runtime?.sessionId === boundId, `${runtime?.sessionId} vs ${boundId}`)
  check('C10: no second session was created', harness.log.create.length === 0, JSON.stringify(harness.log.create))
  check('C10: the reclaimed session is ready', runtime?.phase === 'ready', String(runtime?.phase))
  sessionMap.set('aux-chat.owner', 'owner-other-window')
  const harness2 = makeDeps()
  const controller2 = new AuxChatController(harness2.deps)
  controller2.ensureTabSession(new AbortController().signal, { tabId: 'tab-w2', mainSessionId: MAIN_A, tabKey: 'content-1' })
  await settle()
  check('C10: a second window starts its OWN instance (no reclaim)', harness2.log.reclaim.length === 0 && harness2.log.create.length === 1, JSON.stringify({ reclaim: harness2.log.reclaim.length, create: harness2.log.create.length }))
  // Restore the minted owner so later blocks share the first window's identity.
  sessionMap.set('aux-chat.owner', ORIGINAL_OWNER)
  controller.closeTabSession('tab-9', 'check done')
  controller2.closeTabSession('tab-w2', 'check done')
  await settle()
}

// copy-truth: endedTitle endedDefault
// ══ C11: a refused reclaim shows ended; 新建 mints a NEW generation (T16) ══
{
  const { controller, runtime } = await readyRuntime()
  check('C11: precondition — binding recorded', localMap.size >= 1, String(localMap.size))
  controller.dispose()
  const harness = makeDeps()
  harness.modes.reclaim = 'gone'
  const controller2 = new AuxChatController(harness.deps)
  controller2.ensureTabSession(new AbortController().signal, { tabId: 'tab-x', mainSessionId: MAIN_A, tabKey: 'content-1' })
  await settle()
  const ended = controller2.tabRuntime('tab-x')
  check('C11: a refused reclaim ends the pane (no re-fork)', ended?.phase === 'ended' && harness.log.create.length === 0, `${ended?.phase} create=${harness.log.create.length}`)
  check('C11: the ended copy explains itself', (ended?.endedReason ?? '').includes('辅助会话已结束'), ended?.endedReason)
  controller2.restartTabSession('tab-x')
  await settle()
  const revived = controller2.tabRuntime('tab-x')
  check('C11: 新建 minted a NEW resource generation', revived?.phase === 'ready' && revived?.sessionId !== runtime.sessionId, `${revived?.phase} ${revived?.sessionId}`)
  controller2.closeTabSession('tab-x', 'check done')
  await settle()
}

// ══ C12: the close carries the captured host generation (T12) ══════════════
{
  const { controller, harness, runtime } = await readyRuntime()
  runtime.hasOwnTurn = true
  await silentClose(controller, 'tab-1')
  await settle()
  const dispose = harness.log.dispose.at(-1)
  check('C12: dispose carried hostGeneration=gen-host-1 and an operationId', dispose?.options?.hostGeneration === 'gen-host-1' && typeof dispose?.options?.operationId === 'string', JSON.stringify(dispose?.options))
}

// ══ C13: silent close of a RUNNING turn aborts via dispose (decision) ═══════
{
  const { controller, harness, runtime } = await readyRuntime()
  runtime.running = true
  runtime.hasOwnTurn = true
  await silentClose(controller, 'tab-1')
  check('C13: a running turn is closed silently (dispose ran, no dialog)', harness.log.dispose.length === 1 && controller.tabRuntime('tab-1')?.phase === 'closed', String(controller.tabRuntime('tab-1')?.phase))
  check('C13: no confirmation state object exists on the runtime', controller.tabRuntime('tab-1')?.closeState === undefined, String(controller.tabRuntime('tab-1')?.closeState))
}

// ══ C14: double-click on the close gesture = one logical close ══════════════
{
  const { controller, harness, runtime } = await readyRuntime()
  runtime.hasOwnTurn = true
  await Promise.all([silentClose(controller, 'tab-1'), silentClose(controller, 'tab-1')])
  const disposes = harness.log.dispose.filter((d) => d.auxSessionId === runtime.sessionId)
  check('C14: two gestures in the same tick produce one dispose', disposes.length === 1, String(disposes.length))
}

// ══ C15: closing a creating tab allows removal; late child still rolled back ═
{
  const harness = makeDeps()
  harness.modes.create = 'defer'
  const controller = new AuxChatController(harness.deps)
  const abort = new AbortController()
  controller.ensureTabSession(abort.signal, { tabId: 'tab-1', mainSessionId: MAIN_A, tabKey: 'content-15' })
  await settle()
  let threw = false
  try {
    controller.handleTabClose({ id: 'tab-1' })
  } catch {
    threw = true
  }
  check('C15: a creating tab closes without a veto (nothing owned yet)', threw === false, String(threw))
  abort.abort()
  await settle()
  const deferred = harness.deferreds.at(-1)
  deferred.resolve()
  await settle()
  check('C15: the late child of a closed creating tab is rolled back', harness.log.dispose.some((d) => d.auxSessionId === deferred.auxSessionId), JSON.stringify(harness.log.dispose))
}

// ══ C16: indicators() is the single source for unread/live/running ═════════
{
  const { controller, runtime } = await readyRuntime()
  runtime.unread = true
  const ind = controller.indicators()
  check('C16: indicators report one live unread runtime', ind.live === 1 && ind.unread === 1 && ind.running === 0, JSON.stringify(ind))
  controller.markSeen('tab-1')
  const after = controller.indicators()
  check('C16: markSeen clears the unread indicator', after.unread === 0 && after.live === 1, JSON.stringify(after))
  controller.closeTabSession('tab-1', 'check done')
  await settle()
  const gone = controller.indicators()
  check('C16: a closed runtime leaves the indicators', gone.live === 0, JSON.stringify(gone))
}

// ══ C17: removal-first timing (round 3) ═════════════════════════════════════
{
  const { controller, harness, runtime, abort } = await readyRuntime()
  let threw = false
  try {
    controller.handleTabClose({ id: 'tab-1' })
  } catch {
    threw = true
  }
  check('C17: the close gesture returns without a veto (the framework removes the tab)', threw === false, String(threw))
  check('C17: the protocol took responsibility synchronously', controller.tabRuntime('tab-1')?.phase === 'closing', controller.tabRuntime('tab-1')?.phase)
  // The framework's synchronous commit unmounts the tab right after the
  // gesture returns — emulate it: the abort bookkeeping runs BEFORE the
  // dispose settles (the real ordering under removal-first).
  abort.abort()
  check('C17: the unmount bookkeeping retired the runtime', controller.tabRuntime('tab-1') === undefined, String(controller.tabRuntime('tab-1')))
  await settle()
  const disposes = harness.log.dispose.filter((d) => d.auxSessionId === runtime.sessionId)
  check('C17: the background dispose completed exactly once', disposes.length === 1, String(disposes.length))
  // C10 deliberately leaves a SECOND window's hint under another owner; this
  // check owns only THIS window's key.
  const owner = sessionMap.get('aux-chat.owner')
  check('C17: the reload-binding hint is cleared', !localMap.has(`aux-chat.binding.${owner}.content-1`), JSON.stringify([...localMap.keys()]))
}

// ══ C18: background failure retries once with the SAME operation (round 3) ═
{
  const { controller, harness, runtime, abort } = await readyRuntime()
  harness.modes.dispose = 'fail' // fails once, then resets to ok
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.map(String).join(' '))
  try {
    controller.handleTabClose({ id: 'tab-1' })
    abort.abort() // tab already removed by the framework
    await settle()
    await settle(1_300) // past the 1s background retry
  } finally {
    console.warn = origWarn
  }
  const disposes = harness.log.dispose.filter((d) => d.auxSessionId === runtime.sessionId)
  const opIds = new Set(disposes.map((d) => d.options?.operationId))
  check('C18: the failed background close retried exactly once more', disposes.length === 2, String(disposes.length))
  check('C18: the retry reused the SAME operation id', opIds.size === 1 && [...opIds][0]?.startsWith('close-'), JSON.stringify([...opIds]))
  check('C18: a converged retry stays fully silent (no warning)', warns.length === 0, warns.join(' | '))
}

// ══ C19: persistent failure → exactly one warning, no unhandled rejection ══
{
  const { controller, runtime, abort } = await readyRuntime()
  controller.deps.dispose = async () => {
    throw new Error('aux-chat/dispose-failed: permanent refusal')
  }
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.map(String).join(' '))
  let unhandled = null
  const onUnhandled = (error) => {
    unhandled = error
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    controller.handleTabClose({ id: 'tab-1' })
    abort.abort()
    await settle()
    await settle(1_300)
  } finally {
    console.warn = origWarn
    process.off('unhandledRejection', onUnhandled)
  }
  check('C19: a persistently failing close surfaced exactly one warning', warns.length === 1 && warns[0]?.includes('background close'), JSON.stringify(warns))
  check('C19: the warning names the session and its resource is left to the boot sweep', warns[0]?.includes(runtime.sessionId) === true, String(warns[0]))
  check('C19: no unhandled rejection escaped the protocol', unhandled === null, String(unhandled))
}

// ══ C20: issue #2 — occurrence release with a live tab record DETACHES ════
{
  const { controller, harness, runtime, abort } = await readyRuntime()
  const owner = sessionMap.get('aux-chat.owner')
  const auxId = runtime.sessionId
  sidebarRecords.push({ sessionId: MAIN_A, tab: { id: 'tab-1', kind: 'aux-chat', contentId: 'content-1' } })
  abort.abort() // the host recycled the occurrence (seat switch / layout sync)
  check('C20: the runtime detached from the map', controller.tabRuntime('tab-1') === undefined, String(controller.tabRuntime('tab-1')?.phase))
  await settle()
  check('C20: a live tab record never disposes the child', harness.log.dispose.length === 0, JSON.stringify(harness.log.dispose))
  check('C20: the retained reference survives the detach', controller.referenceFor(auxId) !== undefined, String(auxId))
  check('C20: the tabKey binding survives the detach', localMap.has(`aux-chat.binding.${owner}.content-1`), JSON.stringify([...localMap.keys()]))
  // Remount: a NEW occurrence of the SAME tab (new signal, same contentId).
  harness.modes.reclaim = 'reclaimed'
  const remount = new AbortController()
  controller.ensureTabSession(remount.signal, { tabId: 'tab-1', mainSessionId: MAIN_A, tabKey: 'content-1' })
  await settle()
  const again = controller.tabRuntime('tab-1')
  check('C20: the remount RECLAIMED the same child (no second create)', again?.sessionId === auxId && harness.log.create.length === 1, `${String(again?.sessionId)} / ${String(harness.log.create.length)}`)
  check('C20: the reclaimed runtime is ready under the new occurrence', again?.phase === 'ready', String(again?.phase))
  check('C20: the remount did not double-retain the child', retainCalls.filter((id) => id === auxId).length === 1, JSON.stringify(retainCalls))
}

// ══ C21: issue #2 — creation in flight when the occurrence is released ═════
{
  const harness = makeDeps()
  harness.modes.create = 'defer'
  const controller = new AuxChatController(harness.deps)
  const abort = new AbortController()
  sidebarRecords.push({ sessionId: MAIN_A, tab: { id: 'tab-42', kind: 'aux-chat', contentId: 'content-42' } })
  controller.ensureTabSession(abort.signal, { tabId: 'tab-42', mainSessionId: MAIN_A, tabKey: 'content-42' })
  await settle()
  abort.abort() // occurrence released while the create round-trip is in flight
  check('C21: the creating runtime detached', controller.tabRuntime('tab-42') === undefined, String(controller.tabRuntime('tab-42')?.phase))
  const deferred = harness.deferreds.at(-1)
  deferred.resolve()
  await settle()
  check('C21: the late child is KEPT (record alive), not rolled back', harness.log.dispose.length === 0, JSON.stringify(harness.log.dispose))
  const owner = sessionMap.get('aux-chat.owner')
  check('C21: the late child wrote the tabKey binding for the remount', localMap.has(`aux-chat.binding.${owner}.content-42`), JSON.stringify([...localMap.keys()]))
  check('C21: the late child is referenced (alive outside the view tree)', controller.referenceFor(deferred.auxSessionId) !== undefined, String(deferred.auxSessionId))
  // The symmetric record-gone case is C15: the late child of a CLOSED tab
  // rolls back — the routing rule, not the race, decides.
}

// ══ C22: issue #2 — a superseding occurrence under the same tab id ═════════
{
  const harness = makeDeps()
  const controller = new AuxChatController(harness.deps)
  const first = new AbortController()
  controller.ensureTabSession(first.signal, { tabId: 'tab-7', mainSessionId: MAIN_A, tabKey: 'content-7' })
  await settle()
  const auxId = controller.tabRuntime('tab-7')?.sessionId
  sidebarRecords.push({ sessionId: MAIN_A, tab: { id: 'tab-7', kind: 'aux-chat', contentId: 'content-7' } })
  // The host re-issued the tab under a NEW occurrence signal.
  const second = new AbortController()
  harness.modes.reclaim = 'reclaimed'
  controller.ensureTabSession(second.signal, { tabId: 'tab-7', mainSessionId: MAIN_A, tabKey: 'content-7' })
  await settle()
  const runtime = controller.tabRuntime('tab-7')
  check('C22: the new occurrence owns the runtime and RECLAIMED the child', runtime?.signal === second.signal && runtime?.sessionId === auxId, `${String(runtime?.phase)}/${String(runtime?.sessionId)}`)
  check('C22: the supersede minted no second child', harness.log.create.length === 1, String(harness.log.create.length))
  first.abort() // the dead occurrence's abort arrives LAST
  await settle()
  check(
    'C22: the stale occurrence late abort is ignored (child still bound)',
    controller.tabRuntime('tab-7')?.sessionId === auxId && harness.log.dispose.length === 0,
    `${String(controller.tabRuntime('tab-7')?.sessionId)}/${String(harness.log.dispose.length)}`,
  )
}

// ══ C23: issue #2 — reclaim in flight when the occurrence is released ══════
{
  const harness = makeDeps()
  harness.modes.reclaim = 'reclaimed'
  const controller = new AuxChatController(harness.deps)
  const first = new AbortController()
  controller.ensureTabSession(first.signal, { tabId: 'tab-8', mainSessionId: MAIN_A, tabKey: 'content-8' })
  await settle()
  const auxId = controller.tabRuntime('tab-8')?.sessionId
  sidebarRecords.push({ sessionId: MAIN_A, tab: { id: 'tab-8', kind: 'aux-chat', contentId: 'content-8' } })
  first.abort() // detach
  // Remount with a DEFERRED reclaim, then release the second occurrence
  // while the reclaim round-trip is still in flight.
  harness.modes.reclaim = 'defer'
  const second = new AbortController()
  controller.ensureTabSession(second.signal, { tabId: 'tab-8', mainSessionId: MAIN_A, tabKey: 'content-8' })
  await settle()
  second.abort()
  const deferred = harness.reclaimDeferreds.at(-1)
  deferred.resolve({ kind: 'reclaimed', outcome: { cwd: '/w/a', warnings: [], downgrade: 'summary', hostGeneration: 'gen-host-1', reclaimed: true } })
  await settle()
  check('C23: a reclaim settling after a record-alive release KEEPS the child', harness.log.dispose.length === 0, JSON.stringify(harness.log.dispose))
  check('C23: the child stays referenced for the next remount', controller.referenceFor(auxId) !== undefined, String(auxId))
}

// ── report ──────────────────────────────────────────────────────────────────
const passed = checks.filter((c) => c.ok).length
console.log(`race-check: ${passed}/${checks.length} checks passed`)
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
