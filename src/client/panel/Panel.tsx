/**
 * Panel components for both routing paths.
 *
 * Path B (live): a tab type in the shipped right Sidebar — `AuxGuideEntry`
 * (idempotent 打开), `AuxNewMenu` (explicit 新建), `AuxPaneTabTitle`
 * (numbered chip + running/unread semantics), `AuxPaneBody` (creating /
 * failed / ready / closing / closeFailed / ended).
 *
 * Path A (fallback when the shipped Sidebar is absent): frame-owned column
 * and a conversation-header toggle; narrow windows degrade to SINGLE-COLUMN
 * mode instead of a dead-end card (plan v2 P2/WP2.1).
 *
 * Copy policy (plan v2 P0): every user-visible string resolves through the
 * central dictionary (`../locale.ts`); this file contains no Han literals
 * outside comments (enforced by scripts/copy-check.mjs).
 *
 * Close policy (plan v2 decision 2026-10-16): SILENT — no confirmation bar,
 * no risk warnings; the store's close protocol owns disposal and removal.
 * @module client/panel/Panel
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { SLOT_AUX_CHAT } from '../../contract.ts'
import { AuxChatBody } from './ChatView.tsx'
import { EmptyGlyph, IconClose, IconPanelRight } from './icons.tsx'
import { copy, substitute } from '../../locale.ts'
import type { AuxTabRuntime, AuxChatController } from '../store.ts'
import type {
  FrameworkShares,
  SessionListStateLike,
  SessionReferenceLike,
  TabInfoLike,
} from '../types.ts'

void AuxChatBody

// ── controller handle (bound by the root effect in index.tsx) ──────────────

let controller: AuxChatController | undefined
export function setController(value: AuxChatController | undefined): void {
  controller = value
}
export function getController(): AuxChatController | undefined {
  return controller
}

/**
 * Subscribe the controller AND re-render on every store update: the snapshot
 * is a fresh revision token, and the controller is read imperatively after
 * the re-render (its own identity is deliberately stable).
 */
function useController(): AuxChatController | null {
  useSyncExternalStore(
    (listener) => controller?.subscribe(listener) ?? (() => undefined),
    () => controller?.getSnapshot() ?? null,
    () => null,
  )
  return controller ?? null
}

/**
 * Translate one dictionary key through the framework locale share when it is
 * available (so host language switches apply), falling back to the plugin's
 * own zh dictionary; `{vars}` are substituted either way.
 */
function tt(props: FrameworkShares, key: string, vars?: Record<string, string | number>): string {
  let raw: string | undefined
  try {
    raw = props.t?.(key)
  } catch {
    raw = undefined
  }
  return substitute(raw ?? copy(key), vars)
}

// ── small pieces ────────────────────────────────────────────────────────────

function PreparingCard(props: FrameworkShares): ReactNode {
  return (
    <div className="auxc-state" role="status" aria-live="polite">
      <span className="auxc-spinner" aria-hidden="true" />
      <p className="auxc-state-title">{tt(props, 'preparingTitle')}</p>
      <p className="auxc-state-body">{tt(props, 'preparingBody')}</p>
    </div>
  )
}

function FailedCard(props: FrameworkShares & { message: string; onRetry(): void }): ReactNode {
  return (
    <div className="auxc-state" role="alert">
      <EmptyGlyph size={26} />
      <p className="auxc-state-title">{tt(props, 'failedTitle')}</p>
      <p className="auxc-state-body">{props.message}</p>
      <button type="button" className="auxc-retry" onClick={props.onRetry}>
        {tt(props, 'retry')}
      </button>
    </div>
  )
}

/**
 * `closing` state: feedback is immediate; after 10s the copy says the close
 * is STILL running against the original target — never a silent success.
 * (Operational feedback, not a risk warning: it appears only AFTER the user
 * closed, per the silent-close decision.) Under the removal-first protocol
 * (round 3) the framework removes the tab in the same gesture, so these
 * cards are the DEFENSIVE surface for hosts that kept the tab mounted; the
 * real-browser acceptance for the normal path is "the card never appears".
 */
function ClosingCard(props: FrameworkShares & { target: string }): ReactNode {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), 10_000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="auxc-state" role="status" aria-live="polite" data-aux-close="closing">
      <span className="auxc-spinner" aria-hidden="true" />
      <p className="auxc-state-title">{tt(props, elapsed ? 'closingTitleLong' : 'closingTitle')}</p>
      <p className="auxc-state-body">{tt(props, elapsed ? 'closingBodyLong' : 'closingBody', { target: props.target })}</p>
    </div>
  )
}

