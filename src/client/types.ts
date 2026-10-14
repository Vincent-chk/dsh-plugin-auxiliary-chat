/**
 * Structural client contracts this plugin relies on.
 *
 * Hand-written instead of imported on purpose: every DSH client package is a
 * browser seed word the build keeps external, so a value import would be
 * unresolvable and a type import would still need a resolver the plugin does
 * not own. Only `react` (a seed word this bundle may require) and types from
 * `react` + `@deepseek-ai/cordis` are imported anywhere in `src/client/**`.
 * @module client/types
 */

/** Disposer returned by every Cordis effect and slot registration. */
export type Disposable = () => void

/** Minimal `ObservableSnapshot` face (`@deepseek-ai/dsh-client-store`). */
export interface ObservableSnapshotLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): Disposable
}

/** One auxiliary session as the tab strip knows it. */
export interface AuxTabState {
  /** Durable session identity; also the remote `aux-end` address. */
  readonly sessionId: string
  /** Main session mirrored at creation time. */
  readonly mirrorOf: string
  /** Working directory reported by the Host. */
  readonly cwd: string
  /** Creation time, Unix epoch ms (client clock). */
  readonly createdAt: number
  /** Non-fatal mirror problems reported by the Host. */
  readonly warnings: readonly string[]
}

/** Lifecycle of one host-tab-owned auxiliary session (Path B). */
export type TabSessionPhase = 'creating' | 'ready' | 'failed'

/**
 * One host tab's auxiliary session.
 *
 * A host tab IS an auxiliary session: created when the body mounts, reused for
 * the tab's whole life, and destroyed only when the tab's own `AbortSignal`
 * aborts. The signal object is the identity key — a tab id from the host tab
 * record is deliberately not used, and a Session switch never re-creates.
 */
export interface TabSessionState {
  /** Durable auxiliary session identity once created. */
  readonly sessionId: string | undefined
  readonly phase: TabSessionPhase
  /** Failure text for the retry affordance; `undefined` while creating or ready. */
  readonly message: string | undefined
  /** Non-fatal mirror problems reported by the Host. */
  readonly warnings: readonly string[]
}

/** Root-level registry state; the only thing that survives a panel switch. */
export interface AuxChatState {
  /** Whether the right column is currently expanded. */
  readonly shown: boolean
  readonly tabs: readonly AuxTabState[]
  readonly activeId: string | undefined
  /** Latest main-session id observed by the panel; mirror target and handoff target. */
  readonly mainSessionId: string | undefined
  /**
   * Host-tab-owned sessions, keyed by the tab record's own `AbortSignal`
   * object. Path B lives here; the `tabs` list above is Path A's column.
   */
  readonly tabStates: ReadonlyMap<AbortSignal, TabSessionState>
  /** Last human-readable outcome (creating / created / failure). */
  readonly status: string | undefined
  /** True while a create round-trip is in flight. */
  readonly busy: boolean
}

/** One row of the Session Controller list snapshot. */
export interface SessionSummaryLike {
  readonly id: string
  readonly title?: string | undefined
  readonly displayTitle?: string | undefined
  readonly cwd?: string | undefined
  readonly blank?: boolean | undefined
  readonly running?: boolean | undefined
  readonly retainedBy?: Readonly<Record<string, number>> | undefined
}

/** Session Controller list snapshot (`ISessions.list`). */
export interface SessionListStateLike {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionSummaryLike>>
}

/** Contiguous event window exposed by a Session binding. */
export interface SessionEventWindowLike {
  readonly entries: readonly SessionEventEntryLike[]
}

/** One entry of the Session event window. */
export interface SessionEventEntryLike {
  readonly type: string
  readonly event?: { readonly type?: string | undefined; readonly data?: unknown } | undefined
}

/** Live Session binding; `ctx` is the Agent-scoped Cordis context. */
export interface SessionBindingLike {
  readonly sessionId: string
  readonly eventSource: ObservableSnapshotLike<SessionEventWindowLike>
  readonly ctx: unknown
  readonly session?: unknown
}

/** One independent use of an exact client generation. */
export interface SessionReferenceLike {
  readonly sessionId: string
  readonly binding: SessionBindingLike
  readonly ready: Promise<unknown>
  release(): void
}

