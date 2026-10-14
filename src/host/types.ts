/**
 * Structural view of the Host surface this plugin uses.
 *
 * The host half deliberately imports NO runtime value from any
 * `@deepseek-ai/*` package except the Cordis context it is handed. Two reasons,
 * both verified:
 *
 * 1. Node resolves ESM through real paths, so a plugin installed as a symlink
 *    into a profile (`pnpm add file:...`) resolves its own imports from its
 *    REAL location — where no `@deepseek-ai/dsh-*` package exists. A static
 *    import there would abort plugin load and the panel would never appear.
 * 2. Everything needed is reachable through the context services, so the
 *    plugin loads even when a service is absent; each absence is reported as a
 *    warning instead of a crash.
 *
 * @module host/types
 */
import type { AuxChatRegistry } from './registry.ts'

/** One auxiliary session as Host knows it (mirrors `AuxSessionInfo`). */
export interface AuxSessionInfo {
  readonly sessionId: string
  readonly mirrorOf: string
  readonly cwd: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly permissionPreset: string
  readonly createdAt: number
  /** Host boot generation that owns this resource (PRD v2.0 §4.2). */
  readonly hostGeneration?: string
}

/** Result of initializing one client-created session as auxiliary. */
export interface AuxCreateResult {
  readonly info: AuxSessionInfo
  readonly warnings: readonly string[]
  /**
   * Whether the context is a SUMMARY DOWNGRADE rather than a verbatim fork.
   * The panel is expected to say so; PRD §06 forbids presenting a summary as
   * if it were the full reference history.
   */
  readonly downgrade: 'full' | 'summary' | 'none'
  /**
   * What was ACTUALLY delivered (transcript window / digest / nothing), so the
   * panel can state the truth instead of claiming a mirror that failed.
   */
  readonly inherited?: AuxInheritedReport
  /** True when an already-registered live session was re-attached (reclaim). */
  readonly reclaimed?: boolean
}

/**
 * Delivered-inheritance report (frozen shape, mirror of the contract type).
 * Host types are hand-written here so the two halves stay independent.
 */
export interface AuxInheritedReport {
  readonly form: 'full' | 'summary' | 'none'
  readonly entries: number
  readonly chars: number
  readonly truncated: boolean
  readonly omitted: number
}

/** A minted agent scope (the `createScope` return, structurally typed). */
export interface HostScope {
  /** The scoped Cordis context registrations are made through. */
  readonly ctx: HostContext
  /** Tear every registration in this scope fiber down. */
  dispose(): Promise<void>
}

/** The Workspace entity surface this plugin uses. */
export interface HostWorkspace {
  /** Attach one session to this workspace (validates its header cwd). */
  attachSession(sessionId: string): Promise<void>
  /** Remove one session from the workspace's session list (sidebar membership). */
  detachSession?(sessionId: string): Promise<void>
}

