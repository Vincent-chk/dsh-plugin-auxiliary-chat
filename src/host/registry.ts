/**
 * The auxiliary-session registry: the process-local truth about which sessions
 * this plugin created, plus the crash markers that survive a process death.
 *
 * The registry is intentionally NOT a Cordis service: nothing else may address
 * an auxiliary session, and the frozen cross-half contract reaches it only
 * through the two commands. The marker directory is the only durable trace,
 * and it exists so a crashed Host can sweep its own leftovers on the next boot
 * (docs/VERIFIED-API.md B6).
 * @module host/registry
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { markerDir, markerPath } from './env.ts'
import { reasonOf } from './errors.ts'
import type { AuxMarker, AuxSessionInfo, HostAgentHandle } from './types.ts'

/** One registered auxiliary session. */
export interface AuxRegistryEntry {
  readonly info: AuxSessionInfo
  readonly handle: HostAgentHandle | undefined
  /** Scope fiber minted post-creation; disposing it removes the mirror section and tool guard. */
  scopeDispose?: (() => Promise<void>) | undefined
}

/**
 * In-memory `Map<sessionId, entry>`.
 *
 * A handle is absent only for sessions recovered from a marker whose live
 * agent is gone — the boot sweep path, where deletion is the whole job.
 */
export class AuxChatRegistry {
  private readonly entries = new Map<string, AuxRegistryEntry>()

  /**
   * @param sessionId - candidate identity.
   * @returns whether this process created (and has not yet destroyed) it.
   */
  has(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  /**
   * @param sessionId - identity to look up.
   * @returns the entry, or `undefined` when this process does not own it.
   */
  get(sessionId: string): AuxRegistryEntry | undefined {
    return this.entries.get(sessionId)
  }

  /**
   * Record one created auxiliary session.
   * @param info - durable identity and snapshot.
   * @param handle - the ownership capability, when this process still holds it.
   * @param scopeDispose - teardown for the post-creation scope fiber.
   */
  add(
    info: AuxSessionInfo,
    handle: HostAgentHandle | undefined,
    scopeDispose?: (() => Promise<void>) | undefined,
  ): void {
    this.entries.set(info.sessionId, { info, handle, scopeDispose })
  }

  /**
   * Forget one auxiliary session.
   * @param sessionId - identity to drop.
   * @returns whether an entry was present.
   */
  remove(sessionId: string): boolean {
    return this.entries.delete(sessionId)
  }

  /** @returns every registered session snapshot, oldest first. */
  list(): readonly AuxSessionInfo[] {
    return [...this.entries.values()].map((entry) => entry.info).sort((left, right) => left.createdAt - right.createdAt)
  }

  /** @returns the number of registered auxiliary sessions. */
  size(): number {
    return this.entries.size
  }
}

/**
 * Persist one crash marker, creating the directory on first use.
 *
 * The marker is a recovery aid, never a source of truth: a failure here must be
 * reported as a warning and must not fail creation.
 *
 * @param marker - identity to record.
 * @param home - DSH home directory.
 * @returns the marker path written.
 */
export async function writeMarker(marker: AuxMarker, home?: string): Promise<string> {
  const path = markerPath(marker.sessionId, home)
  await mkdir(markerDir(home), { recursive: true })
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  return path
}

/**
 * Delete one crash marker.
 * @param sessionId - identity whose marker to remove.
 * @param home - DSH home directory.
 * @returns whether the marker file existed before this call.
 */
export async function removeMarker(sessionId: string, home?: string): Promise<boolean> {
  const path = markerPath(sessionId, home)
  let existed = false
  try {
    await readFile(path, 'utf8')
    existed = true
  } catch {
    return false
  }
  await rm(path, { force: true })
  return existed
}

/**
 * Whether this plugin currently owns a crash marker for `sessionId`.
 *
 * The marker is the plugin's OWN durable record of ownership, which is what
 * makes a repeat destroy decidable after the session has left the in-memory
 * registry: a marker that is still present proves the session was ours, while
 * its absence keeps a foreign or mistyped id refused.
 *
 * @param sessionId - identity to test.
 * @param home - DSH home directory.
 * @returns whether a marker file exists for this identity.
 */
export async function markerExists(sessionId: string, home?: string): Promise<boolean> {
  try {
    await readFile(markerPath(sessionId, home), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Read every well-formed crash marker.
 *
 * A marker directory that does not exist yet is the normal state on a fresh
 * machine and yields an empty list; an unreadable or malformed file is skipped
 * (its session is still reported by the log scan if it matters).
 *
 * @param home - DSH home directory.
 * @param trace - optional diagnostics hook.
 * @returns the markers found, in directory order.
 */
export async function readMarkers(home?: string, trace?: (event: string) => void): Promise<AuxMarker[]> {
  const dir = markerDir(home)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const markers: AuxMarker[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(await readFile(`${dir}/${name}`, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') continue
      const record = parsed as Record<string, unknown>
      const sessionId = record['sessionId']
      const cwd = record['cwd']
      const createdAt = record['createdAt']
      if (typeof sessionId !== 'string' || sessionId === '') continue
      markers.push({
        sessionId,
        cwd: typeof cwd === 'string' ? cwd : '',
        createdAt: typeof createdAt === 'number' ? createdAt : 0,
      })
    } catch (error) {
      trace?.(`marker-unreadable:${name}:${reasonOf(error)}`)
    }
  }
  return markers
}
