/**
 * Permanent destruction of one auxiliary session.
 *
 * DSH has no delete API, so this is the four-step manual teardown the API
 * reference records (docs/VERIFIED-API.md B5), and the ORDER is load-bearing:
 *
 *   1. `handle.dispose()`      — stops the loop and closes the write handle;
 *   2. delete the log directory — after the handle closed, so nothing re-appends;
 *   3. delete the projection-cache row;
 *   4. delete this plugin's marker.
 *
 * Step 2 prefers the backend's own `resolveCurrentLog(id)` over path inference:
 * the jsonl backend already knows the project-key/segment layout, and it also
 * refuses to guess when only a historical generation exists. Inference is the
 * documented fallback and is confined to a directory whose name is exactly the
 * encoded session id.
 *
 * @module host/dispose
 */
import { readdir, rm, readFile, stat } from 'node:fs/promises'
import { dirname, join, basename, isAbsolute } from 'node:path'
import * as zlib from 'node:zlib'
import { encodeSegment, projectionCachePath, sessionsRoot, archiveLedgerDir } from './env.ts'
import { AuxChatError, reasonOf } from './errors.ts'
import { readMarkers, removeMarker, markerExists } from './registry.ts'
import type { AuxDisposeOptions, AuxDisposeResult, AuxMarker, AuxSweepResult, HostDeps } from './types.ts'

/** Whether a path currently exists as a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Whether a path currently exists as a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Delete the log directory of one session, whichever way it can be located.
 * @param deps - Host dependencies.
 * @param sessionId - the session whose log directory is removed.
 * @returns whether a log directory was found and is now gone.
 */
async function removeLogDirectory(deps: HostDeps, sessionId: string): Promise<boolean> {
  const segment = encodeSegment(sessionId)
  const candidates: string[] = []

  const persistence = deps.ctx.get('sessionPersistence')
  const resolveCurrentLog = persistence?.['resolveCurrentLog']
  if (typeof resolveCurrentLog === 'function') {
    try {
      const file = await resolveCurrentLog.call(persistence, sessionId)
      if (typeof file === 'string' && isAbsolute(file) && basename(dirname(file)) === segment) candidates.push(dirname(file))
      else if (typeof file === 'string' && file !== '') deps.trace?.(`dispose:resolve-rejected ${file}`)
    } catch (error) {
      deps.trace?.(`dispose:resolve-failed ${reasonOf(error)}`)
    }
  }

  if (candidates.length === 0) {
    // Fallback: the layout is `<root>/<projectKey(cwd)>/<encodeSegment(id)>/`,
    // and the project key is deliberately NOT recomputed here — scanning avoids
    // inventing a path from workspace metadata. Only a directory literally named
    // after the encoded id is ever a candidate.
    const root = sessionsRoot(deps.home)
    try {
      for (const project of await readdir(root)) candidates.push(join(root, project, segment))
    } catch {
      /* no sessions root: nothing to delete */
    }
  }

  let removed = false
  for (const candidate of candidates) {
    if (basename(candidate) !== segment) continue
    if (!(await isDirectory(candidate))) continue
    deps.trace?.(`dispose:log-dir ${candidate}`)
    await rm(candidate, { recursive: true, force: true })
    removed = (await isDirectory(candidate)) === false
  }
  return removed
}

/**
 * Delete the projection-cache row of one session.
 * @param deps - Host dependencies.
 * @param sessionId - the session whose cache row is removed.
 * @returns whether a row was found and is now gone.
 */
async function removeProjectionCacheRow(deps: HostDeps, sessionId: string): Promise<boolean> {
  const path = projectionCachePath(sessionId, deps.home)
  if (!(await isFile(path))) return false
  deps.trace?.(`dispose:projcache ${path}`)
  await rm(path, { force: true })
  return (await isFile(path)) === false
}

/**
 * Remove one destroyed auxiliary session from its workspace's session list so
 * it stops appearing in the sidebar. Best-effort: a missing registry/workspace
 * is a no-op (older hosts, detached home) and a failure is traced, never fatal —
 * the session's own artifacts are still deleted.
 * @param attempts - registry-resolution retries (the interactive path waits for
 * a late registry; boot sweeps must not — see `sweepAuxSessions`).
 * @returns whether the workspace's list dropped the id.
 */
