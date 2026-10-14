/**
 * Host half entry point: wire the registry, the two internal commands, and the
 * boot sweep into the Cordis context.
 *
 * Transport: the browser↔Host channel is the official `remote.commands`
 * namespace, because a third-party plugin cannot add a Typert Remote namespace
 * (the descriptors are build-time generated). The frozen line format lives in
 * `docs/REMOTE-CONTRACT.md`:
 *
 *   /aux-chat {"sessionId":"session-<uuid>","mirrorOf":"session-<uuid>"}
 *   /aux-end  {"sessionId":"session-<uuid>"}
 *
 * Both are registered with `recordInput: false`. That is not cosmetic: the
 * `command/run` event is written into the TARGET session's log, so recording the
 * input would copy the auxiliary session id and creation payload into the MAIN
 * session log — exactly the leakage this plugin must not have.
 *
 * @module host/apply
 */
import { randomUUID } from 'node:crypto'
import { resolveDshHome } from './env.ts'
import { bestEffortCleanup, initAuxSession } from './create.ts'
import { installArchiveStepBridge, installIdleRearchiver } from './hide.ts'
import { disposeAuxSession, sweepAuxSessions, sweepHeaderOnlyAuxSessions, sweepArchiveLedger } from './dispose.ts'
import { importHostPackage, makeDshLoader } from './dsh-modules.ts'
import { describeError, reasonOf, AuxChatError } from './errors.ts'
import { AuxChatRegistry } from './registry.ts'
import type { AuxSweepResult, HostCommandInvocation, HostContext, HostDeps, HostPreStepDecision, HostPreStepPayload } from './types.ts'

/**
 * Config schema, resolved at module scope because Cordis reads `Config` before
 * it calls `apply`.
 *
 * The import is deliberately NOT static. `@deepseek-ai/schemastery` does not
 * resolve from this plugin's own path on a symlinked install — it was measured:
 * `import('@deepseek-ai/schemastery')` from the repository root fails with
 * `ERR_MODULE_NOT_FOUND` — so a static import would abort plugin load together
 * with the panel. Falling back to `undefined` keeps the plugin alive; Cordis
 * then passes the raw config through untouched
 * (`resolveConfig`: `if (!runtime.Config) return config`), which `apply` reads
 * with the same defaults.
 */
const schemastery = await importHostPackage(undefined, '@deepseek-ai/schemastery')
const z = schemastery?.['default'] as
  | {
      object(shape: Record<string, unknown>): unknown
      boolean(): { default(value: boolean): unknown }
      number(): { default(value: number): unknown }
    }
  | undefined

/** Cordis service keys this plugin waits for before it loads. */
export const inject = ['agents', 'sessions', 'commands']

/** Loader entry name. */
export const name = 'aux-chat'

/**
 * Plugin configuration.
 *
 * `hideFromSidebar` (default **true**) archives every auxiliary session right
 * after creation, keeping it out of the sidebar and search. The archive is
 * lifted per admitted step by {@link installArchiveStepBridge} (so the
 * shipped archived-session gate passes while the FULL pre-step chain still
 * contributes) and restored on idle by {@link installIdleRearchiver};
 * `src/host/hide.ts` documents the residual boundaries.
 *
 * `mirrorHistory` (default `true`) controls how much of the MAIN session's
 * content is mirrored into the auxiliary session's prompt section. `false`
 * leaves only the facts.
 */
export const Config =
  z === undefined
    ? undefined
    : z.object({ hideFromSidebar: z.boolean().default(true), mirrorHistory: z.boolean().default(true), mirrorMaxChars: z.number().default(100_000) })