/** The Workspace registry surface this plugin uses. */
export interface HostWorkspaceRegistry {
  /**
   * Archive one session durably; without `stopActivity` it rejects with
   * `WorkspaceActiveSessionError` when the session is judged active.
   */
  archiveSession(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void>
  /** Drop one id from the durable registry-global archive set. */
  unarchiveSession?(sessionId: string): Promise<void>
  /** The registry-global archive set, when the service exposes it. */
  readonly archivedSessionIds?: readonly string[]
  /** Resolve the workspace owning one directory, when one exists. */
  resolveByPath?(path: string): Promise<HostWorkspace | undefined>
}

/** One `agent/pre-step` payload, narrowed to what the short-circuit reads. */
export interface HostPreStepPayload {
  readonly agent?: { readonly id?: string; readonly session?: { readonly id?: string } }
  readonly messages?: readonly unknown[]
  readonly turn?: number
  readonly step?: number
  readonly signal?: AbortSignal
}

/** The `agent/pre-step` waterfall decision this plugin may return. */
export interface HostPreStepDecision {
  readonly kind: string
  readonly messages?: readonly unknown[]
}

/** Result of destroying one auxiliary session. */
export interface AuxDisposeResult {
  readonly sessionId: string
  readonly logRemoved: boolean
  readonly cacheRemoved: boolean
  readonly markerRemoved: boolean
  /** Whether the session was detached from its workspace's sidebar list. */
  readonly workspaceDetached: boolean
  /** Echo of the client-minted close-operation id, when the request carried one. */
  readonly operationId?: string
}

/**
 * Close-request binding a client sends with `/aux-end` (PRD v2.0 §6.3).
 *
 * Both fields are optional so the frozen wire stays backward compatible, but
 * a present `hostGeneration` that no longer matches this boot is REFUSED
 * before anything is touched: a close that outlived a Host restart must not
 * land on whatever now lives under the same session id (T12).
 */
export interface AuxDisposeOptions {
  /** Client-minted close-operation id; retries reuse the SAME id (idempotence evidence). */
  readonly operationId?: string
  /** Host boot generation captured at creation time. */
  readonly hostGeneration?: string
}

/** Result of the boot-time sweep over crashed leftovers. */
export interface AuxSweepResult {
  readonly swept: readonly string[]
}

/** Marker file body (`<DSH_HOME>/aux-chat/sessions/<id>.json`). */
export interface AuxMarker {
  readonly sessionId: string
  readonly cwd: string
  readonly createdAt: number
}

/** Per-agent model route (`AgentOptions`). */
export interface HostAgentOptions {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

/**
 * The live Session an Agent drives — read-only projection of what we touch.
 *
 * `surface.nodes` + `deriveEventMessage` are the PUBLIC, non-deprecated way to
 * read the model-visible conversation (the `eventAt` accessor is deprecated for
 * new calls), and they need no package import: the Session object hands them
 * over directly.
 */
export interface HostSession {
  readonly id?: string
  readonly header?: { readonly cwd?: string; readonly parentSession?: string }
  readonly surface?: { readonly nodes?: readonly number[] }
  snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly unknown[]
  deriveEventMessage?: (event: unknown) => unknown
  /**
   * Append one event to the live log. The third argument carries the surface
   * metadata a surface-eligible event (like `user/message`) requires:
   * `{ surfaceOp: 'append' }` — the exact shape the agent loop itself uses
   * (dsh-agent-loop/lib/index.js:1061).
   */
  append?: (type: string, data: unknown, surface?: { surfaceOp?: string; sourceEventSeqs?: readonly number[] }) => unknown
}

/** The live Agent — read-only projection of what we touch. */
export interface HostAgent {
  readonly id: string
  readonly options?: HostAgentOptions
  readonly session: HostSession
  /**
   * The agent's OWN scoped Cordis context (`Agent.ctx` = `Agent.scope.ctx`,
   * minted by `dsh-agent-loop` with `systemPrompt`/`tools` injected). Prompt
   * sections and the tool guard must be registered through THIS context: the
   * plugin's own fiber does not declare those services, and a second
   * `createScope(ctx, agent)` from the plugin's ctx throws
   * `cannot get property "systemPrompt" without inject`.
   */
  readonly ctx?: unknown
  /** Whether a turn is currently running (Agent.status; 'idle' | 'running'). */
  readonly status?: 'idle' | 'running'
  /** Cancel the active turn (Agent.cancel). */
  cancel?(cause: { kind: 'hook'; reason: string }): void
}

/** `AgentHandle`: the capability that owns one created agent's teardown. */
export interface HostAgentHandle {
  readonly agent: HostAgent
  dispose(): Promise<void>
}

/**
 * `CreateAgentOptions` as this plugin fills it.
 *
 * `meta.origin` and `meta.parentSession` are NOT declared, on purpose: the
 * auxiliary session must stay a root agent, because either field would make
 * `remote.session.prompt/cancel/rename` answer `session/agent-busy`
 * (dsh-api-session-controller/lib/types/agent.js:106-122) and freeze the
 * composer this panel reuses. Leaving them out of the type makes that
 * constraint structural rather than a comment.
 */
export interface HostCreateAgentOptions {
  readonly sessionId: string
  readonly meta?: {
    readonly cwd?: string
    readonly isSeeded?: boolean
  }
  readonly agentOptions?: HostAgentOptions
  readonly setup?: (agentCtx: HostAgentCtx, agent: HostAgent) => unknown
}

/**
 * The unpublished agent scope `setup(agentCtx, agent)` receives — or the scope
 * this plugin mints post-creation with `createScope(ctx, agent)`.
 *
 * Registrations made through it are owned by that agent's scope and unwind with
 * it (the shipped `applyChildComposition(childCtx, …)` precedent). The prompt
 * section and the tool guard are the only registrations needed here.
 */
export interface HostAgentCtx {
  readonly systemPrompt?: {
    section(section: {
      readonly name: string
      readonly order: number
      readonly text: string
      readonly interpolate?: boolean
    }): unknown
  }
  readonly tools?: {
    /** Register one scoped, monotonic tool-call denial guard. */
    guard?(guard: (exec: { name?: unknown }) => string | undefined): unknown
  }
}

/** One command invocation as the registry delivers it. */
export interface HostCommandInvocation {
  readonly agent?: HostAgent
  readonly rawInput?: string
  readonly attachments?: readonly unknown[]
  readonly signal?: AbortSignal
}

/** `CommandDefinition` as this plugin registers it. */
export interface HostCommandDefinition {
  readonly name: string
  readonly description: string
  readonly recordInput?: boolean
  readonly handler: (invocation: HostCommandInvocation) => unknown
}

/** Cordis context, narrowed to the members this plugin uses. */
export interface HostContext {
  readonly agents: {
    get(id: unknown): HostAgent | undefined
    list?(): readonly HostAgent[]
    create(options: HostCreateAgentOptions): Promise<HostAgentHandle>
  }
  readonly commands: { register(definition: HostCommandDefinition): () => void }
  get(name: string, strict?: boolean): any
  effect?(execute: () => unknown, label?: string): unknown
  readonly baseUrl?: string
  readonly logger?: { warn?(message: string): void; info?(message: string): void; debug?(message: string): void }
  on?(
    name: string,
    listener: (...args: any[]) => unknown,
    options?: { readonly prepend?: boolean } | boolean,
  ): unknown
  off?(name: string, listener: (...args: any[]) => unknown): unknown
}

/** Trace hook: no-op in production, asserted by the offline self-check. */
export type TraceHook = (event: string) => void

/** Everything one create/dispose/sweep call needs. */
export interface HostDeps {
  readonly ctx: HostContext
  readonly registry: AuxChatRegistry
  readonly home: string
  /** Lazy loader for the few Host packages whose values we cannot reach via ctx. */
  readonly loadDsh: () => Promise<DshModules>
  readonly now: () => number
  /**
   * Session ids this plugin created and still owns — the authorization set the
   * archive short-circuit consults, and the ONLY ids it will ever answer for.
   */
  readonly owned: Set<string>
  /** Whether created sessions are archived (hidden from the sidebar) at all. */
  readonly hideFromSidebar: boolean
  /** Whether the main session's content (summary + prompt) is mirrored at all. */
  readonly mirrorHistory: boolean
  /**
   * Character budget for the FULL committed-transcript injection (form A).
   * A rendering that exceeds it falls back to the condensed summary section.
   */
  readonly mirrorMaxChars: number
  /**
   * Identity of THIS host boot, minted once per `apply()` (PRD v2.0 §4.2
   * `hostIdentity`). Returned with every create result and cross-checked by
   * every dispose request, so requests from a dead boot generation are
   * refused instead of misrouted.
   */
  readonly hostGeneration: string
  /** Diagnostics only; never load-bearing. */
  readonly trace?: TraceHook
}

/** Lazily importable Host helpers, all optional so absence degrades to warnings. */
export interface DshModules {
  /** `renderPrompt(assembly)` from `@deepseek-ai/dsh-system-prompt`. */
  renderPrompt?: (assembly: unknown) => string
  /** `renderContextSnapshot(assembly)` from `@deepseek-ai/dsh-system-prompt`. */
  renderContextSnapshot?: (assembly: unknown) => string
  /** `createScope(ctx, key)` from `@deepseek-ai/dsh-scope`. */
  createScope?: (parent: HostContext, key: unknown) => HostScope
  /** Which resolution step answered, for diagnostics. */
  readonly loaded?: readonly string[]
}
