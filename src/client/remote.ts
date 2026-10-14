/**
 * Command-channel RPC client (frozen wire format: `docs/REMOTE-CONTRACT.md`).
 *
 * Creation is a TWO-PHASE flow, deliberately:
 *
 *   1. `sessions.create({ sessionId, cwd })` materializes a plain empty
 *      session through the official client remote. This writes NOTHING into
 *      any other session's log.
 *   2. `/aux-init {"sessionId","mirrorOf"}` is addressed AT THE NEW SESSION and
 *      configures it as auxiliary (mirror prompt section, tool guard, title,
 *      workspace attachment). The command framework always appends
 *      `command/run` + `command/done` to the ADDRESSED session, so the main
 *      session's transcript stays untouched (PRD R06). The two rows inside the
 *      auxiliary session are hidden by a name-keyed null `commandview`.
 *
 * `/aux-end` is likewise addressed at the auxiliary session itself.
 * @module client/remote
 */
import type { AuxCreateOutcome, ReclaimOutcome } from './store.ts'
import type { ClientContextLike, CommandsRemoteLike, CommandExecutionLike, RemoteResultLike } from './types.ts'
import { describeError } from './store.ts'

/** Command that initializes one already-created session as auxiliary. */
export const INIT_COMMAND = 'aux-init'

/** Command that destroys one auxiliary session for good. */
export const END_COMMAND = 'aux-end'

/** Payload the init command carries. */
export interface InitPayload {
  readonly sessionId: string
  readonly mirrorOf: string
  /** `reclaim`: re-attach to a live registered child instead of creating. */
  readonly mode?: 'reclaim'
  /** Client-minted correlation id (diagnostics). */
  readonly requestId?: string
}

/** Payload the destroy command carries. */
export interface EndPayload {
  readonly sessionId: string
  /** Close-operation id; retries reuse the same id (PRD v2.0 §6.3/§9). */
  readonly operationId?: string
  /** Host boot generation captured at create time; mismatch is refused. */
  readonly hostGeneration?: string
}

/** Init-command success body. */
interface InitReply {
  readonly ok?: boolean
  readonly info?: { readonly cwd?: string; readonly sessionId?: string; readonly hostGeneration?: string } | undefined
  readonly warnings?: readonly string[] | undefined
  readonly downgrade?: 'summary' | 'none' | undefined
  readonly reclaimed?: boolean | undefined
}

/** Destroy-command success body. */
interface EndReply {
  readonly ok?: boolean
  readonly sessionId?: string
}

/**
 * Read `remote.commands` off the client root context.
 * @param ctx - client root context.
 * @returns the commands remote, or `undefined` when the gateway is absent.
 */
export function commandsRemote(ctx: ClientContextLike): CommandsRemoteLike | undefined {
  let remote: unknown
  try {
    remote = typeof ctx.get === 'function' ? ctx.get('remote') : undefined
  } catch {
    return undefined
  }
  const commands = (remote as { commands?: unknown } | undefined)?.commands
  if (commands === undefined || typeof (commands as CommandsRemoteLike).execute !== 'function') {
    return undefined
  }
  return commands as CommandsRemoteLike
}

/**
 * Run one command line and unwrap the frozen `RemoteResult` layers.
 */
async function executeLine(
  commands: CommandsRemoteLike,
  agentId: string,
  line: string,
  signal?: AbortSignal,
): Promise<string> {
  const result: RemoteResultLike<CommandExecutionLike | undefined> = await commands.execute(agentId, line, [], signal)
  if (!result.ok) {
    const code = result.error.code ?? 'transport'
    const message = result.error.message ?? 'unknown carrier failure'
    throw new Error(`${message} (${code})`)
  }
  if (result.value === undefined) {
    throw new Error('辅助会话命令未注册：插件 host 半侧未加载或未生效')
  }
  if (result.value.result.kind === 'error') throw new Error(result.value.result.text)
  return result.value.result.text ?? ''
}

