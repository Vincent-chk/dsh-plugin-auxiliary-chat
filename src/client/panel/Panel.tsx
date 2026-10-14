/**
 * Panel components for both routing paths.
 *
 * Path B (live): a tab type in the shipped right Sidebar — `AuxGuideEntry`
 * (idempotent 打开), `AuxNewMenu` (explicit 新建), `AuxPaneTabTitle`
 * (numbered chip + running/unread semantics), `AuxPaneBody` (creating /
 * failed / ready + close confirmation).
 *
 * Path A (fallback when the shipped Sidebar is absent): frame-owned column
 * and a conversation-header toggle.
 * @module client/panel/Panel
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { SLOT_AUX_CHAT } from '../../contract.ts'
import { AuxChatBody } from './ChatView.tsx'
import { EmptyGlyph, IconClose, IconPanelRight } from './icons.tsx'
import { CloseVetoError, type AuxTabRuntime, type AuxChatController } from '../store.ts'
import type {
  FrameworkShares,
  SessionListStateLike,
  SessionReferenceLike,
  TabInfoLike,
} from '../types.ts'

void CloseVetoError
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
 * is a fresh revision token, and the controller is read imperatively after the
 * re-render (its own identity is deliberately stable).
 */
function useController(): AuxChatController | null {
  useSyncExternalStore(
    (listener) => controller?.subscribe(listener) ?? (() => undefined),
    () => controller?.getSnapshot() ?? null,
    () => null,
  )
  return controller ?? null
}

function t(props: FrameworkShares, key: string): string {
  try {
    return props.t?.(key) ?? key
  } catch {
    return key
  }
}

// ── small pieces ────────────────────────────────────────────────────────────

function PreparingCard(): ReactNode {
  return (
    <div className="auxc-state" role="status" aria-live="polite">
      <span className="auxc-spinner" aria-hidden="true" />
      <p className="auxc-state-title">正在准备主会话上下文…</p>
      <p className="auxc-state-body">用于临时提问，它单向镜像当前主会话的上下文；收起可保留，关闭后永久删除。</p>
    </div>
  )
}

function FailedCard(props: { message: string; onRetry(): void }): ReactNode {
  return (
    <div className="auxc-state" role="alert">
      <EmptyGlyph size={26} />
      <p className="auxc-state-title">无法创建辅助会话</p>
      <p className="auxc-state-body">{props.message}</p>
      <button type="button" className="auxc-retry" onClick={props.onRetry}>
        重试
      </button>
    </div>
  )
}

/**
 * `closing` state (PRD v2.0 §6.3): feedback is immediate; after 10s the copy
 * says the close is STILL running against the original target — never a
 * silent success.
 */
function ClosingCard(props: { target: string }): ReactNode {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), 10_000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="auxc-state" role="status" aria-live="polite" data-aux-close="closing">
      <span className="auxc-spinner" aria-hidden="true" />
      <p className="auxc-state-title">{elapsed ? '仍在关闭辅助会话…' : '辅助会话正在关闭…'}</p>
      <p className="auxc-state-body">
        {elapsed ? '清理时间已超过 10 秒，仍在处理 ' : '正在释放 '}
        {props.target}
        。完成后该标签会自动移除。
      </p>
    </div>
  )
}

/** `closeFailed` state: exact target + the failure + 重试关闭 (same operation). */
function CloseFailedCard(props: { target: string; error: string | undefined; onRetry(): void }): ReactNode {
  return (
    <div className="auxc-state" role="alert" data-aux-close="failed">
      <EmptyGlyph size={26} />
      <p className="auxc-state-title">关闭未完成：{props.target}</p>
      <p className="auxc-state-body">
        {props.error ?? '主机侧清理失败。'}内容暂时保留，清理责任仍在；重试将关闭同一条辅助会话。
      </p>
      <button type="button" className="auxc-retry" onClick={props.onRetry}>
        重试关闭
      </button>
    </div>
  )
}