/** `closeFailed` state: exact target + the failure + 重试关闭 (same operation). */
function CloseFailedCard(props: FrameworkShares & { target: string; error: string | undefined; onRetry(): void }): ReactNode {
  return (
    <div className="auxc-state" role="alert" data-aux-close="failed">
      <EmptyGlyph size={26} />
      <p className="auxc-state-title">{tt(props, 'closeFailedTitle', { target: props.target })}</p>
      <p className="auxc-state-body">
        {tt(props, 'closeFailedBody', { error: props.error ?? tt(props, 'closeFailedDefault') })}
      </p>
      <button type="button" className="auxc-retry" onClick={props.onRetry}>
        {tt(props, 'retryClose')}
      </button>
    </div>
  )
}

/** `ended` state (T16): read-only explanation + explicit 新建 entry. */
function EndedCard(props: FrameworkShares & { reason: string | undefined; onRestart(): void }): ReactNode {
  return (
    <div className="auxc-state" role="status" data-aux-close="ended">
      <EmptyGlyph size={26} />
      <p className="auxc-state-title">{tt(props, 'endedTitle')}</p>
      <p className="auxc-state-body">{props.reason ?? tt(props, 'endedDefault')}</p>
      <button type="button" className="auxc-retry" onClick={props.onRestart}>
        {tt(props, 'openNew')}
      </button>
    </div>
  )
}

function EmptyState(props: FrameworkShares & { text: string; hint?: string }): ReactNode {
  return (
    <div className="auxc-empty">
      <span className="auxc-empty-glyph">
        <EmptyGlyph size={26} />
      </span>
      <p className="auxc-empty-text">{props.text}</p>
      {props.hint !== undefined && <p className="auxc-empty-hint">{props.hint}</p>}
    </div>
  )
}

// ── Path B: idempotent guide capsule (打开) ──────────────────────────────────

export function AuxGuideEntry(props: FrameworkShares & { sessionId?: string }): ReactNode {
  return (
    <button
      type="button"
      className="auxc-guide-entry"
      data-sidebar-right-guide-entry="aux-chat"
      onClick={() => getController()?.openOrFocus(props.sessionId)}
    >
      <span className="auxc-guide-icon">
        <EmptyGlyph size={22} />
      </span>
      <span className="auxc-guide-text">
        <span className="auxc-guide-title">{tt(props, 'panel')}</span>
        <span className="auxc-guide-desc">{tt(props, 'empty')}</span>
      </span>
    </button>
  )
}

// ── Path B: explicit 新建 menu row ───────────────────────────────────────────

export function AuxNewMenu(props: FrameworkShares & { sessionId?: string; dismiss?: () => void }): ReactNode {
  return (
    <button
      type="button"
      className="auxc-menu-item"
      onClick={() => {
        props.dismiss?.()
        getController()?.openNew(props.sessionId)
      }}
    >
      <span aria-hidden="true">＋</span>
      <span>{tt(props, 'openNew')}</span>
    </button>
  )
}

// ── Path B: numbered chip with running / unread semantics ───────────────────

export function AuxPaneTabTitle(props: FrameworkShares & TabInfoLike & { active?: boolean }): ReactNode {
  const ctl = useController()
  const info = useTabInfo(props)
  const runtime = info?.tab !== undefined ? ctl?.tabRuntime(info.tab.id) : undefined
  useEffect(() => {
    if (props.active === true && info?.tab !== undefined) getController()?.markSeen(info.tab.id)
  }, [props.active, info?.tab])
  if (runtime === undefined) return <span className="auxc-tabtitle">{tt(props, 'panel')}</span>
  return (
    <span className={`auxc-tabtitle${runtime.unread ? ' auxc-tabtitle-unread' : ''}`}>
      {runtime.running && <span className="auxc-tabtitle-spinner" aria-hidden="true" />}
      {!runtime.running && runtime.unread && <span className="auxc-tabtitle-dot" />}
      <span className="auxc-tabtitle-name">{runtime.name}</span>
      <span className="auxc-sr-only">
        {runtime.running ? tt(props, 'srRunning') : runtime.unread ? tt(props, 'srUnread') : ''}
      </span>
    </span>
  )
}

// ── Path B: pane body ────────────────────────────────────────────────────────

/** The tab's durable CONTENT identity (`contentId`), falling back to its id. */
function tabKeyOf(tab: { readonly id: string; readonly [key: string]: unknown }): string {
  const contentId = tab['contentId']
  return typeof contentId === 'string' && contentId !== '' ? contentId : tab.id
}

