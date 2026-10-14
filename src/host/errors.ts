/**
 * Stable machine-routable error codes for the auxiliary-chat command channel.
 *
 * The wire contract is frozen (docs/REMOTE-CONTRACT.md): a failure travels as
 * `{ kind: 'error', text }`. The text below is `${code}: ${message}` so a panel
 * can branch on the prefix and still show a human-readable reason.
 * @module host/errors
 */

/** One rejected auxiliary-chat operation. */
export class AuxChatError extends Error {
  /** Stable code, e.g. `aux-chat/duplicate-session-id`. */
  readonly code: string

  /**
   * @param code - stable lower-kebab code.
   * @param message - human-readable reason.
   * @param details - optional non-fatal context (never serialized to the wire).
   */
  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AuxChatError'
    this.code = code
    if (details !== undefined) this.details = details
  }

  /** Optional structured context for logs and tests. */
  details?: unknown
}

/**
 * Render any thrown value as the wire error text.
 * @param error - thrown value.
 * @returns `${code}: ${message}`, or `String(error)` for foreign failures.
 */
export function describeError(error: unknown): string {
  if (error instanceof AuxChatError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return `aux-chat/internal: ${error.message}`
  return `aux-chat/internal: ${String(error)}`
}

/**
 * Short one-line reason for a caught failure, used inside warnings.
 * @param error - thrown value.
 * @returns the message text without a code prefix.
 */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