/** `ended` state (T16): read-only explanation + explicit 新建 entry. */
function EndedCard(props: { reason: string | undefined; onRestart(): void }): ReactNode {
  return (
    <div className="auxc-state" role="status" data-aux-close="ended">
      <EmptyGlyph size={26} />
      <p className="auxc-state-title">辅助会话已结束</p>
      <p className="auxc-state-body">{props.reason ?? '该会话已结束，临时会话不自动恢复。'}</p>
      <button type="button" className="auxc-retry" onClick={props.onRestart}>
        新建辅助会话
      </button>
    </div>
  )
}

function EmptyState(props: { text: string; hint?: string }): ReactNode {
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

/** Human size for the bar (1 decimal above 1k). */
function sizeText(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars)
}

/**
 * What the panel may CLAIM about inheritance.
 *
 * The bar used to assert "已引用主会话上下文" unconditionally, which was wrong
 * whenever the injection or its fallback section failed — the operator saw an
 * empty side chat with a promise of inherited context (2026-10-14). It now
 * reports the delivered form measured by the Host.
 */
function inheritanceStatus(runtime: AuxTabRuntime): { text: string; degraded: boolean; detail: string } {
  const report = runtime.inherited
  if (report === undefined) {
    return { text: '临时会话 · 关闭后无法恢复', degraded: false, detail: '尚未收到主机的继承结果。' }
  }
  const size = sizeText(report.chars)
  if (report.form === 'none') {
    return {
      text: '未继承主会话上下文 · 关闭后无法恢复',
      degraded: true,
      detail: 'mirrorHistory 已关闭，本次没有把主会话内容交给本会话的模型。',
    }
  }
  if (report.form === 'summary') {
    if (report.chars === 0) {
      return {
        text: '主会话当前没有可继承的已提交记录 · 关闭后无法恢复',
        degraded: false,
        detail: '创建这一刻主会话的已提交转录为空（例如新会话、或首轮尚未提交），因此没有内容可继承。',
      }
    }
    return {
      text: `已继承主会话摘要 · ${size} 字符（超长会话降级，非逐字历史）`,
      degraded: true,
      detail: '主会话过长，只有压缩摘要进入本会话的模型上下文（系统提示词 section），不是逐字转录。',
    }
  }
  if (report.truncated) {
    return {
      text: `已继承主会话最近 ${String(report.entries)} 条 · ${size} 字符（较早 ${String(report.omitted)} 条超出预算）`,
      degraded: true,
      detail: '完整的已提交转录超过 mirrorMaxChars 预算，只注入了最近的连续一段（隐藏 user/message，模型可见、聊天页不显示气泡）。',
    }
  }
  return {
    text: `已继承主会话上下文 ${String(report.entries)} 条 · ${size} 字符`,
    degraded: false,
    detail: '创建瞬间的已提交转录整段注入为一条隐藏 user/message：模型可见，聊天页按设计不显示为气泡。',
  }
}

// ── close confirmation (PRD §10 copy) ────────────────────────────────────────

/**
 * Inline close confirmation: a slim warning bar at the top of the pane, no
 * modal, no mask, no portal — one click on 销毁 finishes what the tab's 关闭
 * started, 取消 (or Escape) returns to idle. Replacing the modal was a direct
 * operator request: the confirmation is guard rail, not a separate screen.
 */