export function AuxPaneBody(props: FrameworkShares & TabInfoLike & { sessionId?: string; active?: boolean }): ReactNode {
  const ctl = useController()
  const info = useTabInfo(props)
  const mainSessionId = props.sessionId
  const tab = info?.tab
  const observerRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    if (ctl === null || tab === undefined) return
    // tabKey = the tab's durable CONTENT identity: it survives reloads (the
    // layout stores it), which is what the reload-binding keys on. The abort
    // signal object is the occurrence identity; the two are deliberately
    // separate (PRD v2.0 §4.2).
    ctl.ensureTabSession(tab.signal ?? new AbortController().signal, {
      tabId: tab.id,
      mainSessionId,
      tabKey: tabKeyOf(tab),
    })
  }, [ctl, tab?.id, tab?.signal, mainSessionId])

  // PRD R07/R18: the unread mark clears only when the pane is actually
  // VISIBLE. The shipped shares carry no `active` flag (measured at runtime)
  // and keepMounted keeps hidden panes in the DOM, so visibility is measured
  // on the ready-state root element itself. A callback ref (not an effect) is
  // required: the node only exists once the session is ready, long after the
  // mount effects have settled.
  const attachPaneRef = (node: HTMLDivElement | null): void => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (node === null || tab === undefined || typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) getController()?.markSeen(tab.id)
      },
      { threshold: 0.4 },
    )
    observer.observe(node)
    observerRef.current = observer
  }
  useEffect(() => () => observerRef.current?.disconnect(), [])

  if (mainSessionId === undefined) {
    return (
      <div className="auxc-pane" data-aux-chat="pane">
        <EmptyState {...props} text={tt(props, 'emptyMain')} hint={tt(props, 'emptyMainHint')} />
      </div>
    )
  }

  const runtime = tab !== undefined ? ctl?.tabRuntime(tab.id) : undefined

  if (ctl === null || runtime === undefined || runtime.phase === 'creating') {
    return (
      <div className="auxc-pane" data-aux-chat="pane">
        <PreparingCard {...props} />
      </div>
    )
  }
  if (runtime.phase === 'failed') {
    return (
      <div className="auxc-pane" data-aux-chat="pane">
        <FailedCard
          {...props}
          message={runtime.message ?? tt(props, 'unknownReason')}
          onRetry={() => getController()?.retryTabSession(runtime.tabId)}
        />
      </div>
    )
  }
  if (runtime.phase === 'closing') {
    return (
      <div className="auxc-pane" data-aux-chat="pane" data-aux-closing={runtime.sessionId ?? ''}>
        <ClosingCard {...props} target={ctl === null ? runtime.name : ctl.targetLabel(runtime)} />
      </div>
    )
  }
  if (runtime.phase === 'closeFailed') {
    return (
      <div className="auxc-pane" data-aux-chat="pane" data-aux-closefailed={runtime.sessionId ?? ''}>
        <CloseFailedCard
          {...props}
          target={ctl === null ? runtime.name : ctl.targetLabel(runtime)}
          error={runtime.closeError}
          onRetry={() => getController()?.retryClose(runtime.tabId)}
        />
      </div>
    )
  }
  if (runtime.phase === 'ended' || runtime.phase === 'closed') {
    return (
      <div className="auxc-pane" data-aux-chat="pane" data-aux-ended={runtime.sessionId ?? ''}>
        <EndedCard
          {...props}
          reason={runtime.phase === 'ended' ? runtime.endedReason : undefined}
          onRestart={() => getController()?.restartTabSession(runtime.tabId)}
        />
      </div>
    )
  }

  const auxId = runtime.sessionId
  const reference = getController()?.referenceFor(auxId)
  // Decision 2026-10-16 (evening): the pane bar carries NO inheritance prose —
  // the page stays clean (the long "临时会话 · 已继承…" sentence is gone, with
  // its hover detail). The delivered inheritance stays MACHINE-READABLE on the
  // bar instead (data-aux-inherited / -model / -chars), so the honesty checks
  // and mirror verification keep their evidence without any visible text.
  // Only two things may appear: a real mirror warning, and the archived-main
  // hint — both exceptional states, never decoration.
  const mirrorWarnings = runtime.warnings.filter((line) => /mirror|section|scope|injection/i.test(line))
  return (
    // data-aux-session pins the pane's session binding into the DOM so visual
    // verification can assert the embedded conversation is bound to the
    // auxiliary session — never to the main one (session isolation).
    <div className="auxc-pane" data-aux-chat="pane" data-aux-session={auxId ?? ''} ref={attachPaneRef}>
      <div
        className="auxc-bar"
        data-aux-inherited={runtime.inherited?.form ?? 'unknown'}
        data-aux-model={runtime.model ?? ''}
        data-aux-inherited-chars={runtime.inherited === undefined ? '' : String(runtime.inherited.chars)}
      >
        {mirrorWarnings.length > 0 && (
          <span className="auxc-bar-warn" title={mirrorWarnings.join('\n')} data-aux-mirror-warnings={mirrorWarnings.length}>
            {tt(props, 'mirrorWarnings', { count: mirrorWarnings.length })}
          </span>
        )}
        {ctl !== null && ctl.isMainArchived(runtime.mainSessionId) && (
          <span className="auxc-bar-warn" role="status">
            {tt(props, 'mainArchived')}
          </span>
        )}
        <AuxBarAction {...props} mainSessionId={mainSessionId} auxId={auxId ?? ''} label={tt(props, 'handoff')} />
      </div>
      <div className="auxc-body">
        {auxId === undefined || reference === undefined || props.SessionProvider === undefined || props.renderSlot === undefined ? (
          <EmptyState {...props} text={tt(props, 'convUnavailable')} hint={tt(props, 'convUnavailableHintReopen')} />
        ) : (
          <props.SessionProvider key={reference.sessionId} session={reference}>
            {props.renderSlot(SLOT_AUX_CHAT, {}, {
              fallback: <EmptyState {...props} text={tt(props, 'convUnavailable')} hint={tt(props, 'convUnavailableHintHost')} />,
            })}
          </props.SessionProvider>
        )}
      </div>
    </div>
  )
}