async function detachFromWorkspace(deps: HostDeps, sessionId: string, cwd: string | undefined, attempts = 4): Promise<boolean> {
  if (cwd === undefined || cwd === '') return false
  // The registry may still be activating during early boot sweeps; a short
  // retry keeps the sidebar membership from surviving a sweep that ran first.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const registry = deps.ctx.get('workspaceRegistry') as { resolveByPath?(path: string): Promise<{ detachSession?(id: string): Promise<void> } | undefined> } | undefined
    if (typeof registry?.resolveByPath !== 'function') {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      continue
    }
    try {
      const workspace = await registry.resolveByPath(cwd)
      if (workspace === undefined || typeof workspace.detachSession !== 'function') return false
      await workspace.detachSession(sessionId)
      deps.trace?.(`artifact:workspace detached ${sessionId} from ${cwd}`)
      return true
    } catch (error) {
      deps.trace?.(`dispose:workspace-detach-failed ${reasonOf(error)}`)
      return false
    }
  }
  deps.trace?.(`dispose:workspace-detach registry never came up for ${sessionId}`)
  return false
}

/**
 * Delete every artifact one auxiliary session owns, in the frozen order.
 *
 * Shared by `disposeAuxSession` (which has a live handle) and the boot sweeps
 * (which do not), so both paths provably do the same thing in the same order.
 *
 * @param deps - Host dependencies.
 * @param target - the session identity and, when known, its workspace.
 * @param options - `detachAttempts` caps the registry-resolution retry count.
 * Boot sweeps pass 1: a sweep that is still retrying when the client loads its
 * session list detaches underneath an already-rendered row and strands it in
 * the "未分组" bucket until the next refresh.
 * @returns which of the three artifacts were found and removed.
 */
export async function deleteAuxArtifacts(deps: HostDeps, target: { sessionId: string; cwd?: string }, options?: { detachAttempts?: number }): Promise<AuxDisposeResult> {
  // Detach LAST, after every artifact is gone: an earlier detach opens a
  // window where the client list still holds the session while no workspace
  // claims it, and the sidebar buckets it under "未分组" — the exact residue
  // the operator reported. With the log deleted first, the next list refresh
  // only ever sees the session disappear, never migrate.
  const logRemoved = await removeLogDirectory(deps, target.sessionId)
  deps.trace?.(`artifact:log removed=${String(logRemoved)}`)
  const cacheRemoved = await removeProjectionCacheRow(deps, target.sessionId)
  deps.trace?.(`artifact:cache removed=${String(cacheRemoved)}`)
  let markerRemoved = false
  try {
    markerRemoved = await removeMarker(target.sessionId, deps.home)
  } catch (error) {
    deps.trace?.(`dispose:marker-failed ${reasonOf(error)}`)
  }
  deps.trace?.(`artifact:marker removed=${String(markerRemoved)}`)
  const workspaceDetached = await detachFromWorkspace(deps, target.sessionId, target.cwd, options?.detachAttempts ?? 4)
  return { sessionId: target.sessionId, logRemoved, cacheRemoved, markerRemoved, workspaceDetached }
}

/**
 * Destroy one registered auxiliary session.
 *
 * A second call for the same id is rejected before anything is touched: once a
 * session leaves the registry it is not ours to delete again, and refusing is
 * what keeps a mistyped id from ever reaching a real session's log.
 *
 * PRD v2.0 §6.3/§9 close binding:
 * - `options.operationId` is echoed back verbatim, so a retried close can be
 *   correlated with the attempt that produced it (same id, same generation);
 * - `options.hostGeneration` is checked FIRST and REFUSED on mismatch — a
 *   close captured before a Host restart must not act on whatever now lives
 *   under the same session id (T12).
 *
 * @param deps - Host dependencies.
 * @param sessionId - the auxiliary session to destroy.
 * @param options - optional close-operation binding (see {@link AuxDisposeOptions}).
 * @returns which artifacts were removed.
 * @throws {AuxChatError} `aux-chat/stale-generation`, `aux-chat/not-registered`
 *   or `aux-chat/dispose-failed`.
 */
