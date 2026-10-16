/**
 * Root-level auxiliary chat controller.
 *
 * Path B (the live path) keys every auxiliary session by the shipped right
 * Sidebar's TAB id: one host tab owns one auxiliary session for its whole
 * life. The controller owns the PRD tab-surface behaviours:
 *
 * - 打开 is idempotent — an existing auxiliary tab is focused, never
 *   duplicated (`tabsIn` + `focus`); 新建 is the explicit `openTab` action.
 * - 收起 / 切标签 / 切主会话 never destroy; only the tab's own close gesture
 *   removes. Decision 2026-10-16 (refactor plan v2): close is SILENT — no
 *   confirmation dialog, no risk warnings; the close PROTOCOL
 *   stays strict (dispose-before-removal, operation-id retry, watchdog).
 * - A response completing in the background marks the tab unread; focus
 *   clears it.
 *
 * Path A (the frame-owned column, used only when the shipped Sidebar is
 * absent) keeps a smaller tab model in the same store.
 * @module client/store
 */
import type {
  ClientContextLike,
  Disposable,
  SessionReferenceLike,
  SessionsLike,
  SidebarRightLike,
  SidebarTabLike,
} from './types.ts'
import { msg } from '../locale.ts'

export const AUX_TAB_KIND = 'aux-chat'

/** Mint the durable auxiliary identity the Host expects (`session-` + UUID). */
export function newSessionId(): string {
  const webCrypto = globalThis.crypto
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === 'function') {
    return `session-${webCrypto.randomUUID()}`
  }
  const hex = '0123456789abcdef'
  let out = ''
  for (let index = 0; index < 36; index += 1) out += hex[Math.floor(Math.random() * 16)]
  return `session-${out}`
}

/** Render any thrown value as a readable line. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** Handoff result the panel renders. */
export interface HandoffOutcome {
  readonly ok: boolean
  readonly message: string
}

/** Host init result. */
export interface AuxCreateOutcome {
  readonly cwd: string
  readonly warnings: readonly string[]
  /** `full` = the complete committed transcript was injected (form A). */
  readonly downgrade: 'full' | 'summary' | 'none'
  /**
   * What was actually DELIVERED to this session's model context: the transcript
   * window, the condensed digest, or nothing. The panel states this verbatim —
   * claiming a mirror that failed is the defect observed on 2026-10-14.
   */
  readonly inherited: AuxInheritedReport
  /** Host boot generation that owns the resource (PRD v2.0 §4.2). */
  readonly hostGeneration?: string
  /** Parent model-route snapshot reported by the mirror plan. */
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  /** True when an existing live child was re-attached instead of created. */
  readonly reclaimed?: boolean
}

/** Delivered-inheritance report (shape frozen by `src/contract.ts`). */
export interface AuxInheritedReport {
  readonly form: 'full' | 'summary' | 'none'
  readonly entries: number
  readonly chars: number
  readonly truncated: boolean
  readonly omitted: number
}

/**
 * Lifecycle of one tab-owned auxiliary session (PRD v2.0 §7 state machine).
 *
 * `creating` → `ready` → (`closing` → `closed` | `closing` → `closeFailed`
 * → `closing`) and `creating` → `failed` → `creating` (retry). `ended` is the
 * display state for a resource that no longer exists behind a surviving tab
 * (host restart / reclaim refusal): read-only, with an explicit 新建 entry
 * that mints a NEW resource generation.
 */
export type TabSessionPhase = 'creating' | 'ready' | 'failed' | 'closing' | 'closeFailed' | 'closed' | 'ended'

/**
 * Outcome of a re-attach attempt against a previously bound child.
 * `gone` means the resource definitively no longer exists on this Host.
 */
export type ReclaimOutcome = { readonly kind: 'reclaimed'; readonly outcome: AuxCreateOutcome } | { readonly kind: 'gone' }

