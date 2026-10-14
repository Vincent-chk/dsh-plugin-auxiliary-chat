/**
 * Small shared predicates and timing helpers used by more than one host
 * module. Extracted so `create.ts` and `hide.ts` agree on the exact shape of
 * the registry's "this session is active" refusal instead of each keeping a
 * private copy.
 * @module host/guards
 */

/** Whether a failure is the Workspace registry's "this session is active" refusal. */
export function isActiveSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'WorkspaceActiveSessionError') return true
  const candidate = error as unknown as { sessionId?: unknown; activity?: unknown }
  return typeof candidate.sessionId === 'string' && Array.isArray(candidate.activity)
}

/** Short pause before a bounded retry. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
