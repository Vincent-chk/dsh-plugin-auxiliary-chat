/**
 * Published type surface of the host half.
 *
 * Declaration only, and deliberately self-contained: the runtime contract lives
 * in `src/contract.ts` (frozen, shared by both halves), while this file is what
 * an editor reads when it opens `@dsh-ext/dsh-plugin-auxiliary-chat`. It imports
 * nothing at runtime and needs no `@deepseek-ai/*` resolution.
 *
 * @module @dsh-ext/dsh-plugin-auxiliary-chat
 */

/** One auxiliary session as the Host knows it. */
export interface AuxSessionInfo {
  readonly sessionId: string
  readonly mirrorOf: string
  readonly cwd: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly permissionPreset: string
  readonly createdAt: number
}

/** Payload of a successful `/aux-chat` execution. */
export interface AuxCreatePayload {
  readonly ok: true
  readonly info: AuxSessionInfo
  readonly warnings: readonly string[]
}

/** Payload of a successful `/aux-end` execution. */
export interface AuxDisposePayload {
  readonly ok: true
  readonly sessionId: string
  readonly logRemoved: boolean
  readonly cacheRemoved: boolean
  readonly markerRemoved: boolean
}

/** The subset of the Cordis context this plugin requires. */
export interface AuxChatHostContext {
  readonly agents: unknown
  readonly commands: { register(definition: unknown): () => void }
  get(name: string, strict?: boolean): unknown
  effect?(execute: () => unknown, label?: string): unknown
  readonly baseUrl?: string
  readonly logger?: { warn?(message: string): void; info?(message: string): void }
}

/** Cordis service keys the plugin waits for. */
export declare const inject: string[]
/** Loader entry name. */
export declare const name: string
/** No configuration. */
export declare const Config: undefined
/**
 * Install the host half.
 * @param ctx - the Cordis context provided by the Loader.
 */
export declare function apply(ctx: AuxChatHostContext): void