/** Everything the controller knows about one host tab. */
export interface AuxTabRuntime {
  readonly tabId: string
  readonly signal: AbortSignal
  /** Content identity of the host tab (`contentId`, falling back to its id). */
  readonly tabKey: string | undefined
  /** The main session captured when the tab's session was first ensured (R01). */
  readonly mainSessionId: string
  cwd: string
  name: string
  sessionId: string | undefined
  phase: TabSessionPhase
  message: string | undefined
  warnings: readonly string[]
  downgrade: 'full' | 'summary' | 'none'
  /** Delivered inheritance of the CURRENT resource (panel-facing truth). */
  inherited: AuxInheritedReport | undefined
  unread: boolean
  running: boolean
  hasOwnTurn: boolean
  /** An unsent submission is queued on the child (silent close aborts it). */
  hasQueue: boolean
  bypassNextClose: boolean
  disposed: boolean
  unsubscribeSnapshot: Disposable | undefined
  /** Model route inherited at creation (plan P1: surfaced in the fact bar). */
  model: string | undefined
  /**
   * Creation generation of THIS runtime's current resource attempt. Every
   * async continuation carries the epoch it started with and is dropped when
   * the runtime has moved on (retry, ended-restart) — the guard that keeps a
   * late result from installing into a newer instance of the same tab id
   * (PRD v2.0 T05/E06/R10).
   */
  epoch: number
  /** Host boot generation captured at create/reclaim time (T12). */
  hostGeneration: string | undefined
  /** Client-minted close-operation id; retries reuse the SAME id (§6.3/§9). */
  closeOperationId: string | undefined
  /** Last close failure text, shown with the 重试关闭 affordance. */
  closeError: string | undefined
  /** Main-session title captured when confirmation opened, bound to A (V10). */
  mainTitle: string | undefined
  /** Why an `ended` tab ended. */
  endedReason: string | undefined
}

/** Path-A tab row. */
export interface AuxTabState {
  readonly sessionId: string
  readonly mirrorOf: string
  readonly cwd: string
  readonly createdAt: number
  readonly warnings: readonly string[]
}

/** Snapshot the UI subscribes to. */
export interface AuxChatState {
  readonly shown: boolean
  readonly tabs: readonly AuxTabState[]
  readonly activeId: string | undefined
  readonly mainSessionId: string | undefined
  readonly status: string | undefined
  readonly busy: boolean
  readonly tabRuntimes: ReadonlyMap<string, AuxTabRuntime>
}

/**
 * Thrown synchronously from the shipped close handler so the framework does
 * NOT remove the tab itself: the silent close protocol owns removal and runs
 * dispose first (a throw is the only channel that preserves the tab while the
 * protocol is in flight).
 */
export class CloseVetoError extends Error {
  constructor() {
    super('aux-chat: the silent close protocol owns this removal')
    this.name = 'AuxChatCloseVeto'
  }
}

const OWNER_KEY = 'aux-chat.owner'

/** Construction input. */
export interface AuxChatDeps {
  sessions: SessionsLike
  retainSource: string
  /**
   * Create the child for one main session and return its SERVER-MINTED id
   * with the init outcome (v3: fork + /aux-init live behind this call).
   */
  create(cwd: string, mainSessionId: string): Promise<AuxCreateOutcome & { sessionId: string }>
  /** Re-attach to a previously bound live child; `gone` = it no longer exists. */
  reclaim(auxSessionId: string, mainSessionId: string): Promise<ReclaimOutcome>
  dispose(auxSessionId: string, options?: { operationId?: string; hostGeneration?: string }): Promise<void>
  handoff(auxSessionId: string, mainSessionId: string): Promise<HandoffOutcome>
  present(shown: boolean): void
  client: ClientContextLike
  /** Close watchdog (PRD §6.3: 30s); overridable so offline checks can fake it. */
  closeTimeoutMs?: number
}

/** The root controller. */
export class AuxChatController {
  shown = false
  tabs: AuxTabState[] = []
  activeId: string | undefined
  mainSessionId: string | undefined
  status: string | undefined
  busy = false
  tabRuntimes = new Map<string, AuxTabRuntime>()

  private listeners = new Set<() => void>()
  private references = new Map<string, SessionReferenceLike>()

  constructor(private readonly deps: AuxChatDeps) {}

  /** The shipped right Sidebar navigation face, when mounted. */
  get sidebarRight(): SidebarRightLike | undefined {
    try {
      const face = this.deps.client.get('sidebarRight') as SidebarRightLike | undefined
      return face !== undefined && typeof face.openTab === 'function' ? face : undefined
    } catch {
      return undefined
    }
  }

  // ── store protocol ─────────────────────────────────────────────────────