function AuxBarAction(props: FrameworkShares & { mainSessionId: string; auxId?: string; label: string }): ReactNode {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  if (props.auxId === undefined) return null
  return (
    <>
      <button
        type="button"
        className="auxc-bar-action"
        title={props.label}
        onClick={() => {
          void getController()?.handoff(props.auxId ?? '', props.mainSessionId).then(setResult)
        }}
      >
        {props.label}
      </button>
      {result !== null && (
        <span className={`auxc-bar-result auxc-bar-${result.ok ? 'ok' : 'warn'}`}>{result.message}</span>
      )}
    </>
  )
}

function useTabInfo(props: FrameworkShares & TabInfoLike): import('../types.ts').TabInfoResult | undefined {
  try {
    return props.useTabInfo === undefined ? undefined : props.useTabInfo()
  } catch {
    return undefined
  }
}

// ── Path A: conversation-header toggle ──────────────────────────────────────

export function AuxHeaderToggle(props: FrameworkShares & { sessionId?: string }): ReactNode {
  const ctl = useController()
  const shown = ctl?.shown ?? false
  // Single source of truth (plan P0/WP0.5): the dot reads the controller's
  // derived indicators, never a separate count.
  const live = ctl?.indicators().live ?? 0
  const label = tt(props, 'panel')
  return (
    <button
      type="button"
      className={shown ? 'auxc-toggle auxc-toggle-on' : 'auxc-toggle'}
      aria-label={label}
      aria-pressed={shown}
      title={shown ? tt(props, 'close') : label}
      onClick={() => {
        if (shown) ctl?.endActiveSession()
        else ctl?.openForMain(props.sessionId ?? ctl?.mainSessionId)
      }}
    >
      <IconPanelRight size={16} active={shown} />
      {live > 0 && !shown ? <span className="auxc-toggle-dot" aria-label={tt(props, 'liveDot')} /> : null}
    </button>
  )
}

// ── Path A: frame-owned column (single-column mode when narrow) ─────────────

function useMainSessionId(props: FrameworkShares): string | undefined {
  const useSessions = props.useSessions
  if (useSessions === undefined) return undefined
  return useSessions((list: SessionListStateLike) =>
    Object.values(list.byId).find((row) => (row.retainedBy?.['mainView'] ?? 0) > 0)?.id,
  )
}