export async function disposeAuxSession(deps: HostDeps, sessionId: string, options?: AuxDisposeOptions): Promise<AuxDisposeResult> {
  if (options?.hostGeneration !== undefined && options.hostGeneration !== deps.hostGeneration) {
    deps.trace?.(`dispose:stale-generation ${sessionId} op=${options.operationId ?? '-'} got=${options.hostGeneration} want=${deps.hostGeneration}`)
    throw new AuxChatError(
      'aux-chat/stale-generation',
      `close request for "${sessionId}" was captured on Host generation "${options.hostGeneration}" but this Host is generation "${deps.hostGeneration}"; the resource it named no longer exists here`,
    )
  }
  if (options?.operationId !== undefined) deps.trace?.(`dispose:op ${options.operationId} ${sessionId}`)
  const entry = deps.registry.get(sessionId)
  if (entry === undefined) {
    // Converged-repeat tolerance, decided by the plugin's OWN ownership record:
    // a marker still on disk proves this session was ours, so a destroy that
    // races another one (two calls in flight, or a reloaded panel re-sending)
    // converges instead of erroring. Once the marker is gone the destroy really
    // is finished, and a repeat is refused — as is an id this plugin never
    // owned. Refusing by default is what keeps a mistyped or foreign id from
    // ever being treated as disposable.
    if (!(await markerExists(sessionId, deps.home))) {
      throw new AuxChatError('aux-chat/not-registered', `session "${sessionId}" is not an auxiliary session of this plugin (already destroyed, or never created here)`)
    }
    deps.trace?.('dispose:repeat-converged')
    const converged = await deleteAuxArtifacts(deps, { sessionId })
    return options?.operationId === undefined ? converged : { ...converged, operationId: options.operationId }
  }
  const failures: string[] = []
  // The agent is owned by the session controller now (the client created it
  // through sessions.create), so stopping its run means cancelling through the
  // official agent surface rather than disposing an AgentHandle we never held.
  const agent = deps.ctx.agents.get(sessionId)
  if (agent !== undefined && typeof agent['cancel'] === 'function') {
    try {
      ;(agent as { cancel(cause: { kind: 'hook'; reason: string }): void }).cancel({
        kind: 'hook',
        reason: 'auxiliary session permanently destroyed',
      })
    } catch (error) {
      failures.push(`agent.cancel: ${reasonOf(error)}`)
    }
  }
  if (entry.scopeDispose !== undefined) {
    deps.trace?.('dispose:scope-start')
    try {
      await entry.scopeDispose()
    } catch (error) {
      failures.push(`scope dispose: ${reasonOf(error)}`)
    }
    deps.trace?.('dispose:scope-done')
  }
  if (entry.handle !== undefined) {
    deps.trace?.('dispose:handle-start')
    try {
      await entry.handle.dispose()
    } catch (error) {
      failures.push(`handle.dispose: ${reasonOf(error)}`)
    }
    deps.trace?.('dispose:handle-done')
  }
  deps.registry.remove(sessionId)
  // Drop the archive short-circuit authorization with the registration: a
  // destroyed session must never keep answering `agent/pre-step` for its id.
  deps.owned.delete(sessionId)
  const result = await deleteAuxArtifacts(deps, { sessionId, cwd: entry.info.cwd })
  if (failures.length > 0) {
    throw new AuxChatError('aux-chat/dispose-failed', `${sessionId} was unregistered but not fully torn down: ${failures.join('; ')}`, result)
  }
  return options?.operationId === undefined ? result : { ...result, operationId: options.operationId }
}

/**
 * Boot-time sweep over leftover markers.
 *
 * A marker with a LIVE agent belongs to a session this process still owns (a
 * plugin reload, not a crash) and is skipped; everything else is deleted with
 * the same three-step artifact removal the interactive path uses, in the same
 * order, minus the handle step.
 *
 * @param deps - Host dependencies.
 * @returns the ids that were swept.
 */
