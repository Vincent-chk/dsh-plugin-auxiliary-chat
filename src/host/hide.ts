/**
 * Sidebar hiding through the workspace archive set — WITHOUT the capability
 * loss that made the previous attempt (2026-10-14, round 6) unusable.
 *
 * ## Why the archive channel is the only one
 *
 * The shipped sidebar's row filter (`dsh-client-ui-workspace` `sessionVisible`)
 * hides exactly two kinds of session: `origin === "subagent"` (freezes this
 * panel's composer through `session/agent-busy`, so unusable) and ids in the
 * workspace registry's **archive set** (`archivedFilter: "default"`), which
 * also keeps them out of search. That set is registry-global and durable.
 *
 * ## Why archiving used to break the auxiliary chat
 *
 * `@deepseek-ai/dsh-api-session-controller` composes `ArchivedSessionGate`
 * unconditionally: for a step whose session is in the archive set it answers
 * `agent/pre-step` with `{ kind: "reject" }` and the turn ends `blocked` with
 * no model request. Round 6 worked around that by ANSWERING the step itself
 * (`{kind:'enter'}` without `next()`), which vetoed the rest of the waterfall
 * and silently dropped the runtime-context snapshot plus every other
 * `agent/pre-step` contribution (17 shipped listeners). That trade is what
 * kept `hideFromSidebar` off by default.
 *
 * ## What this module does instead
 *
 * The gate re-reads `workspaceRegistry.archivedSessionIds` LIVE at every step,
 * and it is registered by an earlier bundle, so a `prepend: true` listener of
 * ours runs BEFORE it. The bridge therefore:
 *
 *   1. on `agent/pre-step` for a session this plugin owns, AWAITS
 *      `unarchiveSession(id)` (durable, serialized by the registry's
 *      operation queue) and THEN calls `next()`;
 *   2. the gate — running inside `next()` — reads the live set, no longer
 *      sees the id, and passes;
 *   3. every other listener AND the loop's own base decision (the runtime
 *      context snapshot) still contribute: the chain is intact.
 *
 * The session is then re-archived when its agent goes idle (the
 * `agent/status` event, routed by `agent.id` exactly the way the session
 * controller itself routes it), so the row disappears again within one idle
 * transition. While a turn is RUNNING the row is visible — that window is
 * inherent to the channel and is documented, not hidden.
 *
 * ## Residual boundaries (documented, accepted)
 *
 * - `archivedFilter: "only"` (仅看归档) still lists auxiliary sessions.
 * - During an active turn the row is visible (archive lifted for the step
 *   chain; re-hidden on idle).
 * - If the Host dies mid-turn the id stays unarchived; the boot ledger sweep
 *   (dispose.ts `sweepArchiveLedger`) reconciles destroyed ids, and a live
 *   auxiliary re-archives on its next idle transition after re-init.
 *
 * @module host/hide
 */
import { isActiveSessionError, delay } from './guards.ts'
import type { HostContext, HostDeps, HostPreStepDecision, HostPreStepPayload } from './types.ts'

