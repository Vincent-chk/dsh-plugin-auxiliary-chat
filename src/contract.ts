/**
 * FROZEN cross-half interface for the sidebar auxiliary-chat plugin.
 *
 * Both halves live in this repo, so this file is the single source of truth
 * every implementer reads before writing code. Changing a name or a shape here
 * requires changing it in BOTH halves in the same commit.
 *
 * Package: @dsh-ext/dsh-plugin-auxiliary-chat
 * Host half:   src/index.ts, src/host/**
 * Client half: src/client/**
 * @module contract
 */

/** Package name; also the id every registration of this plugin carries. */
export const PACKAGE_NAME = '@dsh-ext/dsh-plugin-auxiliary-chat'

/** Locale namespace of every label this plugin renders. */
export const LOCALE_NS = 'aux-chat'

/**
 * Identity every seat of this plugin registers under.
 *
 * The auxiliary chat lives INSIDE the conversation as a right-hand split column
 * (the frame's `rightbar`), not as a global panel: the frame's own contract says
 * the expand control "is a button in the conversation header", so the toggle is
 * a `conversation.session.header.utilities` row and the panel occupies
 * `rightbar` (with its own `rightbar.session` child) while the shipped right
 * Sidebar is absent. Both use this id; the official-tab path uses it as the tab
 * type id and the `sidebar.right.pane.tab` key.
 */
export const PANEL_ID = PACKAGE_NAME

/** Custom slot owned by this plugin: the session-scoped conversation hole. */
export const SLOT_AUX_CHAT = 'aux-chat.conversation'

/** Toggle seat: the conversation header's right-aligned utilities row. */
export const SLOT_HEADER_TOGGLE = 'conversation.session.header.utilities'

/** Retain-source label for client references this plugin holds. */
export const RETAIN_SOURCE = 'auxChatPanel'

/** Title prefix every auxiliary session carries, so it stays recognisable if it ever surfaces. */
export const TITLE_PREFIX = '[辅助]'

/** Fallback label when the mirrored main session has no readable title. */
export const TITLE_UNNAMED = '未命名会话'

/**
 * Identity of the Host process/boot that owns an auxiliary session.
 *
 * PRD v2.0 R01/R10/T12: a close request carries the generation it was captured
 * with, so a request that outlived a Host restart is refused instead of
 * landing on whatever now lives under the same session id. Minted once per
 * host-side `apply()`.
 */
export interface HostGeneration {
  readonly kind: 'aux-chat.host-generation'
  readonly value: string
}

/** One auxiliary session as the Host knows it, without any live handle. */
export interface AuxSessionInfo {
  /** Durable session identity. */
  readonly sessionId: string
  /** Main session this auxiliary session mirrored at creation time (frozen at capture; R01). */
  readonly mirrorOf: string
  /** Working directory the auxiliary agent runs in (inherited from the mirror). */
  readonly cwd: string
  /** Provider route currently selected for this auxiliary session. */
  readonly provider?: string
  /** Model id currently selected for this auxiliary session. */
  readonly model?: string
  /** Reasoning effort currently selected for this auxiliary session. */
  readonly reasoningEffort?: string
  /** Permission preset name currently applied to this auxiliary session. */
  readonly permissionPreset: string
  /** Creation time, Unix epoch ms. */
  readonly createdAt: number
  /** Host boot generation that owns this resource (PRD v2.0 §4.2). */
  readonly hostGeneration?: string
}

/**
 * What the auxiliary session actually inherited from the main session, as
 * DELIVERED (not as intended). Reported so the panel can state the truth: the
 * earlier copy claimed "已引用主会话上下文" unconditionally, which was wrong
 * whenever the injection or its fallback section failed.
 */
export interface AuxInheritedReport {
  /** `full` = committed transcript injected; `summary` = condensed digest in the system prompt; `none` = history mirroring off. */
  readonly form: 'full' | 'summary' | 'none'
  /** Entries delivered (transcript entries, or summary lines). */
  readonly entries: number
  /** Characters delivered. */
  readonly chars: number
  /** Whether older entries were left out of the delivered window (full form only). */
  readonly truncated: boolean
  /** Entries left out of the window (full form only). */
  readonly omitted: number
}

/** Result of creating one auxiliary session. */
export interface AuxCreateResult {
  readonly info: AuxSessionInfo
  /** Non-fatal problems while mirroring context; reported to the panel, never fatal. */
  readonly warnings: readonly string[]
  /**
   * Whether the request RE-ATTACHED to an already-registered live auxiliary
   * session instead of initializing a fresh one (PRD v2.0 §7.1: reconnect
   * within the grace window restores the ORIGINAL child; it must never
   * silently create a second one).
   */
  readonly reclaimed?: boolean
  /** What this session actually inherited from the main session (delivered form). */
  readonly inherited?: AuxInheritedReport
}

/** Result of destroying one auxiliary session. */
export interface AuxDisposeResult {
  readonly sessionId: string
  /** True when the durable log directory was found and removed. */
  readonly logRemoved: boolean
  /** True when the projection-cache row was found and removed. */
  readonly cacheRemoved: boolean
  /** True when the plugin's own marker file was found and removed. */
  readonly markerRemoved: boolean
  /** Whether the session was detached from its workspace's sidebar list. */
  readonly workspaceDetached?: boolean
  /** Echo of the close-operation id the client minted (PRD v2.0 §6.3/§9). */
  readonly operationId?: string
}

/** Result of the boot-time sweep over crashed leftovers. */
export interface AuxSweepResult {
  readonly swept: readonly string[]
}