/** `ctx.sessions` — the outward Session Controller face. */
export interface SessionsLike {
  readonly list: ObservableSnapshotLike<SessionListStateLike>
  retain(target: string, options: { source: string; signal?: AbortSignal | undefined }): SessionReferenceLike
  /** Create or adopt a Session on the Host with a pre-generated identity. */
  create?(opts: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>
  binding(id: string): SessionBindingLike | undefined
  scope(id: string): unknown
  retainInfo(id: string): ObservableSnapshotLike<{ retainedBy?: Readonly<Record<string, number>> | undefined }>
}

/** One host tab record, narrowed to the fields the plugin observes. */
export interface SidebarTabLike {
  readonly id: string
  readonly kind: string
  readonly contentId?: string | undefined
  readonly title?: string | undefined
  readonly signal?: AbortSignal | undefined
}

/** Options the tab service accepts on `openTab`. */
export interface SidebarOpenOptionsLike {
  paneId?: string | undefined
  preferNewPane?: boolean | undefined
  /** The guide passes `true`; callers may pass an explicit tab id. */
  replaceTab?: string | boolean | undefined
  revealIfOpened?: boolean | undefined
}

/** `ctx.sidebarRight` — the shipped right Sidebar navigation face. */
export interface SidebarRightLike {
  openTab(kind: string, options?: SidebarOpenOptionsLike): void
  openTabIn?(sessionId: string, kind: string, options?: SidebarOpenOptionsLike): void
  focus(tabId: string): void
  close(tabId: string): void
  closeIn?(sessionId: string, tabId: string): void
  active(): SidebarTabLike | undefined
  isExpanded(): boolean
  toggleExpanded(): void
  tabsIn(sessionId: string): readonly SidebarTabLike[]
  mounted: ObservableSnapshotLike<string | undefined>
  registerCloseHandler?(
    kind: string,
    handler: (sessionId: string, tab: SidebarTabLike) => void,
  ): Disposable
}

/** Per-session composer input machine reachable through `ctx.conversation`. */
export interface SessionInputLike {
  setDraft(text: string): void
  notify(level: 'info' | 'error', text: string): void
}

/** `ctx.conversation` — scope-addressed conversation verbs. */
export interface ConversationLike {
  readonly input: { for(actx: unknown): SessionInputLike }
}

/**
 * `ctx.layout` — the only geometry face `ILayout` exposes to other plugins
 * (`$PKG/dsh-client-ui-layout/lib/types/client/service.d.ts:29-51`).
 */
export interface LayoutLike {
  /** Select a global central panel, or `null` to show the Conversation. */
  selectPanel?(panelId: string | null): void
  /**
   * Report the right panel's presentation: `track` reserves a normal grid track
   * (the centre concedes), `fullscreen` covers the frame instead.
   */
  openRightbar(track: boolean, fullscreen: boolean): void
  /** Report the right panel as hidden: no track, no handle. */
  closeRightbar(): void
}

/** One guide capsule the official right Sidebar's guide page offers. */
export interface SidebarRightGuideEntryLike {
  readonly id: string
  readonly order: number
  readonly title: () => string
  readonly description?: (() => string) | undefined
  /** Glyph component rendered by the shipped guide's EntryBox; defaults to its cube. */
  readonly icon?: unknown
}

/** Stage-one definition accepted by the official right-Sidebar tab registry. */
export interface SidebarRightTabDefinitionLike {
  readonly id: string
  readonly kind: string
  readonly priority?: 'extension' | 'builtin' | 'fallback' | undefined
  readonly multiple?: boolean | undefined
  readonly keepMounted?: boolean | undefined
  readonly patterns?: readonly string[] | undefined
  readonly title: (address: string) => string
  readonly guide?: readonly SidebarRightGuideEntryLike[] | undefined
}

/**
 * `ctx.sidebarRightTabs` — stage one of the official right Sidebar's two-stage
 * tab registration (`$PKG/dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts:151-161`).
 * Probed, never injected: this plugin must keep working without the package.
 */
export interface SidebarRightTabsLike {
  register(definition: SidebarRightTabDefinitionLike): Disposable
}

/** Command execution result carried on the command-channel RPC. */
export interface CommandExecutionLike {
  readonly result:
    | { readonly kind: 'success'; readonly text?: string | undefined }
    | { readonly kind: 'error'; readonly text: string }
}

/** `RemoteResult` — carrier failures fold into the error branch. */
export type RemoteResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message?: string | undefined; readonly code?: string | undefined } }