/** Registry face this module uses, narrowed structurally. */
type ArchiveRegistry = {
  readonly archivedSessionIds?: readonly string[]
  unarchiveSession?(sessionId: string): Promise<void>
  archiveSession?(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void>
}


/**
 * Visibility face a future DSH seam may provide (refactor plan v2 P2/WP2.2,
 * seam request S1): hide a session from lists/search WITHOUT touching its
 * runnability — the decoupling ZCode has natively and DSH lacks today.
 */
export interface SessionVisibilityFace {
  hideFromLists?(sessionId: string): Promise<void> | void
  revealInLists?(sessionId: string): Promise<void> | void
}

export type HideChannelKind = 'archive-bridge' | 'native'

export interface ResolvedHideChannel {
  readonly kind: HideChannelKind
  readonly face: SessionVisibilityFace | undefined
}

/** Probe the optional native visibility face; absent today, wired for S1. */
export function probeVisibilityFace(deps: HostDeps): SessionVisibilityFace | undefined {
  try {
    const face = deps.ctx.get('sessionVisibility') as SessionVisibilityFace | undefined
    return face !== undefined && face !== null && typeof face.hideFromLists === 'function' ? face : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve which hiding channel owns this boot: config override → native face
 * → archive-bridge fallback. `native` without a face degrades with a trace.
 */
export function resolveHideChannel(deps: HostDeps): ResolvedHideChannel {
  const preference = deps.hideChannel ?? 'auto'
  const face = probeVisibilityFace(deps)
  if (preference === 'archive') return { kind: 'archive-bridge', face: undefined }
  if (face !== undefined) return { kind: 'native', face }
  if (preference === 'native') {
    deps.trace?.('hide:native-requested-but-absent; falling back to archive-bridge')
  }
  return { kind: 'archive-bridge', face: undefined }
}

/**
 * Hide one owned session through the resolved channel. `archive` is the
 * bridge implementation injected by create.ts (it owns the registry write).
 */
export async function hideThroughChannel(
  deps: HostDeps,
  channel: ResolvedHideChannel,
  sessionId: string,
  warnings: string[],
  archive: (deps: HostDeps, sessionId: string, warnings: string[]) => Promise<unknown>,
): Promise<void> {
  if (channel.kind === 'native' && channel.face?.hideFromLists !== undefined) {
    try {
      await channel.face.hideFromLists(sessionId)
      deps.trace?.(`hide:native ${sessionId}`)
      return
    } catch (error) {
      warnings.push(`native visibility hide failed (${error instanceof Error ? error.message : String(error)}); archived instead`)
    }
  }
  await archive(deps, sessionId, warnings)
}

/** Read the workspace registry off the context, when it is present. */
function registryOf(deps: HostDeps): ArchiveRegistry | undefined {
  try {
    const registry = deps.ctx.get('workspaceRegistry') as ArchiveRegistry | undefined
    return registry ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Lift the archive for one owned session so the gate (and the rest of the
 * waterfall) sees it unarchived. Absent registry, missing methods, and the
 * registry's early-boot `requireState()` refusal are all quiet no-ops: the
 * step still proceeds through `next()`, worst case the gate rejects that one
 * step and the next send retries.
 */
export async function liftArchiveForStep(deps: HostDeps, sessionId: string): Promise<void> {
  const registry = registryOf(deps)
  if (typeof registry?.unarchiveSession !== 'function') return
  let archived: readonly string[] | undefined
  try {
    archived = registry.archivedSessionIds
  } catch {
    return
  }
  if (!Array.isArray(archived) || !archived.includes(sessionId)) return
  await registry.unarchiveSession(sessionId)
  deps.trace?.(`hide:lift ${sessionId}`)
}

/**
 * Install the pre-step bridge (see module doc). MUST be `prepend: true`:
 * the gate is composed by an earlier bundle, so a plain registration would
 * run after it and never get the chance to lift the archive.
 *
 * @param ctx - Host context.
 * @param owned - the authorization set of auxiliary session ids.
 * @param deps - Host dependencies (trace).
 * @returns the listener disposer, when the context accepts event listeners.
 */
export function installArchiveStepBridge(ctx: HostContext, owned: Set<string>, deps: HostDeps): unknown {
  const listener = (
    payload: HostPreStepPayload,
    next: () => Promise<HostPreStepDecision>,
  ): Promise<HostPreStepDecision> => {
    const id = payload?.agent?.id ?? payload?.agent?.session?.id
    if (typeof id !== 'string' || !owned.has(id)) return next()
    return liftArchiveForStep(deps, id).then(
      () => next(),
      (error: unknown) => {
        deps.trace?.(`hide:lift-failed ${id}: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`)
        return next()
      },
    )
  }
  if (typeof ctx.on !== 'function') return undefined
  return ctx.on('agent/pre-step', listener, { prepend: true })
}

/**
 * Re-archive one auxiliary session once its agent is idle. A quiet, bounded
 * retry covers the registry's `WorkspaceActiveSessionError` (activity is
 * re-checked just before the write); anything else is traced and left to the
 * next idle transition or the boot ledger sweep.
 */
async function rearchiveWhenIdle(deps: HostDeps, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Re-check idleness right before the write: a prompt that arrived after
    // the idle event must not be archived mid-turn.
    let running = false
    try {
      running = deps.ctx.agents.get(sessionId)?.status === 'running'
    } catch {
      running = false
    }
    if (running) {
      deps.trace?.(`hide:rehide-skipped-running ${sessionId}`)
      return
    }
    // Native-channel sessions are hidden without archiving; archiving them
    // would re-couple visibility to runnability (plan v2 P2/WP2.2).
    if (resolveHideChannel(deps).kind === 'native') return
    if (!deps.owned.has(sessionId)) return
    const registry = registryOf(deps)
    if (typeof registry?.archiveSession !== 'function') return
    try {
      // Idempotent: an id already in the set resolves without writing.
      await registry.archiveSession(sessionId)
      if (attempt > 0) deps.trace?.(`hide:rehide ${sessionId} (attempt ${String(attempt + 1)})`)
      else deps.trace?.(`hide:rehide ${sessionId}`)
      return
    } catch (error) {
      if (isActiveSessionError(error) && attempt < 2) {
        await delay(150)
        continue
      }
      deps.trace?.(`hide:rehide-failed ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
  }
}

// One in-flight re-archive per id, so a burst of idle transitions (a multi-
// step turn settling) produces one registry write, not one per event.
const rehideInFlight = new Set<string>()

/**
 * Watch `agent/status` and re-hide an auxiliary session when it goes idle.
 * The payload carries the full `agent` (fused by `agentEvents`), and untagged
 * root-context listeners receive every agent's events — the same routing the
 * session controller itself uses for `api-session/status`.
 *
 * @param ctx - Host context.
 * @param owned - the authorization set of auxiliary session ids.
 * @param deps - Host dependencies.
 * @returns the listener disposer, when the context accepts event listeners.
 */
export function installIdleRearchiver(ctx: HostContext, owned: Set<string>, deps: HostDeps): unknown {
  const listener = (payload: { agent?: { id?: unknown }; status?: unknown }): void => {
    const id = payload?.agent?.id
    if (typeof id !== 'string' || payload?.status !== 'idle') return
    if (!owned.has(id) || rehideInFlight.has(id)) return
    rehideInFlight.add(id)
    void rearchiveWhenIdle(deps, id).finally(() => {
      rehideInFlight.delete(id)
    })
  }
  if (typeof ctx.on !== 'function') return undefined
  return ctx.on('agent/status', listener)
}