export function AuxRightbarPanel(props: FrameworkShares & { width?: number }): ReactNode {
  const ctl = useController()
  const mainSessionId = useMainSessionId(props)
  useEffect(() => {
    ctl?.setMainSession(mainSessionId)
  }, [ctl, mainSessionId])
  const mainRef = useRetained(props, mainSessionId, 'auxChatMain')
  // Plan v2 P2/WP2.1: a narrow window degrades to SINGLE-COLUMN mode (the
  // auxiliary session takes the column, with a back affordance) instead of
  // the old dead-end card.
  const single = (props.width ?? 1) <= 0

  if (ctl === null || mainSessionId === undefined || mainRef === undefined || props.SessionProvider === undefined) {
    return (
      <div className={single ? 'auxc-column auxc-column-single' : 'auxc-column'} data-aux-chat="rightbar" data-aux-single={single ? '1' : '0'}>
        {single && <SingleColumnHead {...props} />}
        <EmptyState {...props} text={tt(props, 'empty')} hint={tt(props, 'emptyColumnHint')} />
      </div>
    )
  }
  return (
    <props.SessionProvider session={mainRef}>
      <AuxRightbarSession {...props} mainSessionId={mainSessionId} single={single} />
    </props.SessionProvider>
  )
}

function SingleColumnHead(props: FrameworkShares): ReactNode {
  return (
    <div className="auxc-head" data-aux-single-head="1">
      <span className="auxc-title">{tt(props, 'narrowTitle')}</span>
      <span className="auxc-subtitle">{tt(props, 'narrowHint')}</span>
      <button
        type="button"
        className="auxc-iconbtn"
        title={tt(props, 'backToMain')}
        aria-label={tt(props, 'backToMain')}
        onClick={() => getController()?.setShown(false)}
      >
        <IconPanelRight size={14} />
      </button>
    </div>
  )
}

export function AuxRightbarSession(props: FrameworkShares & { mainSessionId: string; single?: boolean }): ReactNode {
  const ctl = useController()
  const auxTab = ctl?.tabs.find((tab) => tab.mirrorOf === props.mainSessionId)
  const auxRef = useRetained(props, ctl?.activeId, RETAIN_SOURCE)
  const ready = auxTab !== undefined && auxRef !== undefined && props.SessionProvider !== undefined && props.renderSlot !== undefined
  return (
    <div
      className={props.single === true ? 'auxc-column auxc-column-single' : 'auxc-column'}
      data-aux-chat="rightbar"
      data-aux-single={props.single === true ? '1' : '0'}
      data-aux-session={ctl?.activeId ?? ''}
    >
      <div className="auxc-head">
        <span className="auxc-title">{tt(props, 'panel')}</span>
        {auxTab !== undefined && <span className="auxc-subtitle">{captionOf(auxTab.sessionId)}</span>}
        {props.single === true && (
          <button
            type="button"
            className="auxc-iconbtn"
            title={tt(props, 'backToMain')}
            aria-label={tt(props, 'backToMain')}
            onClick={() => ctl?.setShown(false)}
          >
            <IconPanelRight size={14} />
          </button>
        )}
        <button
          type="button"
          className="auxc-iconbtn"
          title={tt(props, 'close')}
          aria-label={tt(props, 'close')}
          onClick={() => ctl?.endActiveSession()}
        >
          <IconClose size={14} />
        </button>
      </div>
      {!ready || ctl === null || props.SessionProvider === undefined || props.renderSlot === undefined ? (
        <EmptyState {...props} text={tt(props, 'empty')} hint={tt(props, 'emptyColumnHint')} />
      ) : (
        <props.SessionProvider key={auxRef.sessionId} session={auxRef as SessionReferenceLike}>
          {props.renderSlot(SLOT_AUX_CHAT, {}, {
            fallback: <EmptyState {...props} text={tt(props, 'convUnavailable')} hint={tt(props, 'convUnavailableHintKeep')} />,
          })}
        </props.SessionProvider>
      )}
    </div>
  )
}

const RETAIN_SOURCE = 'auxChatPanel'

function useRetained(props: FrameworkShares, sessionId: string | undefined, source: string): SessionReferenceLike | undefined {
  const [reference, setReference] = useState<SessionReferenceLike | undefined>(undefined)
  useEffect(() => {
    if (sessionId === undefined || props.sessions === undefined) {
      setReference(undefined)
      return undefined
    }
    let ref: SessionReferenceLike
    try {
      ref = props.sessions.retain(sessionId, { source })
    } catch {
      setReference(undefined)
      return undefined
    }
    setReference(ref)
    return () => {
      try {
        ref.release()
      } catch {
        /* noop */
      }
    }
  }, [props.sessions, sessionId, source])
  return reference
}

function captionOf(sessionId: string): string {
  return sessionId.length <= 14 ? sessionId : `…${sessionId.slice(-9)}`
}