/** `remote.commands` — the frozen transport this plugin rides. */
export interface CommandsRemoteLike {
  execute(
    agentId: string,
    line: string,
    submittedAttachments: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<RemoteResultLike<CommandExecutionLike | undefined>>
}

/** Slot registry face (`ctx.slots`), narrowed to the two calls used here. */
export interface SlotRegistryLike {
  inject(key: string, callback: () => Disposable | Iterable<Disposable>): Disposable
  register(options: Record<string, unknown>, component: unknown): Disposable
}

/** Locale registry face (`ctx.locale`), narrowed to registration + binding. */
export interface LocaleLike {
  register(ns: string, dicts: Record<string, Record<string, string>>): Disposable
  bind?(ns: string): (key: string, params?: Record<string, unknown>) => string
}

/** The slice of the client root context this plugin actually touches. */
export interface ClientContextLike {
  effect(setup: () => unknown, label: string): unknown
  get(name: string): unknown
  /** Cordis conditional-plugin shorthand; absent in minimal harnesses. */
  inject?(deps: readonly string[], callback: (ctx: unknown) => unknown): unknown
  slots: SlotRegistryLike
  locale: LocaleLike
  sessions: SessionsLike
}

/**
 * Read an optional Cordis service through `get`, which yields `undefined`
 * instead of throwing on an undeclared path. Never read these off the context
 * as properties: `ctx.shortcuts` on an undeclared path throws.
 */
export function optionalService<T>(ctx: { get(name: string): unknown }, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/** One key chord inside a shortcut default. */
export interface ShortcutChordLike {
  readonly code: string
  readonly modifiers?: readonly string[] | undefined
}

/** A registered global shortcut (structural match for the shipped registry). */
export interface ShortcutDefinitionLike {
  readonly id: string
  readonly label: () => string
  readonly aliases?: readonly string[] | undefined
  readonly defaults: { readonly [runtimePlatform: string]: ShortcutChordLike }
  readonly regions?: readonly string[] | undefined
  readonly modals?: readonly string[] | undefined
  resolve(request: { target?: unknown }): { status: 'handled'; run(): void } | { status: 'blocked'; reason?: string }
}

/** `ctx.shortcuts` structural face. */
export interface ShortcutsLike {
  register(definition: ShortcutDefinitionLike): Disposable
}

/** One composer slash command contribution (`ctx.commandUi.register`). */
export interface CommandContributionLike {
  readonly name: string
  readonly label?: () => string | undefined
  readonly description?: () => string | undefined
  readonly icon?: unknown
  available?(sessionId?: string): boolean
  readonly ui: {
    readonly kind: 'action'
    run(session?: { id?: string } | string): void
  }
}

/** `ctx.commandUi` structural face. */
export interface CommandUiLike {
  register(contribution: CommandContributionLike): Disposable
}

/** Tab record as the official right Sidebar exposes it through useTabInfo. */
export interface TabRecordLike {
  readonly id: string
  readonly kind?: string
  readonly signal?: AbortSignal
  readonly [key: string]: unknown
}

/** Hook result of the session-scoped `useTabInfo` framework share. */
export interface TabInfoResult {
  readonly tab?: TabRecordLike
}

/** The session-scoped `useTabInfo` framework share. */
export interface TabInfoLike {
  readonly useTabInfo?: () => TabInfoResult | undefined
}

/**
 * Every framework share a registered slot component may receive. Components
 * read them defensively: the same component is mounted in Path A and Path B.
 */
export interface FrameworkShares {
  readonly t?: ((key: string) => string) | undefined
  readonly sessionId?: string | undefined
  readonly active?: boolean | undefined
  readonly width?: number | undefined
  readonly SessionProvider?: ComponentTypeLike | undefined
  readonly renderSlot?: (key: string, owner: Record<string, unknown>, options?: { fallback?: ReactNodeLike }) => ReactNodeLike
  readonly renderFactorySlot?: unknown
  readonly useSessions?: (<T>(selector: (state: SessionListStateLike) => T) => T) | undefined
  readonly sessions?: SessionsLike | undefined
}

import type { ComponentType, ReactNode } from 'react'

/** Framework SessionProvider component type. */
export type ComponentTypeLike = ComponentType<Record<string, unknown> & { children?: ReactNode }>

/** ReactNode structural alias. */
export type ReactNodeLike = ReactNode
