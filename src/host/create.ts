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
import { hideThroughChannel, resolveHideChannel } from './hide.ts'
import { join } from 'node:path'
import { assertSessionId, encodeSegment, projectionCachePath, sessionsRoot, archiveLedgerDir } from './env.ts'
import { AuxChatError, reasonOf } from './errors.ts'
import { delay, isActiveSessionError } from './guards.ts'
import { randomUUID } from 'node:crypto'
import { MIRROR_SECTION_NAME, MIRROR_SECTION_ORDER, MIRROR_SOURCE_KIND, buildMirrorPlan } from './mirror.ts'
import { writeMarker, markerExists } from './registry.ts'
import type {
  AuxCreateResult,
  AuxInheritedReport,
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

/**
 * Register the mirror prompt section in the auxiliary agent's own scope.
 *
 * The property read is guarded: Cordis throws `cannot get property
 * "systemPrompt" without inject` when the context's fiber does not declare the
 * service, and a mirrored section that silently disappears is exactly the
 * defect this function now reports instead (2026-10-14).
 */
function registerMirrorSection(agentCtx: HostAgentCtx, text: string, warnings: string[]): void {
  let target: HostAgentCtx['systemPrompt']
  try {
    target = agentCtx.systemPrompt
  } catch (error) {
    warnings.push(`mirror: the mirrored context is NOT in this session's prompt (${reasonOf(error)})`)
    return
  }
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
/** One tool-call denial predicate (the argument `dsh-tools`' guard accepts). */
type ToolGuardPredicate = (exec: { name?: unknown }) => string | undefined

function installToolGuard(agentCtx: HostAgentCtx, warnings: string[]): void {
  let guard: ((predicate: ToolGuardPredicate) => unknown) | undefined
  try {
    guard = agentCtx.tools?.guard
  } catch (error) {
    warnings.push(`subagent tool guard unavailable (${reasonOf(error)}); subagent calls are blocked by instructions only`)
    return
  }
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

  // Structural parent binding (v3): the fork channel writes `parentSession`
  // into the child's durable header SERVER-SIDE, so when it is present it is
  // the truth — a client claiming a different mirrorOf is refused instead of
  // silently rebinding the child's context. Legacy plain-created sessions
  // (no parentSession in the header) keep the old trust-the-payload behavior;
  // the registry check above still guards reclaim.
  const headerParent = agent.session.header?.parentSession
  if (typeof headerParent === 'string' && headerParent !== '' && headerParent !== mirrorOf) {
    throw new AuxChatError(
      'aux-chat/parent-mismatch',
      `session "${sessionId}" was forked from "${headerParent}", not from "${mirrorOf}"; refusing to initialize it against a different parent`,
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

  // ── form-A injection: the frozen FULL committed transcript as one hidden
  // user/message (source.kind !== 'user' → the chat view classifies it as a
  // context node and never draws it; deriveMessages passes it to the model in
  // full — the compaction-checkpoint pattern). Appended BEFORE the scope work
  // so the section variant can reflect whether the injection landed.
  let injectionDelivered = false
  if (plan.injection !== undefined) {
    try {
      const append = agent.session.append
      if (typeof append !== 'function') throw new Error('the live session exposes no append()')
      append.call(
        agent.session,
        'user/message',
        {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: plan.injection.text }],
          source: { kind: MIRROR_SOURCE_KIND, form: 'reference' },
        },
        { surfaceOp: 'append' },
      )
      injectionDelivered = true
      trace?.(
        `init:injection ${String(plan.injection.chars)}chars/${String(plan.injection.entries)}entries${plan.injection.truncated ? `/${String(plan.injection.omitted)}omitted` : ''}`,
      )
    } catch (error) {
      warnings.push(`mirror: the full-history injection failed (${reasonOf(error)}); the summary section is used instead`)
    }
  }
  const effectiveDowngrade: 'full' | 'summary' | 'none' = injectionDelivered
    ? 'full'
    : plan.downgrade === 'full'
      ? 'summary'
      : plan.downgrade

  // ── prompt section + tool guard: registered in the AGENT'S OWN scope.
  // `dsh-agent-loop` already minted that scope (`this.scope =
  // createScope(loopCtx, this); this.ctx = this.scope.ctx`,
  // agent-loop/lib/index.js:778-779) and its fiber declares `systemPrompt` and
  // `tools` (its static inject). Minting a SECOND scope from this plugin's own
  // ctx cannot work: our fiber does not declare `systemPrompt`, so property
  // access inside the fresh scope throws `cannot get property "systemPrompt"
  // without inject` and the mirror section never registers (observed live
  // 2026-10-14 20:07: child prompt carried no main-session content at all).
  // Registering through `agent.ctx` also means the registrations unwind with
  // the agent itself — no scope to dispose, no leak on a registration failure.
  const sectionText = injectionDelivered ? plan.promptSection.text : plan.fallbackSection.text
  const agentScopeCtx = agent.ctx as unknown as HostAgentCtx | undefined
  // Only the legacy fallback (an agent that exposes no ctx) needs an extra
  // scope, and only that path owns a disposer.
  let scopeDispose: (() => Promise<void>) | undefined
  if (agentScopeCtx !== undefined) {
    registerMirrorSection(agentScopeCtx, sectionText, warnings)
    installToolGuard(agentScopeCtx, warnings)
  } else {
    const modules = await deps.loadDsh()
    if (typeof modules.createScope === 'function') {
      try {
        const scope = modules.createScope(deps.ctx as HostContext, agent)
        registerMirrorSection(scope.ctx as unknown as HostAgentCtx, sectionText, warnings)
        installToolGuard(scope.ctx as unknown as HostAgentCtx, warnings)
        scopeDispose = scope.dispose
      } catch (error) {
        warnings.push(`the agent scope could not be used for the mirror section (${reasonOf(error)}); the mirrored context is not in this session's prompt`)
      }
    } else {
      warnings.push('the agent scope is unreachable (no agent.ctx, no dsh-scope); the mirror section could not be registered')
    }
  }

  deps.owned.add(sessionId)
  deps.registry.add(info, undefined, scopeDispose)

  applyPermissionPreset(deps, agent, plan.permissionPreset, warnings)
  pinTitle(deps, agent, plan.title, warnings)
  // The fork channel auto-attaches the parent's workspace (forkWorkspace +
  // attachSession in the controller); only a legacy plain-created session
  // still needs the manual attach that keeps the conversation factory from
  // rendering the blank-session workspace picker.
  if (headerParent === undefined) await attachToWorkspace(deps, sessionId, plan.cwd, warnings)

  try {
    await writeMarker({ sessionId, cwd: plan.cwd, createdAt }, deps.home)
  } catch (error) {
    warnings.push(`crash marker could not be written (${reasonOf(error)}); a Host crash would leave the session log behind`)
  }

  if (deps.hideFromSidebar) {
    // Plan v2 P2/WP2.2: hide through the resolved channel; the archive bridge
    // remains the fallback until DSH ships the native visibility seam (S1).
    const channel = resolveHideChannel(deps)
    await hideThroughChannel(deps, channel, sessionId, warnings, archiveAuxSession)
  }

  // Delivered inheritance, for the panel: the transcript window when it landed,
  // otherwise the digest that the section carries, otherwise nothing.
  const inherited: AuxInheritedReport = injectionDelivered
    ? {
        form: 'full',
        entries: plan.injection?.entries ?? 0,
        chars: plan.injection?.chars ?? 0,
        truncated: plan.injection?.truncated === true,
        omitted: plan.injection?.omitted ?? 0,
      }
    : effectiveDowngrade === 'none'
      ? { form: 'none', entries: 0, chars: 0, truncated: false, omitted: 0 }
      : { form: 'summary', entries: plan.digest?.messages ?? 0, chars: plan.digest?.chars ?? 0, truncated: false, omitted: 0 }

  trace?.(`init:ready ${sessionId} downgrade=${effectiveDowngrade} inherited=${inherited.form}/${String(inherited.entries)}`)
  return {
    info,
    warnings,
    downgrade: effectiveDowngrade,
    inherited,
    ...(request.mode === 'reclaim' ? { reclaimed: true } : {}),
  }
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
