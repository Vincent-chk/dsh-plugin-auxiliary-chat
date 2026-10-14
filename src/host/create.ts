/**
 * Initializing one auxiliary session — the `/aux-init` command body.
 *
 * ## Why this command is addressed AT THE AUXILIARY SESSION
 *
 * The client first materializes a plain, empty session through the official
 * `sessions.create({ sessionId, cwd })` remote, and THEN sends `/aux-init`
 * to that new session. That ordering is the fix for the transcript leakage
 * the previous design had: the old `/aux-chat` command was addressed at the
 * MAIN session, and the command framework ALWAYS appends `command/run` +
 * `command/done` to the addressed session (`dsh-commands`: the lifecycle is
 * unconditional), so every creation left two command rows in the main
 * conversation. Addressing init at the auxiliary session itself keeps the
 * main log untouched (PRD R06: "默认不向父转录写创建日志"), and the client hides
 * the two internal rows inside the auxiliary panel through a null
 * `conversation.chat.commandview` renderer keyed by command name.
 *
 * ## What initialization adds
 *
 * The session already exists as an ordinary agent when this runs, so nothing
 * here goes through `agents.create`. Instead this handler builds the mirror
 * plan, mints an agent-scoped context with `createScope`, registers the
 * mirror prompt section and the subagent-call tool guard in that scope, pins
 * preset/title, attaches the parent's workspace, and writes the marker.
 *
 * Any failure after the session exists best-effort removes its artifacts.
 * @module host/init
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertSessionId, encodeSegment, projectionCachePath, sessionsRoot, archiveLedgerDir } from './env.ts'
import { AuxChatError, reasonOf } from './errors.ts'
import { delay, isActiveSessionError } from './guards.ts'
import { MIRROR_SECTION_NAME, MIRROR_SECTION_ORDER, buildMirrorPlan } from './mirror.ts'
import { writeMarker, markerExists } from './registry.ts'
import type {
  AuxCreateResult,
  AuxSessionInfo,
  HostAgent,
  HostAgentCtx,
  HostContext,
  HostDeps,
  HostWorkspace,
  HostWorkspaceRegistry,
} from './types.ts'

/** The `/aux-init` frozen request shape. */
export interface AuxInitRequest {
  /** The new, already-created session being initialized; also the command target. */
  readonly sessionId: string
  /** The live main session whose context is mirrored. */
  readonly mirrorOf: string
  /**
   * `reclaim` (PRD v2.0 §7.1): the client believes THIS session is already a
   * live auxiliary session of ours (a page reload re-attaching to its bound
   * child). A registered session then answers with its info instead of the
   * `already-initialized` refusal, and NO second session is ever created.
   */
  readonly mode?: 'create' | 'reclaim'
  /** Client-minted request correlation id (diagnostics only). */
  readonly requestId?: string
}

/**
 * Tools an auxiliary session may not call: anything that delegates to or
 * manages another agent. Matched by name so deployment-specific variants are
 * all caught without requiring the names to exist (PRD B16).
 */
const FORBIDDEN_TOOL_PATTERN =
  /^(subagent|spawn_teammate|workflow|team_task_[a-z]+|list_agents|interrupt_agent|send_message|wait_agent)$/

/** Register the mirror prompt section in the auxiliary agent's own scope. */
function registerMirrorSection(agentCtx: HostAgentCtx, text: string, warnings: string[]): void {
  const target = agentCtx.systemPrompt
  if (target?.section === undefined) {
    warnings.push("mirror: the agent-scoped systemPrompt service is unavailable; the mirrored context is not in this session's prompt")
    return
  }
  try {
    target.section({ name: MIRROR_SECTION_NAME, order: MIRROR_SECTION_ORDER, interpolate: false, text })
  } catch (error) {
    warnings.push(`mirror section could not be registered (${reasonOf(error)})`)
  }
}

