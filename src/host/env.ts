/**
 * Deployment paths and identity rules this plugin's artifacts depend on.
 *
 * The plugin owns one artifact of its own — the crash marker:
 *
 *   <DSH_HOME>/aux-chat/sessions/<sessionId>.json
 *
 * and it deletes two artifacts DSH itself owns:
 *
 *   <DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.jsonl[.zstd]
 *   <DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json
 *
 * Every path here is verified against the shipped composition rather than
 * guessed: `dsh-session-persistence-jsonl` is composed with
 * `root: !!js dshHomePath('sessions')` (dsh-base/cordis.patch.yml:130-133), the
 * projection cache opens the `session_projcache` domain under the storage root
 * (dsh-session-projection-cache/lib/index.js:9-18), and real artifacts were
 * observed at both locations on this machine. `encodeSegment`/`projectKey` are
 * reproduced from dsh-session-persistence-jsonl/lib/index.js:853-885.
 *
 * @module host/env
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Env var DSH reads for its home directory. */
const HOME_ENV = 'DSH_HOME'

/**
 * Resolve the DSH home directory exactly the way the Host does.
 * @returns the absolute DSH home path; `$DSH_HOME` wins, `~/.dsh` is the default.
 */
export function resolveDshHome(): string {
  const fromEnv = process.env[HOME_ENV]
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Directory holding this plugin's crash markers.
 * @param home - DSH home directory.
 * @returns `<home>/aux-chat/sessions`.
 */
export function markerDir(home: string = resolveDshHome()): string {
  return join(home, 'aux-chat', 'sessions')
}

/**
 * Marker file for one auxiliary session.
 * @param sessionId - the auxiliary session id.
 * @param home - DSH home directory.
 * @returns the marker path.
 */
export function markerPath(sessionId: string, home: string = resolveDshHome()): string {
  return join(markerDir(home), `${sessionId}.json`)
}

/**
 * Directory holding the archive ledger: one empty file per auxiliary session
 * this plugin placed in the workspace registry's archive set (the surface
 * that keeps auxiliary rows out of the sidebar). The registry set is durable
 * and global, so an interactively destroyed auxiliary leaves its id behind;
 * the boot sweep reads this ledger to unarchive exactly OUR ids — never the
 * user's own archived sessions — once the session is gone.
 * @param home - DSH home directory.
 * @returns `<home>/aux-chat/archived`.
 */
export function archiveLedgerDir(home: string = resolveDshHome()): string {
  return join(home, 'aux-chat', 'archived')
}

/**
 * Root of the jsonl session-persistence backend.
 * @param home - DSH home directory.
 * @returns `<home>/sessions`.
 */
export function sessionsRoot(home: string = resolveDshHome()): string {
  return join(home, 'sessions')
}

/**
 * Projection-cache row for one session (per-record JSON layout).
 * @param sessionId - the session id.
 * @param home - DSH home directory.
 * @returns `<home>/storages/session_projcache/sessions/<sessionId>.json`.
 */
export function projectionCachePath(sessionId: string, home: string = resolveDshHome()): string {
  return join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

/**
 * Escape one string into a single decodable path segment.
 *
 * Reproduced verbatim from the published backend so the fallback log lookup
 * never diverges from the layout the backend writes. Every id this plugin
 * accepts already matches `[A-Za-z0-9_-]+`, for which this is the identity.
 *
 * @param raw - non-empty string to encode.
 * @returns the escaped segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    out += char !== '~' && /^[A-Za-z0-9._-]$/.test(char) ? char : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Every id this plugin is willing to touch on disk must satisfy this shape:
 * it becomes a path segment (`sessions/<...>/<encodeSegment(id)>/`), a file name
 * (`<id>.json`) and a projection-cache record key, whose backend accepts only
 * `[a-zA-Z0-9_-]+` (dsh-storage-json/lib/index.js:305).
 *
 * The client mints `session-<uuid>`; the pattern also admits hand-written ids
 * such as `session-test-1`, while rejecting separators, dots, and `~` escapes.
 */
const SESSION_ID_RE = /^session-[0-9A-Za-z][0-9A-Za-z-]{0,119}$/

/**
 * Validate one session identity before any path is built from it.
 * @param value - candidate id.
 * @param label - field name used in the error message.
 * @returns the id unchanged.
 * @throws {Error} when the value is not a path-safe session id.
 */
export function assertSessionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) {
    throw new TypeError(`${label} must be a session id matching ${String(SESSION_ID_RE)}, got ${JSON.stringify(value)}`)
  }
  return value
}