/** Config as `apply` reads it, defaults included. */
export interface AuxChatConfig {
  /**
   * Keep auxiliary sessions out of the sidebar and search through the
   * workspace archive set (default **true**). The capability cost that made
   * this an opt-in before is gone: `installArchiveStepBridge` lifts the
   * archive for each admitted step so the shipped `ArchivedSessionGate`
   * passes while every other `agent/pre-step` contribution still runs, and
   * `installIdleRearchiver` re-hides the session when its agent goes idle.
   * Residual boundaries (仅看归档 lists them; the row is visible while a
   * turn is running) are documented in `src/host/hide.ts`.
   */
  readonly hideFromSidebar?: boolean
  /**
   * Mirror the main session's CONTENT — the conversation summary, its rendered
   * system prompt and its dynamic context snapshot — into the auxiliary
   * session's prompt section (default true). `false` keeps only the facts (cwd,
   * model route, permission preset, goal, todo), so the auxiliary session starts
   * with nothing but its own deployment prompt. Independent of
   * `hideFromSidebar`: the four combinations are all valid.
   */
  readonly mirrorHistory?: boolean
  /**
   * Character budget for the full committed-transcript injection; a rendering
   * above it falls back to the condensed summary (default 100 000).
   */
  readonly mirrorMaxChars?: number
}

/** Command line descriptions, shown by command discovery UI. */
const DESCRIPTIONS = {
  // Short on purpose: the Host command catalog has no visibility flag, so these
  // rows surface in every composer's "/" menu (platform limitation recorded in
  // README "平台约束"). The payload schema stays documented in the file header
  // comment — the menu row should say only "internal, do not invoke by hand".
  init: '内部指令：辅助会话初始化（请勿手动调用）',
  end: '内部指令：销毁辅助会话（请勿手动调用）',
} as const

/**
 * Parse the one-line JSON payload of a command invocation.
 * @param rawInput - exact text after the command name.
 * @returns the parsed object.
 * @throws {AuxChatError} `aux-chat/bad-payload` when it is not a JSON object.
 */