/**
 * Install the B16 capability guard: an auxiliary session may answer and use
 * tools itself, but it cannot spawn or manage subagents, teams, or workflows.
 * A guard (not a tool filter) is used on purpose — it needs no allow-list of
 * deployment tools and denies by reason without disabling unrelated tools.
 */
function installToolGuard(agentCtx: HostAgentCtx, warnings: string[]): void {
  const guard = agentCtx.tools?.guard
  if (guard === undefined) {
    warnings.push('mirror: the tools service is unavailable in this scope; subagent calls are blocked by instructions only')
    return
  }
  try {
    guard((exec: { name?: unknown }) => {
      const name = String(exec?.name ?? '')
      return FORBIDDEN_TOOL_PATTERN.test(name)
        ? '辅助会话不能调用或管理子智能体、智能体团队或工作流；请直接回答，或请用户在主会话中操作。'
        : undefined
    })
  } catch (error) {
    warnings.push(`subagent tool guard could not be installed (${reasonOf(error)})`)
  }
}

/** Apply the mirrored permission preset to an already-live session. */
function applyPermissionPreset(deps: HostDeps, agent: HostAgent, preset: string, warnings: string[]): void {
  if (preset === '' || preset === 'unknown' || preset === 'custom') return
  const presets = deps.ctx.get('permissionPresets')
  if (presets === undefined || presets === null) {
    warnings.push(
      `permission preset "${preset}" could not be applied (the permissionPresets service is unavailable); this session runs the deployment default instead`,
    )
    return
  }
  const names = presets['names']
  if (!Array.isArray(names) || !names.includes(preset)) {
    warnings.push(`permission preset "${preset}" is not available in this deployment; the auxiliary session inherited the mirrored knobs instead`)
    return
  }
  const set = presets['set']
  if (typeof set !== 'function') return
  try {
    set.call(presets, agent.session, preset)
  } catch (error) {
    warnings.push(`permission preset "${preset}" could not be applied (${reasonOf(error)})`)
  }
}

/** Read the main session's title and pin it on the auxiliary session. */
function pinTitle(deps: HostDeps, agent: HostAgent, title: string, warnings: string[]): void {
  const sessionTitle = deps.ctx.get('sessionTitle')
  const rename = sessionTitle?.['rename']
  if (typeof rename !== 'function') return
  try {
    rename.call(sessionTitle, agent.session, title)
  } catch (error) {
    warnings.push(`session title could not be pinned (${reasonOf(error)})`)
  }
}

/**
 * Attach the auxiliary session to the workspace owning the mirrored cwd.
 *
 * A session created with only a `cwd` and no workspaceId is not attached to
 * any workspace, and the conversation factory then renders the blank-session
 * workspace picker instead of the chat — measured visually as the panel's
 * main defect. The main session always belongs to a workspace in the GUI flow,
 * and both sessions share one cwd.
 */
async function attachToWorkspace(deps: HostDeps, sessionId: string, cwd: string, warnings: string[]): Promise<boolean> {
  const registry = deps.ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  const resolve = registry?.resolveByPath
  if (typeof resolve !== 'function') {
    warnings.push('workspace: the registry is unavailable; the auxiliary panel may show the workspace picker')
    return false
  }
  let workspace: HostWorkspace | undefined
  try {
    workspace = await resolve.call(registry, cwd)
  } catch (error) {
    warnings.push(`workspace: could not resolve "${cwd}" (${reasonOf(error)})`)
    return false
  }
  if (workspace === undefined) {
    warnings.push(`workspace: no workspace owns "${cwd}"; the auxiliary panel may show the workspace picker`)
    return false
  }
  try {
    await workspace.attachSession(sessionId)
    return true
  } catch (error) {
    warnings.push(`workspace attach failed (${reasonOf(error)})`)
    return false
  }
}