function ConfirmInline(props: { runtime: AuxTabRuntime }): ReactNode {
  const [working, setWorking] = useState(false)
  const tabId = props.runtime.tabId
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const cancel = (): void => getController()?.cancelClose(tabId)
  const ctl = getController()
  const target = ctl === null || ctl === undefined ? props.runtime.name : ctl.targetLabel(props.runtime)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel()
    }
    document.addEventListener('keydown', onKey)
    cancelRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  return (
    <div className="auxc-confirm" role="alertdialog" aria-label="确认销毁辅助会话">
      <span className="auxc-confirm-text">
        关闭「{target}」？将永久销毁，无法恢复。{props.runtime.running ? '正在回复的回合会中止。' : ''}
      </span>
      <span className="auxc-confirm-actions">
        <button type="button" ref={cancelRef} className="auxc-confirm-cancel" onClick={cancel}>
          取消
        </button>
        <button
          type="button"
          className="auxc-confirm-destroy"
          disabled={working}
          onClick={() => {
            setWorking(true)
            void getController()?.confirmClose(tabId, false)
          }}
        >
          销毁
        </button>
      </span>
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
        <span className="auxc-guide-title">{t(props, 'panel')}</span>
        <span className="auxc-guide-desc">{t(props, 'empty')}</span>
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
      <span>{t(props, 'openNew')}</span>
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
  if (runtime === undefined) return <span className="auxc-tabtitle">{t(props, 'panel')}</span>
  return (
    <span className={`auxc-tabtitle${runtime.unread ? ' auxc-tabtitle-unread' : ''}`}>
      {runtime.running && <span className="auxc-tabtitle-spinner" aria-hidden="true" />}
      {!runtime.running && runtime.unread && <span className="auxc-tabtitle-dot" />}
      <span className="auxc-tabtitle-name">{runtime.name}</span>
      <span className="auxc-sr-only">
        {runtime.running ? '，正在回复中' : runtime.unread ? '，有未读回复' : ''}
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
        <EmptyState text="还没有可镜像的主会话。" hint="打开一个主会话后重试。" />
      </div>
    )
  }

  const runtime = tab !== undefined ? ctl?.tabRuntime(tab.id) : undefined

  if (ctl === null || runtime === undefined || runtime.phase === 'creating') {
    return (
      <div className="auxc-pane" data-aux-chat="pane">
        <PreparingCard />
      </div>
    )
  }
  if (runtime.phase === 'failed') {
    return (
      <div className="auxc-pane" data-aux-chat="pane">
        <FailedCard message={runtime.message ?? '未知原因'} onRetry={() => getController()?.retryTabSession(runtime.tabId)} />
      </div>
    )
  }
  if (runtime.phase === 'closing') {
    return (
      <div className="auxc-pane" data-aux-chat="pane" data-aux-closing={runtime.sessionId ?? ''}>
        <ClosingCard target={ctl === null ? runtime.name : ctl.targetLabel(runtime)} />
      </div>
    )
  }
  if (runtime.phase === 'closeFailed') {
    return (
      <div className="auxc-pane" data-aux-chat="pane" data-aux-closefailed={runtime.sessionId ?? ''}>
        <CloseFailedCard
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
          reason={runtime.phase === 'ended' ? runtime.endedReason : undefined}
          onRestart={() => getController()?.restartTabSession(runtime.tabId)}
        />
      </div>
    )
  }

  const auxId = runtime.sessionId
  const reference = getController()?.referenceFor(auxId)
  return (
    // data-aux-session pins the pane's session binding into the DOM so visual
    // verification can assert the embedded conversation is bound to the
    // auxiliary session — never to the main one (session isolation).
    <div className="auxc-pane" data-aux-chat="pane" data-aux-session={auxId ?? ''} ref={attachPaneRef}>
      {runtime.closeState === 'confirming' && <ConfirmInline runtime={runtime} />}
      <div className="auxc-bar">
        {(() => {
          const status = inheritanceStatus(runtime)
          const mirrorWarnings = runtime.warnings.filter((line) => /mirror|section|scope|injection/i.test(line))
          return (
            <>
              <span
                className={status.degraded ? 'auxc-bar-warn' : 'auxc-bar-context'}
                title={status.detail}
                data-aux-inherited={runtime.inherited?.form ?? 'unknown'}
              >
                {status.text}
              </span>
              {mirrorWarnings.length > 0 && (
                <span className="auxc-bar-warn" title={mirrorWarnings.join('\n')} data-aux-mirror-warnings={mirrorWarnings.length}>
                  镜像警告 {mirrorWarnings.length} 条
                </span>
              )}
            </>
          )
        })()}
        {ctl !== null && ctl.isMainArchived(runtime.mainSessionId) && (
          <span className="auxc-bar-warn" role="status">
            主会话已归档：参考历史已冻结，本辅助会话不会随归档停止。
          </span>
        )}
        <AuxBarAction mainSessionId={mainSessionId} auxId={auxId ?? ''} label={t(props, 'handoff')} />
      </div>
      <div className="auxc-body">
        {auxId === undefined || reference === undefined || props.SessionProvider === undefined || props.renderSlot === undefined ? (
          <EmptyState text="对话界面暂不可用" hint="重新打开该标签即可。" />
        ) : (
          <props.SessionProvider key={reference.sessionId} session={reference}>
            {props.renderSlot(SLOT_AUX_CHAT, {}, {
              fallback: <EmptyState text="对话界面暂不可用" hint="ui-conversation 未装配，但辅助会话仍可在主机侧运行。" />,
            })}
          </props.SessionProvider>
        )}
      </div>
    </div>
  )
}