export async function sweepAuxSessions(deps: HostDeps): Promise<AuxSweepResult> {
  const markers: AuxMarker[] = await readMarkers(deps.home, deps.trace)
  const swept: string[] = []
  for (const marker of markers) {
    try {
      if (deps.ctx.agents.get(marker.sessionId) !== undefined) {
        deps.trace?.(`sweep:live ${marker.sessionId}`)
        continue
      }
      // One detach attempt, no retry sleeps: the sweep races the client's
      // initial session-list load, and a detach that lands after the list has
      // rendered strands the row in "未分组". If the registry is not up yet the
      // membership simply stays; the log is already gone, so the row never
      // renders, and the next boot's sweep retries the detach.
      await deleteAuxArtifacts(deps, { sessionId: marker.sessionId, cwd: marker.cwd }, { detachAttempts: 1 })
      // Also leave the archive set (the sidebar-hiding surface): a destroyed
      // session's archived id is dangling state, and no client is connected
      // yet, so removing it here is invisible.
      await unarchiveIfArchived(deps, marker.sessionId)
      // A swept session is destroyed; it is no longer one we answer for.
      deps.owned.delete(marker.sessionId)
      swept.push(marker.sessionId)
      deps.trace?.(`sweep:removed ${marker.sessionId}`)
    } catch (error) {
      deps.trace?.(`sweep:failed ${marker.sessionId} ${reasonOf(error)}`)
    }
  }
  return { swept }
}

/**
 * Drop one destroyed auxiliary session's id from the registry-global archive
 * set (the surface that keeps it out of the sidebar). Returns whether the
 * unarchive RESOLVED — the registry activates late in boot and its
 * `requireState()` throws until then, which the caller must treat as "retry
 * later", not success.
 */
async function unarchiveIfArchived(deps: HostDeps, sessionId: string): Promise<boolean> {
  try {
    const registry = deps.ctx.get('workspaceRegistry') as { unarchiveSession?(id: string): Promise<void> } | undefined
    if (typeof registry?.unarchiveSession !== 'function') return false
    await registry.unarchiveSession(sessionId)
    return true
  } catch (error) {
    deps.trace?.(`sweep:unarchive-failed ${sessionId} ${reasonOf(error)}`)
    return false
  }
}

/**
 * Count concatenated zstd frames in a buffer (frame magic 28 B5 2F FD, LE).
 *
 * Session logs are APPENDED as one zstd frame per write and the first frame
 * always holds only the `type:"session"` header line, so "the decompressed
 * text has one line" is true for every log ever written and proves nothing.
 * The frame COUNT is the real signal: anything that ever happened to a
 * session — a title event, a turn, even the blank marker the shipped app
 * writes moments after creation — appends frame 2.
 */
function countZstdFrames(buf: Buffer): number {
  let frames = 0
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) frames += 1
  }
  return frames
}

/**
 * Sweep the archive ledger: every id this plugin archived whose session no
 * longer needs hiding (no live agent AND no marker — i.e. it was destroyed
 * interactively, or by the marker sweep above) leaves the registry-global
 * archive set. Ids still carrying a marker are live-or-crashed auxiliary
 * sessions that stay hidden; the user's OWN archived sessions are never in
 * the ledger and are never touched. Boot-time only, like the unarchive above:
 * no client is connected, so nothing flashes.
 */
