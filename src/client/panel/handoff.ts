/**
 * Conclusion handoff: auxiliary session → main session composer.
 *
 * PATH USED (VERIFIED-API.md C5): the public input machine, not a private hook.
 * `ctx.conversation.input.for(agentCtx)` is the published Session-addressed
 * resolver (`$PKG/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:196-199`)
 * and `SessionInput.setDraft` is the published "replace the whole draft" verb
 * (`:160-161`). The Agent-scoped context comes from
 * `ctx.sessions.binding(mainSessionId)?.ctx`
 * (`$PKG/dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:150-155`),
 * falling back to `ctx.sessions.scope(id)`.
 *
 * FALLBACK: if either face is missing (or the write is refused) the text goes to
 * the clipboard and the status line tells the user to paste it manually.
 * @module client/panel/handoff
 */
import type { ClientContextLike, ConversationLike, SessionBindingLike, SessionInputLike } from '../types.ts'
import { msg } from '../../locale.ts'
import { describeError } from '../store.ts'

/** Outcome of one handoff attempt, rendered as the panel status line. */
export interface HandoffReport {
  readonly ok: boolean
  readonly message: string
}

/** Call a producer, swallowing both a throw and a missing face. */
function attempt<T>(produce: () => T | undefined): T | undefined {
  try {
    return produce()
  } catch {
    return undefined
  }
}

/**
 * Text of the newest assistant message in one event window.
 * Reads `assistant/message` payloads defensively: the durable event shape is
 * `{ type, seq, time, data: { message: { content: ContentBlock[] } } }`
 * (`$PKG/dsh-session/lib/types/types.d.ts:489-512,330-338`).
 * @param binding - auxiliary session binding.
 * @returns concatenated text blocks, or `undefined` when there is none.
 */
export function latestAssistantText(binding: SessionBindingLike): string | undefined {
  const entries = attempt(() => binding.eventSource?.getSnapshot?.()?.entries) ?? []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || entry.type !== 'event') continue
    const event = entry.event
    if (event === undefined || event.type !== 'assistant/message') continue
    const message = (event.data as { message?: unknown } | undefined)?.message
    const content = (message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    const parts: string[] = []
    for (const block of content) {
      const candidate = block as { type?: unknown; text?: unknown } | undefined
      if (candidate?.type === 'text' && typeof candidate.text === 'string' && candidate.text.trim() !== '') {
        parts.push(candidate.text)
      }
    }
    if (parts.length > 0) return parts.join('\n\n')
  }
  return undefined
}

/**
 * Best-effort clipboard write: async Clipboard API first, then a hidden
 * textarea + `execCommand('copy')` for non-secure contexts.
 * @param text - exact text to place on the clipboard.
 * @returns whether the host accepted the write.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const nav = globalThis.navigator as Navigator | undefined
    const clipboard = nav?.clipboard
    if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(text)
      return true
    }
  } catch {
    /* insecure context or permission refusal: fall through */
  }
  try {
    const doc = globalThis.document
    const body = doc?.body
    if (doc === undefined || body === undefined || body === null) return false
    const area = doc.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    body.appendChild(area)
    area.select()
    const copied = typeof doc.execCommand === 'function' ? doc.execCommand('copy') : false
    body.removeChild(area)
    return copied
  } catch {
    return false
  }
}

/**
 * Push one auxiliary session's conclusion into the main session composer as a
 * DRAFT the user still has to send.
 * @param ctx - client root context.
 * @param auxSessionId - auxiliary session holding the conclusion.
 * @param mainSessionId - session whose composer receives it.
 * @returns the report the panel shows.
 */
export async function handoffToMain(
  ctx: ClientContextLike,
  auxSessionId: string,
  mainSessionId: string,
): Promise<HandoffReport> {
  const auxBinding = attempt(() => ctx.sessions.binding(auxSessionId))
  if (auxBinding === undefined) {
    return { ok: false, message: msg('handoffNoBinding') }
  }
  const text = latestAssistantText(auxBinding)
  if (text === undefined) {
    return { ok: false, message: msg('handoffNoConclusion') }
  }

  const targetCtx =
    attempt(() => ctx.sessions.binding(mainSessionId)?.ctx) ??
    attempt(() => ctx.sessions.scope(mainSessionId))
  const conversation = attempt(() => ctx.get('conversation')) as ConversationLike | undefined
  const input: SessionInputLike | undefined = attempt(() =>
    targetCtx === undefined ? undefined : conversation?.input?.for(targetCtx),
  )

  if (input !== undefined && typeof input.setDraft === 'function') {
    try {
      input.setDraft(text)
      if (typeof input.notify === 'function') {
        input.notify('info', msg('handoffNotify'))
      }
      return { ok: true, message: msg('handoffDrafted') }
    } catch (error) {
      const copied = await copyToClipboard(text)
      return {
        ok: copied,
        message: copied
          ? msg('handoffClipboard', { error: describeError(error) })
          : msg('handoffClipboardNoCb', { error: describeError(error) }),
      }
    }
  }

  const copied = await copyToClipboard(text)
  return {
    ok: copied,
    message: copied
      ? msg('handoffNoInputMachine')
      : msg('handoffNothing'),
  }
}