function AuxBarAction(props: { mainSessionId: string; auxId?: string; label: string }): ReactNode {
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
  const live = ctl?.tabs.length ?? 0
  const label = t(props, 'panel')
  return (
    <button
      type="button"
      className={shown ? 'auxc-toggle auxc-toggle-on' : 'auxc-toggle'}
      aria-label={label}
      aria-pressed={shown}
      title={shown ? t(props, 'close') : label}
      onClick={() => {
        if (shown) ctl?.endActiveSession()
        else ctl?.openForMain(props.sessionId ?? ctl?.mainSessionId)
      }}
    >
      <IconPanelRight size={16} active={shown} />
      {live > 0 && !shown ? <span className="auxc-toggle-dot" aria-label="有存活的辅助会话" /> : null}
    </button>
  )
}

// ── Path A: frame-owned column ───────────────────────────────────────────────

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

  const canShow = (props.width ?? 1) > 0
  if (!canShow) {
    return <EmptyState text="当前窗口太窄，无法并排显示辅助会话。" hint="把窗口拉宽后重试。" />
  }
  if (ctl === null || mainSessionId === undefined || mainRef === undefined || props.SessionProvider === undefined) {
    return (
      <div className="auxc-column" data-aux-chat="rightbar">
        <EmptyState text={t(props, 'empty')} hint="点会话头部的辅助会话按钮，它会镜像当前主会话并创建第一条。" />
      </div>
    )
  }
  return (
    <props.SessionProvider session={mainRef}>
      <AuxRightbarSession {...props} mainSessionId={mainSessionId} />
    </props.SessionProvider>
  )
}

export function AuxRightbarSession(props: FrameworkShares & { mainSessionId: string }): ReactNode {
  const ctl = useController()
  const auxTab = ctl?.tabs.find((tab) => tab.mirrorOf === props.mainSessionId)
  const auxRef = useRetained(props, ctl?.activeId, RETAIN_SOURCE)
  const ready = auxTab !== undefined && auxRef !== undefined && props.SessionProvider !== undefined && props.renderSlot !== undefined
  return (
    <div className="auxc-column" data-aux-chat="rightbar" data-aux-session={ctl?.activeId ?? ''}>
      <div className="auxc-head">
        <span className="auxc-title">{t(props, 'panel')}</span>
        {auxTab !== undefined && <span className="auxc-subtitle">{captionOf(auxTab.sessionId)}</span>}
        <button
          type="button"
          className="auxc-iconbtn"
          title="结束并销毁辅助会话"
          aria-label="结束辅助会话"
          onClick={() => ctl?.endActiveSession()}
        >
          <IconClose size={14} />
        </button>
      </div>
      {!ready || ctl === null || props.SessionProvider === undefined || props.renderSlot === undefined ? (
        <EmptyState text={t(props, 'empty')} hint="点会话头部的辅助会话按钮打开第一条。" />
      ) : (
        <props.SessionProvider key={auxRef.sessionId} session={auxRef as SessionReferenceLike}>
          {props.renderSlot(SLOT_AUX_CHAT, {}, {
            fallback: <EmptyState text="对话界面暂不可用" hint="辅助会话已保留，重新打开右列即可。" />,
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