function parsePayload(rawInput: unknown): Record<string, unknown> {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (text === '') throw new AuxChatError('aux-chat/bad-payload', 'expected a one-line JSON payload')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new AuxChatError('aux-chat/bad-payload', `payload is not valid JSON: ${text.slice(0, 200)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuxChatError('aux-chat/bad-payload', 'payload must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Read one required string field. */
function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value === '') throw new AuxChatError('aux-chat/bad-payload', `payload field "${key}" must be a non-empty string`)
  return value
}

/**
 * Assemble the host dependencies from the Cordis context.
 * @param ctx - Host context.
 * @param config - resolved plugin configuration.
 * @param owned - the live ownership set (shared with the archive step bridge).
 * @param hostGeneration - identity of this host boot (PRD v2.0 §4.2); minted
 *   once per `apply()` and threaded into every create result / dispose check.
 * @returns the dependency bundle handed to create/dispose/sweep.
 */
export function createHostDeps(ctx: HostContext, config?: AuxChatConfig, owned: Set<string> = new Set(), hostGeneration = 'gen-unknown'): HostDeps {
  const trace = (event: string): void => {
    try {
      ctx.logger?.info?.(`aux-chat ${event}`)
    } catch {
      /* logging must never be load-bearing */
    }
  }
  return {
    ctx,
    registry: new AuxChatRegistry(),
    home: resolveDshHome(),
    loadDsh: makeDshLoader(ctx),
    now: () => Date.now(),
    owned,
    hostGeneration,
    // Opt-OUT now: hiding is the default the operator asked for, and the
    // archive channel no longer costs any capability (see `hide.ts`). The
    // default holds in all three shapes the config can arrive in:
    // schema-validated, raw passthrough when the schema could not be resolved
    // (`{}`), and a direct `apply(ctx)` call.
    hideFromSidebar: config?.hideFromSidebar !== false,
    // Opt-OUT, because mirroring is the feature the panel exists for.
    mirrorHistory: config?.mirrorHistory !== false,
    mirrorMaxChars:
      typeof config?.mirrorMaxChars === 'number' && Number.isFinite(config.mirrorMaxChars) && config.mirrorMaxChars >= 1000
        ? Math.floor(config.mirrorMaxChars)
        : 100_000,
    trace,
  }
}

/**
 * Register one command inside an effect so a plugin reload unregisters it.
 * @param ctx - Host context.
 * @param definition - the command to register.
 */
function registerCommand(ctx: HostContext, definition: Parameters<HostContext['commands']['register']>[0]): void {
  if (typeof ctx.effect === 'function') ctx.effect(() => ctx.commands.register(definition), 'aux-chat: commands')
  else ctx.commands.register(definition)
}

/**
 * Install the host half.
 * @param ctx - Host context provided by the Loader.
 * @param config - plugin configuration resolved against {@link Config}.
 */
export async function apply(ctx: HostContext, config?: AuxChatConfig): Promise<void> {
  const owned = new Set<string>()
  // PRD v2.0 §4.2 `hostIdentity`: one identity per boot. Every create result
  // carries it and every close request may echo it back; a mismatch is a
  // request that outlived this Host and is refused (T12) instead of being
  // applied to whatever now lives under the same session id.
  const hostGeneration = `gen-${randomUUID()}`
  const deps = createHostDeps(ctx, config, owned, hostGeneration)

  // Registered before the commands so an auxiliary session created by the very
  // first command is already covered by the bridge. Both listeners live only
  // when hiding is on; with hiding off there is nothing archived to lift or
  // re-hide. Failures degrade to the visible-row default, never a failed boot.
  if (deps.hideFromSidebar) {
    try {
      installArchiveStepBridge(ctx, owned, deps)
    } catch (error) {
      deps.trace?.(`archive-step-bridge-failed ${reasonOf(error)}`)
    }
    try {
      installIdleRearchiver(ctx, owned, deps)
    } catch (error) {
      deps.trace?.(`idle-rearchiver-failed ${reasonOf(error)}`)
    }
  }

  registerCommand(ctx, {
    name: 'aux-init',
    description: DESCRIPTIONS.init,
    recordInput: false,
    handler: async (invocation: HostCommandInvocation) => {
      const targetId = invocation.agent?.id
      // Parse the id even out of a malformed invocation, purely for cleanup.
      let candidateId = ''
      let reclaiming = false
      try {
        const payload = parsePayload(invocation.rawInput)
        candidateId = typeof payload['sessionId'] === 'string' ? (payload['sessionId'] as string) : ''
        const sessionId = requireString(payload, 'sessionId')
        const mirrorOf = requireString(payload, 'mirrorOf')
        if (targetId !== undefined && sessionId !== targetId) {
          throw new AuxChatError(
            'aux-chat/wrong-target',
            `/aux-init must run inside the new session it initializes (target "${String(targetId)}", payload "${sessionId}")`,
          )
        }
        const mode = payload['mode'] === 'reclaim' ? 'reclaim' : 'create'
        reclaiming = mode === 'reclaim'
        const requestId = typeof payload['requestId'] === 'string' ? (payload['requestId'] as string) : undefined
        const result = await initAuxSession(deps, { sessionId, mirrorOf, ...(mode === 'reclaim' ? { mode } : {}), ...(requestId === undefined ? {} : { requestId }) })
        // The command row is hidden in the panel by a name-keyed null renderer;
        // its text is still the RPC result the client remote parses.
        return {
          kind: 'success',
          text: JSON.stringify({
            ok: true,
            info: result.info,
            warnings: result.warnings,
            downgrade: result.downgrade,
            ...(result.reclaimed === true ? { reclaimed: true } : {}),
          }),
        }
      } catch (error) {
        deps.trace?.(`command:aux-init error ${describeError(error)}`)
        // A failure after the session was created must not leave a blank
        // uninitialized session behind. Two classes of failure must NOT clean
        // up, because the session they name pre-exists this request and is not
        // ours to roll back:
        //   - a RECLAIM (it created nothing by definition);
        //   - an IDENTITY refusal (parent-mismatch / reclaim-mismatch /
        //     already-initialized): the target is a live session forked from
        //     another parent or an already-running auxiliary — deleting its
        //     artifacts would destroy foreign or in-use state.
        const code = error instanceof AuxChatError ? error.code : ''
        const identityRefusal =
          code === 'aux-chat/parent-mismatch' || code === 'aux-chat/reclaim-mismatch' || code === 'aux-chat/already-initialized'
        if (!reclaiming && !identityRefusal && targetId !== undefined && candidateId === targetId) {
          deps.owned.delete(candidateId)
          deps.registry.remove(candidateId)
          await bestEffortCleanup(deps, candidateId).catch(() => undefined)
        }
        return { kind: 'error', text: describeError(error) }
      }
    },
  })

  registerCommand(ctx, {
    name: 'aux-end',
    description: DESCRIPTIONS.end,
    recordInput: false,
    handler: async (invocation: HostCommandInvocation) => {
      try {
        const payload = parsePayload(invocation.rawInput)
        const sessionId = requireString(payload, 'sessionId')
        // PRD v2.0 §6.3 close binding: both fields are optional (the wire is
        // backward compatible), but when present they pin the close to the
        // exact resource generation it was captured for.
        const operationId = typeof payload['operationId'] === 'string' ? (payload['operationId'] as string) : undefined
        const hostGeneration = typeof payload['hostGeneration'] === 'string' ? (payload['hostGeneration'] as string) : undefined
        const result = await disposeAuxSession(deps, sessionId, {
          ...(operationId === undefined ? {} : { operationId }),
          ...(hostGeneration === undefined ? {} : { hostGeneration }),
        })
        return { kind: 'success', text: JSON.stringify({ ok: true, ...result }) }
      } catch (error) {
        deps.trace?.(`command:aux-end error ${describeError(error)}`)
        return { kind: 'error', text: describeError(error) }
      }
    },
  })

  // Crash leftovers: a marker whose session is not live in this process can only
  // be residue from a process that died before it could destroy its own
  // temporary session. AWAITED (unlike the two sweeps below): these sessions
  // are titled and non-blank, so a client that loads its session list before
  // this sweep finishes renders their rows and keeps them until the next
  // refresh — the exact stale-row residue the operator reported after the
  // 2026-10-14 restart. Awaiting pins completion before this fiber goes
  // active, and the page cannot load a list before the boot graph resolves.
  // The sweep itself is bounded (a handful of markers) and every per-marker
  // failure is caught, so boot cannot hang on it.
  try {
    const result = await sweepAuxSessions(deps)
    if (result.swept.length > 0) deps.trace?.(`boot-sweep ${result.swept.join(',')}`)
  } catch (error) {
    deps.trace?.(`boot-sweep-failed ${describeError(error)}`)
  }
  // Header-only skeletons stranded between sessions.create and /aux-init also
  // outlive their welcome as bare "[辅助]" rows; sweep them the same way.
  // Apply-time, NOT deferred: a sweep that runs after the client has loaded its
  // session list detaches workspace membership underneath an already-rendered
  // row, which strands that row in the "未分组" bucket until the next refresh —
  // the exact residue the operator reported. At apply-time no client exists
  // yet, so the initial list simply never contains the swept sessions. The
  // scan is stat-first and size-capped, so it stays off the boot critical path.
  void sweepHeaderOnlyAuxSessions(deps)
    .then((result: AuxSweepResult) => {
      if (result.swept.length > 0) deps.trace?.(`boot-sweep-skeleton ${result.swept.join(',')}`)
    })
    .catch((error: unknown) => deps.trace?.(`boot-sweep-skeleton-failed ${describeError(error)}`))
  // Archive-ledger reconciliation: ids this plugin hid from the sidebar whose
  // session is now gone leave the registry archive set. Runs last so the
  // marker sweep above has already removed the markers of crashed auxiliaries
  // (a live-or-crashed auxiliary keeps its hidden state; a destroyed one is
  // cleaned). Also apply-time: no client is connected yet.
  void sweepArchiveLedger(deps)
    .then((cleaned: string[]) => {
      if (cleaned.length > 0) deps.trace?.(`boot-sweep-archive-ledger ${cleaned.join(',')}`)
    })
    .catch((error: unknown) => deps.trace?.(`boot-sweep-archive-ledger-failed ${describeError(error)}`))
}