/** Parse one JSON payload, tolerating a host that answered with plain text. */
function parsePayload<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${label} 返回载荷无法解析：${text.slice(0, 200)}`)
  }
}

/**
 * Create the plain session through the official client remote.
 * @param ctx - client root context.
 * @param sessionId - pre-generated auxiliary identity.
 * @param cwd - the main session's working directory; the new session joins the
 *   same workspace, so the panel opens a conversation instead of the
 *   blank-session workspace picker.
 */
export async function createPlainSession(ctx: ClientContextLike, sessionId: string, cwd: string): Promise<void> {
  const create = ctx.sessions?.create
  if (typeof create !== 'function') throw new Error('辅助会话服务不可用（sessions.create 未装配）')
  await create.call(ctx.sessions, { sessionId, ...(cwd === '' ? {} : { cwd }) })
}

/**
 * Initialize an already-created session as auxiliary, addressed AT IT.
 * @param ctx - client root context.
 * @param auxSessionId - the new session, both target and payload subject.
 * @param mirrorOf - main session the context comes from.
 * @param options - optional reclaim mode + request correlation id.
 */
export async function initAuxSession(
  ctx: ClientContextLike,
  auxSessionId: string,
  mirrorOf: string,
  options?: { readonly mode?: 'reclaim'; readonly requestId?: string },
): Promise<AuxCreateOutcome> {
  const commands = commandsRemote(ctx)
  if (commands === undefined) throw new Error('辅助会话服务不可用（命令通道未装配）')
  const payload: InitPayload = {
    sessionId: auxSessionId,
    mirrorOf,
    ...(options?.mode === undefined ? {} : { mode: options.mode }),
    ...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
  }
  const text = await executeLine(commands, auxSessionId, `/${INIT_COMMAND} ${JSON.stringify(payload)}`)
  const reply = parsePayload<InitReply>(text, INIT_COMMAND)
  if (reply.ok === false) throw new Error(`${INIT_COMMAND} 报告初始化失败`)
  return {
    cwd: reply.info?.cwd ?? '',
    warnings: Array.isArray(reply.warnings) ? reply.warnings : [],
    downgrade: reply.downgrade === 'none' ? 'none' : 'summary',
    ...(typeof reply.info?.hostGeneration === 'string' ? { hostGeneration: reply.info.hostGeneration } : {}),
    ...(reply.reclaimed === true ? { reclaimed: true } : {}),
  }
}

/**
 * Re-attach to a previously bound live auxiliary session (PRD v2.0 §7.1).
 *
 * `gone` is returned ONLY for errors that prove the resource no longer
 * exists on this Host (not-created / reclaim-mismatch / stale-generation).
 * Transport failures and unknown errors are rethrown: a network blip must
 * surface as a retryable failure, never as "the session ended".
 */
export async function reclaimAuxSession(ctx: ClientContextLike, auxSessionId: string, mirrorOf: string): Promise<ReclaimOutcome> {
  try {
    const outcome = await initAuxSession(ctx, auxSessionId, mirrorOf, { mode: 'reclaim' })
    return { kind: 'reclaimed', outcome }
  } catch (error) {
    const text = describeError(error)
    if (/aux-chat\/(session-not-created|reclaim-mismatch|stale-generation)/.test(text)) return { kind: 'gone' }
    throw error
  }
}

/** Permanently destroy one auxiliary session (four-step Host teardown). */
export async function endAuxSession(
  ctx: ClientContextLike,
  auxSessionId: string,
  options?: { readonly operationId?: string; readonly hostGeneration?: string },
): Promise<void> {
  const commands = commandsRemote(ctx)
  if (commands === undefined) throw new Error('辅助会话服务不可用（命令通道未装配）')
  const payload: EndPayload = {
    sessionId: auxSessionId,
    ...(options?.operationId === undefined ? {} : { operationId: options.operationId }),
    ...(options?.hostGeneration === undefined ? {} : { hostGeneration: options.hostGeneration }),
  }
  const text = await executeLine(commands, auxSessionId, `/${END_COMMAND} ${JSON.stringify(payload)}`)
  if (text.trim() === '') return
  const reply = parsePayload<EndReply>(text, END_COMMAND)
  if (reply.ok === false) throw new Error(`${END_COMMAND} 报告销毁失败`)
}

export { describeError }