/** Archive the initialized session so it never appears in a sidebar grouping. */
async function archiveAuxSession(deps: HostDeps, sessionId: string, warnings: string[]): Promise<boolean> {
  const registry = deps.ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  const archive = registry?.archiveSession
  if (typeof archive !== 'function') {
    warnings.push('archive: the workspaceRegistry service is unavailable; the auxiliary session is visible in the sidebar')
    return false
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await archive.call(registry, sessionId)
      // Ledger so the boot sweep unarchives exactly OUR ids after destroy
      // (the interactive path cannot unarchive — the dying row would flash).
      try {
        await mkdir(archiveLedgerDir(deps.home), { recursive: true })
        await writeFile(join(archiveLedgerDir(deps.home), sessionId), '', { flag: 'w' })
      } catch {
        /* ledger failure only delays the id's removal from the archive set */
      }
      deps.trace?.(`archive:done ${sessionId}`)
      return true
    } catch (error) {
      if (attempt === 0 && isActiveSessionError(error)) {
        await delay(150)
        continue
      }
      warnings.push(`archive: could not hide the auxiliary session (${reasonOf(error)}); it is visible in the sidebar`)
      return false
    }
  }
  warnings.push('archive: could not hide the auxiliary session after a retry; it is visible in the sidebar')
  return false
}

/**
 * Initialize one already-created session as an auxiliary session.
 * @param deps - Host dependencies.
 * @param request - `{sessionId, mirrorOf}`.
 * @returns the session snapshot, context delivery mode, and warnings.
 * @throws AuxChatError with a stable code for every rejected request.
 */
