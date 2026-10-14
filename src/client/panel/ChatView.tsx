/**
 * The auxiliary conversation surface.
 *
 * This component is the `aux-chat.conversation` occupant. The *panel* (its
 * parent registration) owns the retained `SessionReference` and wraps the
 * `renderSlot` occurrence in `<SessionProvider session={ref}>`, so by the time
 * this component renders the scope binding already points at the auxiliary
 * session and `useSession` / `useConversation` read THAT session.
 *
 * Reuse mechanism (VERIFIED-API.md C2, shipped precedent
 * `$PKG/dsh-client-ui-subagent/lib/client.js:744-829`): the official
 * `conversation.content` Factory is the only reusable Conversation UI channel,
 * so the whole transcript, composer, model seat, permission seat, plan seat,
 * approval/user-question takeover and queue/todo dock come for free.
 *
 * A `fallback` is MANDATORY: when ui-conversation is absent the factory outlet
 * returns `fallback ?? null` (`$PKG/dsh-client-ui-renderer/lib/client.js:1040-1048`),
 * and a null body would be a blank panel.
 * @module client/panel/ChatView
 */
import type { ReactNode } from 'react'
import type { SessionListStateLike } from '../types.ts'

/** Lifecycle fields this component reads off a Session snapshot. */
export interface SessionSnapshotLike {
  readonly running?: boolean | undefined
  readonly openState?: string | undefined
  readonly blank?: boolean | undefined
  readonly promptAttempted?: boolean | undefined
  readonly awaitingFirstTurn?: boolean | undefined
}

/** Target-neutral Conversation snapshot fields this component reads. */
export interface ConversationSnapshotLike {
  readonly activeTargets?: { readonly size: number } | undefined
}

/** Selector-hook shape the framework hands to a session-scope slot. */
export type SelectorHook<Snapshot> = <Selected>(
  selector: (snapshot: Snapshot) => Selected,
  equal?: ((left: Selected, right: Selected) => boolean) | undefined,
) => Selected

/** `renderFactorySlot` as the renderer binds it. */
export type RenderFactorySlotLike = (
  name: string,
  inputProps: Record<string, unknown>,
  options?: { slots?: Record<string, unknown> | undefined; fallback?: ReactNode | undefined },
) => ReactNode

/** Props of the `aux-chat.conversation` occupant (framework-supplied shares). */
export interface AuxChatBodyProps {
  /** Current scope binding identity, i.e. the auxiliary session id. */
  readonly sessionId?: string | undefined
  /** Factory render capability (present on every registered component). */
  readonly renderFactorySlot?: RenderFactorySlotLike | undefined
  /** Strict session lifecycle selector. */
  readonly useSession?: SelectorHook<SessionSnapshotLike> | undefined
  /** Target-neutral Conversation selector. */
  readonly useConversation?: SelectorHook<ConversationSnapshotLike> | undefined
  /** Global Session-list selector (used for the list's own `blank` verdict). */
  readonly useSessions?: SelectorHook<SessionListStateLike> | undefined
  /** Locale seat for this plugin's namespace. */
  readonly t?: ((key: string) => string) | undefined
}

/** Stand-in hook used only when an optional framework share is missing. */
function useUnavailable<Snapshot>(): undefined {
  return undefined
}

/** Local `views` position the caller selects for its Factory occurrence. */
function FixedChatConversationView(props: {
  readonly renderSlot?: ((key: string, owner: Record<string, unknown>) => ReactNode) | undefined
}): ReactNode {
  const renderSlot = props.renderSlot
  if (typeof renderSlot !== 'function') return null
  return <>{renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Shown when the Conversation Factory is absent, so the panel is never blank. */
function ConversationPlaceholder(): ReactNode {
  return (
    <div className="auxc-placeholder" role="status">
      <p className="auxc-placeholder-title">对话界面暂不可用</p>
      <p className="auxc-placeholder-body">
        ui-conversation 未装配或该会话尚未就绪。辅助会话本身仍可在主机侧运行，稍后重新打开本面板即可。
      </p>
    </div>
  )
}

/**
 * Render the reusable Conversation content for the bound auxiliary session.
 * @param props - framework-supplied slot shares.
 * @returns the embedded Conversation, or the placeholder.
 */
export function AuxChatBody(props: AuxChatBodyProps): ReactNode {
  const useSession = props.useSession ?? useUnavailable<SessionSnapshotLike>
  const useConversation = props.useConversation ?? useUnavailable<ConversationSnapshotLike>
  const useSessions = props.useSessions ?? useUnavailable<SessionListStateLike>

  const session = useSession((snapshot) => snapshot)
  const conversation = useConversation((snapshot) => snapshot)
  const summaryBlank = useSessions((state) => {
    const id = props.sessionId
    return id === undefined ? undefined : state.byId[id]?.blank
  })

  if (props.renderFactorySlot === undefined) return <ConversationPlaceholder />

  // phase/hero derivation, transparently ported from the shipped embedded-chat
  // consumer (`$PKG/dsh-client-ui-subagent/lib/client.js:776-787`): the shell
  // phase comes from live activity / first-turn progress, `settling` covers the
  // window where history is still opening, and `hero` is the truly blank state.
  const activeTargets = conversation?.activeTargets?.size ?? 0
  const shellPhase: 'blank' | 'engaging' | 'active' =
    activeTargets > 0 || (session?.blank === false && session.awaitingFirstTurn !== true) || session?.running === true
      ? 'active'
      : session?.promptAttempted === true
        ? 'engaging'
        : 'blank'
  const settling = shellPhase === 'blank' && session?.openState === 'loading' && summaryBlank !== true
  // PRD R04: a first-open auxiliary session shows an EMPTY transcript with the
  // reference hint — never the blank-session brand hero or workspace picker the
  // main column renders. `hero` is therefore forced off: the factory then
  // mounts the ordinary chat surface (empty scroll area + composer), which is
  // exactly the "干净聊天页" the PRD specifies.
  void shellPhase
  const phase: 'settling' | 'active' = settling ? 'settling' : 'active'

  return (
    <div className="auxc-conv" data-phase={phase}>
      {props.renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase, hero: false },
        {
          slots: { views: FixedChatConversationView },
          fallback: <ConversationPlaceholder />,
        },
      )}
    </div>
  )
}