  /**
   * Identity-bearing snapshot. `useSyncExternalStore` only re-renders when the
   * snapshot REFERENCE changes, and the controller itself is a stable object —
   * so every update mints a new revision token for the hook to compare.
   */
  private revision = 0
  private snapshot = { revision: 0 }
  getSnapshot = (): { revision: number } => this.snapshot
  subscribe = (listener: () => void): Disposable => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch?: Partial<AuxChatState>): void {
    if (patch !== undefined) Object.assign(this, patch)
    this.tabRuntimes = new Map(this.tabRuntimes)
    this.revision += 1
    this.snapshot = { revision: this.revision }
    for (const listener of [...this.listeners]) listener()
  }

  private cwdOf(mainSessionId: string): string {
    try {
      const row = this.deps.sessions.list.getSnapshot().byId[mainSessionId]
      return typeof row?.cwd === 'string' ? row.cwd : ''
    } catch {
      return ''
    }
  }

  private findAuxTabs(mainSessionId: string): readonly SidebarTabLike[] {
    const sidebar = this.sidebarRight
    if (sidebar === undefined) return []
    try {
      return sidebar.tabsIn(mainSessionId).filter((tab) => tab.kind === AUX_TAB_KIND)
    } catch {
      return []
    }
  }

  // ── 打开 / 新建 (PRD R01, B06) ──────────────────────────────────────────

  /** 打开: focus the existing auxiliary tab or create the first one. */
  openOrFocus(mainSessionId: string | undefined): void {
    const sidebar = this.sidebarRight
    if (mainSessionId === undefined || sidebar === undefined) {
      this.setMainSession(mainSessionId)
      this.setShown(true)
      return
    }
    const existing = this.findAuxTabs(mainSessionId)[0]
    if (existing !== undefined) {
      sidebar.focus(existing.id)
      if (!sidebar.isExpanded()) sidebar.toggleExpanded()
      this.markSeen(existing.id)
      return
    }
    // `replaceTab` must name a REAL tab id (the shipped guide passes its own
    // id at sbr.js:6580); a literal `true` is read as a tab named "true" and
    // the layout rejects the whole open with "tab true has no pane".
    const guideTab = (() => {
      try {
        return sidebar.tabsIn(mainSessionId).find((tab) => tab.kind === 'guide')
      } catch {
        return undefined
      }
    })()
    sidebar.openTab(AUX_TAB_KIND, guideTab === undefined ? undefined : { replaceTab: guideTab.id })
    if (!sidebar.isExpanded()) sidebar.toggleExpanded()
  }

  /** 新建: always open another auxiliary tab. */
  openNew(mainSessionId: string | undefined, paneId?: string): void {
    const sidebar = this.sidebarRight
    if (sidebar === undefined) {
      void this.createTab(mainSessionId)
      return
    }
    sidebar.openTab(AUX_TAB_KIND, paneId === undefined ? undefined : { paneId })
    if (!sidebar.isExpanded()) sidebar.toggleExpanded()
  }

  // ── Path B tab lifecycle ───────────────────────────────────────────────

  /**
   * Whether `runtime` is still the live mapping for its tab AND still on the
   * creation generation `epoch` (when given). This object-identity check is
   * the PRD v2.0 T05/R10 guard: a continuation that outlived a retry or a
   * same-tab-id re-open must drop its result instead of installing it into
   * the newer instance.
   */
  private isCurrent(runtime: AuxTabRuntime, epoch?: number): boolean {
    if (this.tabRuntimes.get(runtime.tabId) !== runtime) return false
    if (epoch !== undefined && runtime.epoch !== epoch) return false
    return true
  }

  /** Bind one host tab to exactly one auxiliary session. */
  ensureTabSession(signal: AbortSignal, info: { tabId: string; mainSessionId: string | undefined; tabKey?: string }): void {
    if (this.tabRuntimes.has(info.tabId)) return
    const mainSessionId = info.mainSessionId
    if (mainSessionId === undefined) return
    const cwd = this.cwdOf(mainSessionId)
    const ordinal = [...this.tabRuntimes.values()].filter((runtime) => runtime.mainSessionId === mainSessionId).length + 1
    const runtime: AuxTabRuntime = {
      tabId: info.tabId,
      signal,
      tabKey: info.tabKey ?? info.tabId,
      mainSessionId,
      cwd,
      name: ordinal === 1 ? msg('tabName') : msg('tabNameN', { n: ordinal }),
      sessionId: undefined,
      phase: 'creating',
      message: undefined,
      warnings: [],
      downgrade: 'summary',
      inherited: undefined,
      unread: false,
      running: false,
      hasOwnTurn: false,
      hasQueue: false,
      bypassNextClose: false,
      disposed: false,
      unsubscribeSnapshot: undefined,
      model: undefined,
      epoch: 1,
      hostGeneration: undefined,
      closeOperationId: undefined,
      closeError: undefined,
      mainTitle: undefined,
      endedReason: undefined,
    }
    this.tabRuntimes.set(info.tabId, runtime)
    this.update()
    void this.startTabSession(runtime)
    signal.addEventListener(
      'abort',
      () => {
        this.closeTabSession(info.tabId, 'tab closed')
      },
      { once: true },
    )
  }

  private async startTabSession(runtime: AuxTabRuntime): Promise<void> {
    const epoch = runtime.epoch
    // Re-attach first: a tab that already owns a live child (page reload
    // within the same Host boot) restores THAT child — it must not fork a
    // second one (PRD v2.0 §7.1 / E12 / T16).
    const hint = this.readBinding(runtime)
    if (hint !== undefined) {
      runtime.sessionId = hint.sessionId
      runtime.hostGeneration = hint.hostGeneration
      this.update()
      let reclaim: ReclaimOutcome
      try {
        reclaim = await this.deps.reclaim(hint.sessionId, runtime.mainSessionId)
      } catch (error) {
        if (!this.isCurrent(runtime, epoch) || runtime.signal.aborted) return
        runtime.sessionId = undefined
        runtime.hostGeneration = undefined
        this.patchTab(runtime.tabId, { phase: 'failed', message: msg('statusReclaimFailed', { error: describeError(error) }) })
        return
      }
      if (!this.isCurrent(runtime, epoch) || runtime.signal.aborted) {
        // The tab went away mid-reclaim: put the child back down.
        if (reclaim.kind === 'reclaimed') void this.deps.dispose(hint.sessionId).catch(() => undefined)
        return
      }
      if (reclaim.kind === 'reclaimed') {
        const reference = this.bindReference(runtime, hint.sessionId, reclaim.outcome, epoch)
        if (reference !== undefined) return
        // retain failed below the reclaim: the resource is alive but this
        // client cannot bind it — surface as a normal failure with retry.
        runtime.sessionId = undefined
        this.patchTab(runtime.tabId, { phase: 'failed', message: msg('statusReclaimBindFailed') })
        return
      }
      // The child is gone (Host restart swept it, or reclaim was refused).
      // This tab shows the ENDED state with an explicit 新建 entry — it must
      // NOT silently mint a replacement (T16: 不复活、不 fork).
      this.clearBinding(runtime)
      runtime.sessionId = undefined
      runtime.hostGeneration = undefined
      this.patchTab(runtime.tabId, {
        phase: 'ended',
        endedReason: msg('endedReasonGone'),
      })
      return
    }

    // The child id is SERVER-MINTED (fork): it exists only once the round-trip
    // resolves, so the late-success rollback below keys on the RESPONSE id.
    let created: AuxCreateOutcome & { sessionId: string }
    try {
      created = await this.deps.create(runtime.cwd, runtime.mainSessionId)
    } catch (error) {
      if (!this.isCurrent(runtime, epoch) || runtime.signal.aborted) return
      runtime.sessionId = undefined
      this.patchTab(runtime.tabId, { phase: 'failed', message: describeError(error) })
      return
    }
    const sessionId = created.sessionId
    if (!this.isCurrent(runtime, epoch) || runtime.signal.aborted) {
      // A late success after the pending tab closed or was superseded rolls
      // back the child it created and installs nothing (E06/T04/R09). The
      // child was fully initialized by now, so /aux-end converges it.
      void this.deps.dispose(sessionId).catch(() => undefined)
      return
    }
    this.bindReference(runtime, sessionId, created, epoch)
  }

  /**
   * Retain + finalize one ready session for `runtime`; no-op (returning
   * `undefined`) when the runtime moved on while the caller awaited.
   */
  private bindReference(runtime: AuxTabRuntime, sessionId: string, outcome: AuxCreateOutcome, epoch: number): SessionReferenceLike | undefined {
    let reference: SessionReferenceLike
    try {
      reference = this.deps.sessions.retain(sessionId, { source: this.deps.retainSource })
      void reference.ready.catch(() => undefined)
    } catch {
      return undefined
    }
    if (!this.isCurrent(runtime, epoch)) {
      try {
        reference.release()
      } catch {
        /* contained at the reference layer */
      }
      return undefined
    }
    this.references.set(sessionId, reference)
    runtime.sessionId = sessionId
    runtime.cwd = outcome.cwd || runtime.cwd
    runtime.warnings = outcome.warnings
    runtime.downgrade = outcome.downgrade
    runtime.inherited = outcome.inherited
    runtime.hostGeneration = outcome.hostGeneration
    runtime.model = outcome.model
    runtime.phase = 'ready'
    runtime.message = undefined
    runtime.closeError = undefined
    runtime.endedReason = undefined
    this.writeBinding(runtime)
    this.observeRuntime(runtime, reference)
    this.update()
    return reference
  }

  private observeRuntime(runtime: AuxTabRuntime, reference: SessionReferenceLike): void {
    const session = reference.binding.session as unknown as
      | {
          getSnapshot?(): { running?: boolean; promptAttempted?: boolean; pendingSubmissions?: readonly unknown[] }
          subscribe?(listener: () => void): Disposable
        }
      | undefined
    if (session?.subscribe === undefined || session.getSnapshot === undefined) return
    const apply = (): void => {
      const snapshot = session.getSnapshot?.()
      if (snapshot === undefined) return
      if (snapshot.promptAttempted === true) runtime.hasOwnTurn = true
      // Unsent queued submissions count as work-in-flight: a silent close
      // aborts them with the turn (plan v2 decision), and the close card
      // names the target while the protocol runs.
      runtime.hasQueue = Array.isArray(snapshot.pendingSubmissions) && snapshot.pendingSubmissions.length > 0
      const wasRunning = runtime.running
      runtime.running = snapshot.running === true
      // A completion marks the tab unread ONLY when it is not the tab the user
      // is looking at; an active or running tab never carries the mark.
      if (wasRunning && !runtime.running && !this.isActive(runtime.tabId)) runtime.unread = true
      if (runtime.running || this.isActive(runtime.tabId)) runtime.unread = false
      this.update()
    }
    runtime.unsubscribeSnapshot = session.subscribe(apply)
    apply()
  }

  private isActive(tabId: string): boolean {
    try {
      return this.sidebarRight?.active()?.id === tabId
    } catch {
      return false
    }
  }

  markSeen(tabId: string): void {
    const runtime = this.tabRuntimes.get(tabId)
    if (runtime !== undefined && runtime.unread) {
      runtime.unread = false
      this.update()
    }
  }

  retryTabSession(tabId: string): void {
    const runtime = this.tabRuntimes.get(tabId)
    if (runtime === undefined || runtime.phase !== 'failed') return
    const failedId = runtime.sessionId
    // A NEW creation generation: the in-flight attempt (if any) must lose its
    // right to install into this runtime when it finally settles (T05).
    runtime.epoch += 1
    runtime.phase = 'creating'
    runtime.message = undefined
    runtime.sessionId = undefined
    runtime.hostGeneration = undefined
    this.update()
    if (failedId !== undefined) {
      this.clearBinding(runtime)
      this.releaseReference(failedId)
      void this.deps.dispose(failedId).catch(() => undefined)
    }
    void this.startTabSession(runtime)
  }

  /**
   * Start a NEW resource generation in an `ended` (or lingering `closed`)
   * tab (PRD v2.0 §7: closed is terminal; reopening must be a new
   * generation, never a revival).
   */
  restartTabSession(tabId: string): void {
    const runtime = this.tabRuntimes.get(tabId)
    if (runtime === undefined || (runtime.phase !== 'ended' && runtime.phase !== 'closed')) return
    runtime.epoch += 1
    runtime.phase = 'creating'
    runtime.endedReason = undefined
    runtime.message = undefined
    runtime.sessionId = undefined
    runtime.hostGeneration = undefined
    this.clearBinding(runtime)
    this.update()
    void this.startTabSession(runtime)
  }

  // ── silent close protocol (plan v2 decision 2026-10-16) ────

  /**
   * The shipped close handler invokes this before any tab removal. Silent by
   * product decision: every close gesture starts the protocol immediately —
   * no confirmation dialog, no risk warning. The veto keeps the tab until the
   * protocol itself removes it (or records a failure), which is what makes
   * "dispose before removal" possible under the shipped tab system.
   */
  handleTabClose(tab: SidebarTabLike): void {
    const runtime = this.tabRuntimes.get(tab.id)
    if (runtime === undefined) return
    if (runtime.bypassNextClose) {
      runtime.bypassNextClose = false
      return
    }
    if (runtime.phase === 'closing' || runtime.phase === 'closed') {
      // A close already owns the cleanup; the tab may go.
      return
    }
    if (runtime.phase === 'closeFailed') {
      // The X on a failed-close tab re-attempts the SAME close operation on
      // the SAME resource generation (§9: 重试固定同一 operationId 与资源代次).
      // The tab stays until that attempt settles.
      void this.startClose(tab.id)
      throw new CloseVetoError()
    }
    if (runtime.sessionId === undefined) {
      // Nothing owned yet (creating / failed): allow the removal; the abort
      // listener and the late-success rollback clean any child that appears.
      return
    }
    void this.startClose(tab.id)
    throw new CloseVetoError()
  }

  /** Human label for the closing / failure copy: “A 的 a”. */
  targetLabel(runtime: AuxTabRuntime): string {
    const main = runtime.mainTitle ?? runtime.mainSessionId
    return msg('targetLabel', { main, name: runtime.name })
  }

  /** The title of one main session, read by id (never by current selection). */
  private titleOf(mainSessionId: string): string | undefined {
    try {
      const row = this.deps.sessions.list.getSnapshot().byId[mainSessionId]
      const title = row?.title ?? row?.displayTitle
      return typeof title === 'string' && title !== '' ? title : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Silent close: the cleanup responsibility is taken synchronously (phase
   * flips to `closing` in the same task), the Host dispose runs against the
   * CAPTURED child + host generation, and the tab is removed only after the
   * Host acknowledged. Failures keep the tab, record the exact target, and
   * offer 重试关闭 with the SAME operation id.
   */
  async startClose(tabId: string): Promise<void> {
    const runtime = this.tabRuntimes.get(tabId)
    if (runtime === undefined || runtime.sessionId === undefined) return
    // Idempotent (T14): a closing/closed tab ignores further clicks, and only
    // a ready or previously failed close can start one.
    if (runtime.phase === 'closing' || runtime.phase === 'closed') return
    if (runtime.phase !== 'ready' && runtime.phase !== 'closeFailed') return
    const sessionId = runtime.sessionId
    // A retry reuses the SAME operation id and resource generation (§9).
    const operationId = runtime.closeOperationId ?? `close-${newSessionId()}`
    runtime.closeOperationId = operationId
    runtime.closeError = undefined
    runtime.mainTitle = this.titleOf(runtime.mainSessionId)
    runtime.phase = 'closing'
    this.update() // synchronous feedback, well under the 100ms target
    const timeoutMs = this.deps.closeTimeoutMs ?? 30_000
    const watchdog: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (this.isCurrent(runtime) && runtime.phase === 'closing') {
        runtime.phase = 'closeFailed'
        runtime.closeError = msg('closeTimeout', { seconds: Math.max(1, Math.round(timeoutMs / 1000)) })
        this.update({ status: msg('statusClosing', { target: this.targetLabel(runtime) }) })
      }
    }, timeoutMs)
    try {
      await this.deps.dispose(sessionId, {
        operationId,
        ...(runtime.hostGeneration === undefined ? {} : { hostGeneration: runtime.hostGeneration }),
      })
    } catch (error) {
      const text = describeError(error)
      clearTimeout(watchdog)
      if (this.isAlreadyClosed(text)) {
        // Converged elsewhere (swept after a Host restart, or a racing close
        // finished first): the resource is gone; fall through to closed.
      } else {
        if (!this.isCurrent(runtime)) return
        runtime.phase = 'closeFailed'
        runtime.closeError = text
        this.update({ status: msg('statusCloseFailed', { target: this.targetLabel(runtime), error: text }) })
        return
      }
    }
    clearTimeout(watchdog)
    this.clearBinding(runtime)
    this.releaseReference(sessionId)
    if (!this.isCurrent(runtime)) return
    runtime.disposed = true
    runtime.phase = 'closed'
    runtime.bypassNextClose = true
    try {
      const sidebar = this.sidebarRight
      // Bound removal: the tab is removed from ITS owner session (A), not
      // from whatever is currently mounted (R03/R04).
      if (sidebar?.closeIn !== undefined) sidebar.closeIn(runtime.mainSessionId, tabId)
      else sidebar?.close(tabId)
    } catch {
      /* the abort listener performs the same bookkeeping */
    }
    this.update()
  }

  /** Retry a failed close: same operation id, same resource generation. */
  retryClose(tabId: string): void {
    const runtime = this.tabRuntimes.get(tabId)
    if (runtime === undefined || runtime.phase !== 'closeFailed') return
    void this.startClose(tabId)
  }

  /** Whether a close error means the resource is already gone/converged. */
  private isAlreadyClosed(text: string): boolean {
    return /aux-chat\/(not-registered|stale-generation)/.test(text)
  }

  /**
   * Single source of truth for panel-wide indicators (plan P0/WP0.5): the
   * header broadcast, the guide bubble and the header dot all read THIS, so
   * they can never disagree (the v2 report's same-screen contradiction).
   */
  indicators(): { live: number; unread: number; running: number } {
    let live = 0
    let unread = 0
    let running = 0
    for (const runtime of this.tabRuntimes.values()) {
      if (runtime.phase === 'closed' || runtime.phase === 'ended') continue
      live += 1
      if (runtime.unread) unread += 1
      if (runtime.running) running += 1
    }
    return { live, unread, running }
  }

  /** The one automatic destruction edge: the tab record disappeared. */
  closeTabSession(tabId: string, reason: string): void {
    const runtime = this.tabRuntimes.get(tabId)
    if (runtime === undefined) return
    this.tabRuntimes.delete(tabId)
    runtime.unsubscribeSnapshot?.()
    const sessionId = runtime.sessionId
    if (sessionId !== undefined) this.releaseReference(sessionId)
    this.clearBinding(runtime)
    // A confirmed close already owns the in-flight dispose (and a closed one
    // finished it); only an UNCONFIRMED removal destroys here.
    if (!runtime.disposed && sessionId !== undefined && runtime.phase !== 'closing' && runtime.phase !== 'closed') {
      void this.deps.dispose(sessionId).catch(() => undefined)
    }
    this.update({ status: msg('statusClosed', { reason }) })
  }

  // ── reload-binding persistence (PRD v2.0 §7.1) ──────────────────────────

  /**
   * Per-window owner credential. `sessionStorage` survives a reload of the
   * SAME tab but is not shared with a second window, which is exactly the
   * ownership boundary §7.1 asks for: another window reading a shared layout
   * finds no binding under ITS owner id and starts its own instance.
   */
  private ownerId(): string | undefined {
    try {
      const store = globalThis.sessionStorage
      if (store === undefined || store === null) return undefined
      const existing = store.getItem(OWNER_KEY)
      if (existing !== null && existing !== '') return existing
      const minted = `owner-${newSessionId()}`
      store.setItem(OWNER_KEY, minted)
      return minted
    } catch {
      return undefined
    }
  }

  private bindingKey(runtime: AuxTabRuntime): string | undefined {
    if (runtime.tabKey === undefined) return undefined
    const owner = this.ownerId()
    return owner === undefined ? undefined : `aux-chat.binding.${owner}.${runtime.tabKey}`
  }

  /**
   * The tab→child binding recorded when this window's pane last became
   * ready. Validated against the CAPTURED parent before use, so a hint that
   * names another parent's child is ignored rather than trusted.
   */
  private readBinding(runtime: AuxTabRuntime): { sessionId: string; mirrorOf: string; hostGeneration: string | undefined } | undefined {
    const key = this.bindingKey(runtime)
    if (key === undefined) return undefined
    try {
      const raw = globalThis.localStorage?.getItem(key)
      if (raw === null || raw === '') return undefined
      const parsed = JSON.parse(raw) as { sessionId?: unknown; mirrorOf?: unknown; hostGeneration?: unknown }
      if (typeof parsed.sessionId !== 'string' || parsed.sessionId === '') return undefined
      if (parsed.mirrorOf !== runtime.mainSessionId) return undefined
      return {
        sessionId: parsed.sessionId,
        mirrorOf: parsed.mirrorOf as string,
        hostGeneration: typeof parsed.hostGeneration === 'string' ? parsed.hostGeneration : undefined,
      }
    } catch {
      return undefined
    }
  }

  private writeBinding(runtime: AuxTabRuntime): void {
    const key = this.bindingKey(runtime)
    if (key === undefined || runtime.sessionId === undefined) return
    try {
      globalThis.localStorage?.setItem(
        key,
        JSON.stringify({ sessionId: runtime.sessionId, mirrorOf: runtime.mainSessionId, hostGeneration: runtime.hostGeneration ?? null }),
      )
    } catch {
      /* storage is a hint, never a source of truth */
    }
  }

  private clearBinding(runtime: AuxTabRuntime): void {
    const key = this.bindingKey(runtime)
    if (key === undefined) return
    try {
      globalThis.localStorage?.removeItem(key)
    } catch {
      /* best effort */
    }
  }

  private releaseReference(sessionId: string): void {
    const reference = this.references.get(sessionId)
    if (reference === undefined) return
    this.references.delete(sessionId)
    try {
      reference.release()
    } catch {
      /* double release is contained at the reference layer */
    }
  }

  private patchTab(tabId: string, patch: Partial<AuxTabRuntime>): void {
    const runtime = this.tabRuntimes.get(tabId)
    if (runtime === undefined) return
    Object.assign(runtime, patch)
    this.update()
  }

  tabRuntime(tabId: string | undefined): AuxTabRuntime | undefined {
    return tabId === undefined ? undefined : this.tabRuntimes.get(tabId)
  }

  /** The retained reference for one session, for the React pane binding. */
  referenceFor(sessionId: string | undefined): SessionReferenceLike | undefined {
    return sessionId === undefined ? undefined : this.references.get(sessionId)
  }

  /**
   * Whether one main session currently sits in the workspace archive set.
   * SOFT HINT only (E11): the platform does not cascade archiving to
   * non-subagent lineage, so the auxiliary child keeps running — the panel
   * tells the user the reference parent is archived, nothing more.
   */
  isMainArchived(mainSessionId: string | undefined): boolean {
    if (mainSessionId === undefined) return false
    try {
      const workspaces = this.deps.client.get('workspaces') as
        | { list?: { getSnapshot?: () => { archivedSessionIds?: readonly string[] } } }
        | undefined
      const ids = workspaces?.list?.getSnapshot?.()?.archivedSessionIds
      return Array.isArray(ids) && ids.includes(mainSessionId)
    } catch {
      return false
    }
  }

  /** Whether a session is one of THIS plugin's auxiliary sessions. */
  isAuxSession(sessionId: string | undefined): boolean {
    if (sessionId === undefined) return false
    if (this.tabs.some((tab) => tab.sessionId === sessionId)) return true
    for (const runtime of this.tabRuntimes.values()) {
      if (runtime.sessionId === sessionId) return true
    }
    return false
  }

  // ── draft handoff (never sends into the main session) ──────────────────

  async handoff(sessionId: string, mainSessionId: string): Promise<HandoffOutcome> {
    try {
      return await this.deps.handoff(sessionId, mainSessionId)
    } catch (error) {
      return { ok: false, message: msg('statusCopyFailed', { error: describeError(error) }) }
    }
  }

  // ── Path A (frame-owned column, shipped-Sidebar-absent fallback) ────────

  attachMain(): void {
    if (this.mainSessionId !== undefined) this.update()
  }
  setMainSession(sessionId: string | undefined): void {
    if (this.mainSessionId === sessionId) return
    this.mainSessionId = sessionId
    this.update()
  }
  setShown(shown: boolean): void {
    this.shown = shown
    try {
      this.deps.present(shown)
    } catch (error) {
      this.update({ status: msg('statusGeometry') })
    }
  }
  toggleShown(): void {
    this.setShown(!this.shown)
  }
  /** Idempotent focus-or-create for the frame column. */
  openForMain(mainSessionId: string | undefined): void {
    const existing = mainSessionId === undefined ? undefined : this.tabs.find((tab) => tab.mirrorOf === mainSessionId)
    if (existing !== undefined) {
      if (this.activeId !== existing.sessionId) this.update({ activeId: existing.sessionId, status: undefined })
      this.setShown(true)
      return
    }
    if (mainSessionId === undefined) {
      this.update({ status: msg('statusNoMain') })
      return
    }
    void this.createTab(mainSessionId)
  }
  async createTab(mainSessionId: string | undefined): Promise<void> {
    if (mainSessionId === undefined) {
      this.update({ status: msg('statusNoMain') })
      return
    }
    if (this.busy) return
    this.busy = true
    this.update({ status: msg('statusPreparing') })
    try {
      const outcome = await this.deps.create(this.cwdOf(mainSessionId), mainSessionId)
      const sessionId = outcome.sessionId
      const reference = this.deps.sessions.retain(sessionId, { source: this.deps.retainSource })
      void reference.ready.catch(() => undefined)
      this.references.set(sessionId, reference)
      this.tabs = [...this.tabs, { sessionId, mirrorOf: mainSessionId, cwd: outcome.cwd, createdAt: Date.now(), warnings: outcome.warnings }]
      this.activeId = sessionId
      this.busy = false
      this.update({
        status: outcome.warnings.length === 0 ? undefined : msg('statusMirrorWarnings', { warnings: outcome.warnings.join('；') }),
      })
      this.setShown(true)
    } catch (error) {
      this.busy = false
      this.update({ status: msg('statusCreateFailed', { error: describeError(error) }) })
    }
  }
  activate(sessionId: string): void {
    if (this.activeId !== sessionId) this.update({ activeId: sessionId, status: undefined })
  }
  closeTab(sessionId: string): void {
    this.update({
      tabs: this.tabs.filter((tab) => tab.sessionId !== sessionId),
      activeId: this.activeId === sessionId ? this.tabs[this.tabs.length - 2]?.sessionId : this.activeId,
      status: undefined,
    })
    this.releaseReference(sessionId)
    void this.deps.dispose(sessionId).catch((error: unknown) => {
      this.update({ status: msg('statusDisposeFailed', { error: describeError(error) }) })
    })
  }
  endActiveSession(): void {
    if (this.activeId !== undefined) this.closeTab(this.activeId)
    this.setShown(false)
  }
  async flushOnUnload(): Promise<void> {
    for (const tab of this.tabs) {
      try {
        await this.deps.dispose(tab.sessionId)
      } catch {
        /* best effort */
      }
    }
  }
  dispose(): void {
    for (const runtime of this.tabRuntimes.values()) runtime.unsubscribeSnapshot?.()
    for (const reference of [...this.references.values()]) {
      try {
        reference.release()
      } catch {
        /* shutdown */
      }
    }
  }
}