export async function initAuxSession(deps: HostDeps, request: AuxInitRequest): Promise<AuxCreateResult> {
  const trace = deps.trace ?? ((): void => {})
  const sessionId = request.sessionId
  const mirrorOf = request.mirrorOf
  try {
    assertSessionId(sessionId, 'sessionId')
    assertSessionId(mirrorOf, 'mirrorOf')
  } catch (error) {
    throw new AuxChatError('aux-chat/invalid-session-id', reasonOf(error))
  }
  if (sessionId === mirrorOf) {
    throw new AuxChatError('aux-chat/invalid-request', 'a session cannot be its own auxiliary session')
  }
  if (request.requestId !== undefined) trace?.(`init:request ${request.requestId}`)
  if (deps.registry.has(sessionId)) {
    if (request.mode === 'reclaim') {
      // Re-attach, never re-create: the caller may only reclaim a session
      // this plugin already owns, and ownership is exactly what the registry
      // records. The mirrored parent is re-checked so a stolen or mistyped
      // id cannot rebind a live auxiliary session to a different parent.
      const entry = deps.registry.get(sessionId)
      if (entry === undefined || entry.info.mirrorOf !== mirrorOf) {
        throw new AuxChatError(
          'aux-chat/reclaim-mismatch',
          `session "${sessionId}" is registered with a different mirrored parent; refusing to rebind`,
        )
      }
      trace?.(`init:reclaimed ${sessionId}`)
      return { info: entry.info, warnings: [], downgrade: 'summary', reclaimed: true }
    }
    throw new AuxChatError('aux-chat/already-initialized', `session "${sessionId}" is already an auxiliary session`)
  }
  if (request.mode === 'reclaim') {
    // Not registered. A reclaim may still proceed when the plugin's OWN
    // durable ownership record (the crash marker) proves this session was
    // ours — the plugin-reload recovery path, where the in-memory registry
    // was rebuilt but the agent stayed alive. Anything else is refused:
    // reclaiming must never convert a foreign session into an auxiliary one.
    if (!(await markerExists(sessionId, deps.home))) {
      throw new AuxChatError(
        'aux-chat/session-not-created',
        `session "${sessionId}" is not an auxiliary session of this plugin; there is nothing to reclaim`,
      )
    }
    trace?.(`init:reclaim-rehydrate ${sessionId}`)
  }
  if (deps.registry.has(mirrorOf)) {
    throw new AuxChatError('aux-chat/nested-aux', `session "${mirrorOf}" is itself an auxiliary session; auxiliary sessions cannot nest`)
  }
  const agent = deps.ctx.agents.get(sessionId)
  if (agent === undefined) {
    throw new AuxChatError(
      'aux-chat/session-not-created',
      `session "${sessionId}" does not exist on the Host yet; the client must create it before running /aux-init`,
    )
  }

  const plan = await buildMirrorPlan(deps, mirrorOf)
  trace?.(
    `init:plan section=${String(plan.promptSection.text.length)}chars digest=${plan.digest === undefined ? 'none' : `${String(plan.digest.messages)}msgs/${String(plan.digest.chars)}chars`}`,
  )
  const warnings = [...plan.warnings]
  const createdAt = deps.now()
  const info: AuxSessionInfo = {
    sessionId,
    mirrorOf: plan.mirrorOf,
    cwd: plan.cwd,
    ...(plan.provider === undefined ? {} : { provider: plan.provider }),
    ...(plan.model === undefined ? {} : { model: plan.model }),
    ...(plan.reasoningEffort === undefined ? {} : { reasoningEffort: plan.reasoningEffort }),
    permissionPreset: plan.permissionPreset,
    createdAt,
    hostGeneration: deps.hostGeneration,
  }

  const actualCwd = agent.session.header?.cwd
  if (typeof actualCwd === 'string' && actualCwd !== '' && actualCwd !== plan.cwd) {
    warnings.push(`the new session's cwd (${actualCwd}) differs from the mirrored session's cwd (${plan.cwd}); attaching to the mirrored workspace anyway`)
  }

  const modules = await deps.loadDsh()
  let scopeDispose: (() => Promise<void>) | undefined
  if (typeof modules.createScope === 'function') {
    try {
      const scope = modules.createScope(deps.ctx as HostContext, agent)
      registerMirrorSection(scope.ctx as unknown as HostAgentCtx, plan.promptSection.text, warnings)
      installToolGuard(scope.ctx as unknown as HostAgentCtx, warnings)
      scopeDispose = scope.dispose
    } catch (error) {
      warnings.push(`agent scope could not be minted (${reasonOf(error)}); the mirror section is not active`)
    }
  } else {
    warnings.push('dsh-scope is not resolvable; the mirror section could not be registered in the agent scope')
  }

  deps.owned.add(sessionId)
  deps.registry.add(info, undefined, scopeDispose)

  applyPermissionPreset(deps, agent, plan.permissionPreset, warnings)
  pinTitle(deps, agent, plan.title, warnings)
  await attachToWorkspace(deps, sessionId, plan.cwd, warnings)

  try {
    await writeMarker({ sessionId, cwd: plan.cwd, createdAt }, deps.home)
  } catch (error) {
    warnings.push(`crash marker could not be written (${reasonOf(error)}); a Host crash would leave the session log behind`)
  }

  if (deps.hideFromSidebar) await archiveAuxSession(deps, sessionId, warnings)

  trace?.(`init:ready ${sessionId}`)
  return { info, warnings, downgrade: plan.downgrade, ...(request.mode === 'reclaim' ? { reclaimed: true } : {}) }
}

/** Best-effort removal of the artifacts a half-initialized session may own. */
export async function bestEffortCleanup(deps: HostDeps, sessionId: string): Promise<void> {
  const trace = deps.trace ?? ((): void => {})
  try {
    await rm(projectionCachePath(sessionId, deps.home), { force: true })
  } catch (error) {
    trace?.(`init:cleanup-cache-failed ${reasonOf(error)}`)
  }
  const root = sessionsRoot(deps.home)
  const segment = encodeSegment(sessionId)
  try {
    for (const project of await readdir(root)) {
      const candidate = join(root, project, segment)
      try {
        if ((await stat(candidate)).isDirectory()) await rm(candidate, { recursive: true, force: true })
      } catch {
        /* absent is the normal case */
      }
    }
  } catch (error) {
    trace?.(`init:cleanup-log-failed ${reasonOf(error)}`)
  }
}