export async function sweepArchiveLedger(deps: HostDeps): Promise<string[]> {
  const dir = archiveLedgerDir(deps.home)
  let entries: string[] = []
  try {
    entries = (await readdir(dir)).filter((name) => name.startsWith('session-'))
  } catch {
    return []
  }
  const cleaned: string[] = []
  for (const sessionId of entries) {
    try {
      if (deps.ctx.agents.get(sessionId) !== undefined) continue
      if (await markerExists(sessionId, deps.home)) continue
      // Every id reaching this point belongs to a session with no log (it was
      // destroyed interactively, or by the marker sweep above), so no client
      // can ever render it — late completion is invisible and retrying is
      // safe. The registry activates late in boot and throws from
      // requireState() until then, so retry a bounded number of times and
      // ONLY consume the ledger entry once the unarchive resolved.
      let resolved = false
      for (let attempt = 0; attempt < 4 && !resolved; attempt += 1) {
        resolved = await unarchiveIfArchived(deps, sessionId)
        if (!resolved) await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
      if (!resolved) continue
      await rm(join(dir, sessionId), { force: true })
      cleaned.push(sessionId)
      deps.trace?.(`sweep:archive-ledger ${sessionId}`)
    } catch (error) {
      deps.trace?.(`sweep:archive-ledger-failed ${sessionId} ${reasonOf(error)}`)
    }
  }
  return cleaned
}

/**
 * Sweep header-only session skeletons this plugin's create-then-init flow can
 * strand (session created, `/aux-init` never landed — a reload inside the
 * window). A true skeleton is a log of EXACTLY ONE zstd frame holding exactly
 * one `type:"session"` line: no title, no turn, not even the metadata frame
 * the shipped app writes right after creating its own sessions. The sidebar
 * renders it as a bare "[辅助]" row, which contradicts the temporary-session
 * contract once its marker is also gone.
 *
 * Safety rails: a live agent, an existing marker (the marker sweep owns that
 * path), a delegation depth (subagent-owned), a seeded history, a compressed
 * size over 4 KiB, or MORE THAN ONE zstd frame (any real session — including
 * the app's own blank sessions, which carry a second frame — has content
 * appended the moment anything happens to it) all veto the delete; a zstd
 * decode failure just skips the candidate.
 * @param deps - Host dependencies.
 * @returns the swept ids.
 */
export async function sweepHeaderOnlyAuxSessions(deps: HostDeps): Promise<AuxSweepResult> {
  const swept: string[] = []
  const root = sessionsRoot(deps.home)
  let projects: string[] = []
  try {
    projects = await readdir(root)
  } catch {
    return { swept }
  }
  for (const project of projects) {
    let entries: string[] = []
    try {
      entries = await readdir(join(root, project))
    } catch {
      continue
    }
    for (const dir of entries) {
      if (!dir.startsWith('session-')) continue
      const sessionId = dir
      try {
        if (deps.ctx.agents.get(sessionId) !== undefined) continue
        if (await markerExists(sessionId, deps.home)) continue
        const logPath = join(root, project, dir, 'session.v4.jsonl.zstd')
        // A header-only skeleton compresses to a few hundred bytes; a real
        // session is larger. Skipping big files keeps the sweep off the hot
        // path even on homes with hundreds of sessions.
        const info = await stat(logPath).catch(() => undefined)
        if (info === undefined || !info.isFile() || info.size > 4096) continue
        const raw = await readFile(logPath).catch(() => undefined)
        if (raw === undefined) continue
        // The load-bearing check: exactly ONE frame in the whole file. See
        // countZstdFrames — multi-frame logs are real sessions with content,
        // no matter how few lines their first frame decompresses to.
        if (countZstdFrames(raw) !== 1) continue
        const text = zlib.zstdDecompressSync(raw).toString('utf8')
        const lines = text.split('\n').filter((line) => line.trim() !== '')
        if (lines.length !== 1) continue
        const header = JSON.parse(lines[0] ?? '') as {
          type?: string; id?: string; cwd?: string; delegationDepth?: number; isSeeded?: boolean
        }
        if (header.type !== 'session' || header.id !== sessionId) continue
        if ((header.delegationDepth ?? 0) > 0 || header.isSeeded === true) continue
        await deleteAuxArtifacts(deps, { sessionId, cwd: header.cwd }, { detachAttempts: 1 })
        // Init may have archived the session before it died; leave the set.
        await unarchiveIfArchived(deps, sessionId)
        deps.owned.delete(sessionId)
        swept.push(sessionId)
        deps.trace?.(`sweep:skeleton ${sessionId}`)
      } catch (error) {
        deps.trace?.(`sweep:skeleton-failed ${dir} ${reasonOf(error)}`)
      }
    }
  }
  return { swept }
}
