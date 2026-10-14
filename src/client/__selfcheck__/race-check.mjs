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
 *   C02  T01/V10 — a close confirmed AFTER switching to B still targets A/a
 *         (dispose + closeIn both bound to the captured ids) and the confirm
 *         copy names A, not B.
 *   C03  E06/T04 — a creation that settles after its pending tab was closed
 *         is rolled back and installs nothing.
 *   C04  T05 — a late continuation cannot clobber a NEWER instance opened
 *         under the same tab id; the old resource is released.
 *   C05  T14 — ten concurrent confirms produce exactly one dispose chain.
 *   C06  E07 — a failing close keeps the tab, records the exact target, and
 *         the retry reuses the SAME operationId; success removes the tab.
 *   C07  §6.3 — a hanging close trips the watchdog into closeFailed.
 *   C08  R10 — "already closed elsewhere" converges instead of failing.
 *   C09  §6.3 — empty+idle closes directly; a queued submission confirms.
 *   C10  E12 — a recorded reload-binding restores the ORIGINAL child (no
 *         second create), scoped to this window's owner.
 *   C11  T16 — a refused reclaim shows `ended` and 新建 mints a NEW
 *         generation instead of reviving or re-forking.
 *   C12  T12 — the close carries the captured host generation.
 *
 * Run: node src/client/__selfcheck__/race-check.mjs
 * @module client/__selfcheck__/race-check
 */
import { AuxChatController } from '../store.ts'

const checks = []
const failures = []
function check(label, condition, detail) {
  const ok = Boolean(condition)
  checks.push({ label, ok })
  if (!ok) failures.push(`${label}${detail === undefined ? '' : `  [${detail}]`}`)
}

// ── storage shims (reload-binding + confirm preference) ────────────────────
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
    retain: (id) => makeReference(id),
  }
}

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
    tabsIn: () => [],
    mounted: { getSnapshot: () => MAIN_A, subscribe: () => () => undefined },
  }
}

const sidebar = makeSidebar()

/** Programmable deps: every call is recorded; outcomes are scripted per test. */
function makeDeps() {
  const log = { create: [], reclaim: [], dispose: [] }
  const modes = { create: 'ok', reclaim: 'gone', dispose: 'ok' }
  const deferreds = []
  const deps = {
    sessions: makeSessions(),
    retainSource: 'auxChatPanel',
    client: {
      get: (name) => (name === 'sidebarRight' ? sidebar : undefined),
    },
    closeTimeoutMs: 60,
    async create(auxSessionId, cwd, mainSessionId) {
      log.create.push({ auxSessionId, cwd, mainSessionId })
      if (modes.create === 'defer') {
        await new Promise((resolve) => deferreds.push({ auxSessionId, resolve }))
      } else if (modes.create === 'fail') {
        throw new Error('aux-chat/internal: boom')
      }
      return { cwd, warnings: [], downgrade: 'summary', hostGeneration: 'gen-host-1' }
    },
    async reclaim(auxSessionId, mainSessionId) {
      log.reclaim.push({ auxSessionId, mainSessionId })
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
  return { deps, log, modes, deferreds }
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

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
  controller.requestClose('tab-1')
  check('C02: confirm copy names A (not the currently mounted B)', runtime.mainTitle === '主会话A：重构调研', String(runtime.mainTitle))
  check('C02: confirming is bound to the captured tab', runtime.closeState === 'confirming', runtime.closeState)
  await controller.confirmClose('tab-1', false)
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
  await Promise.all(Array.from({ length: 10 }, () => controller.confirmClose('tab-1', false)))
  await settle()
  const disposes = harness.log.dispose.filter((d) => d.auxSessionId === runtime.sessionId)
  check('C05: exactly one dispose ran for the confirmed close', disposes.length === 1, String(disposes.length))
  check('C05: the runtime closed exactly once', controller.tabRuntime('tab-1')?.phase === 'closed', controller.tabRuntime('tab-1')?.phase)
}

// ══ C06: failing close keeps the tab; retry reuses the operationId (E07) ═══
{
  const { controller, harness, runtime } = await readyRuntime()
  runtime.hasOwnTurn = true
  harness.modes.dispose = 'fail'
  await controller.confirmClose('tab-1', false)
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

// ══ C07: a hanging close trips the watchdog (§6.3) ═════════════════════════
{
  const { controller, harness } = await readyRuntime()
  harness.modes.dispose = 'hang'
  const t0 = Date.now()
  const inFlight = controller.confirmClose('tab-1', false) // not awaited yet
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
  await controller.confirmClose('tab-1', false)
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
  await controller2.confirmClose('tab-1', false)
  await settle()
  check('C08: stale-generation converges to closed (host restart ended the resource)', controller2.tabRuntime('tab-1')?.phase === 'closed', controller2.tabRuntime('tab-1')?.phase)
}

// ══ C09: empty+idle closes directly; a queued submission confirms (§6.3) ═══
{
  const { controller, runtime } = await readyRuntime()
  check('C09: empty+idle closes without confirmation', controller.closeNeedsConfirmation('tab-1') === false, '')
  runtime.hasQueue = true
  check('C09: a queued submission requires confirmation', controller.closeNeedsConfirmation('tab-1') === true, '')
  runtime.hasQueue = false
  runtime.hasOwnTurn = true
  check('C09: own history requires confirmation', controller.closeNeedsConfirmation('tab-1') === true, '')
  let vetoed = false
  try {
    controller.handleTabClose({ id: 'tab-1', kind: 'aux-chat' })
  } catch (error) {
    vetoed = error?.name === 'AuxChatCloseVeto'
  }
  check('C09: the veto fires through the shipped close admission', vetoed, String(vetoed))
  controller.cancelClose('tab-1')
  controller.closeTabSession('tab-1', 'check done')
  await settle()
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
  await controller.confirmClose('tab-1', false)
  await settle()
  const dispose = harness.log.dispose.at(-1)
  check('C12: dispose carried hostGeneration=gen-host-1 and an operationId', dispose?.options?.hostGeneration === 'gen-host-1' && typeof dispose?.options?.operationId === 'string', JSON.stringify(dispose?.options))
}

// ── report ──────────────────────────────────────────────────────────────────
const passed = checks.filter((c) => c.ok).length
console.log(`race-check: ${passed}/${checks.length} checks passed`)
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
