/**
 * Position-routed file intake for a document that carries more than one live
 * composer.
 *
 * ## Why this exists
 *
 * `ui-attachment`'s `ComposerAttachments` — the occupant of the
 * `conversation.input.attachments` slot — installs DOCUMENT-level drag/drop
 * listeners once per mounted composer (`installDocumentDropEvents`,
 * `$PKG/dsh-client-ui-attachment/lib/client.js:534-591`). A file dropped
 * ANYWHERE in the window therefore reaches every composer whose
 * `canAcceptDrop` is true, and each of them adds those files to its own draft
 * (uploading them against its own session).
 *
 * That is only correct while exactly one such composer exists — the premise of
 * the shipped composition. Embedded sub-agent chats are excluded by
 * `subagent !== null` (`InputBar`: `canAcceptDrop = subagent === null && …`),
 * so the sub-agent panel never competes for the drop. This plugin mounts a
 * second ORDINARY composer (an auxiliary session is deliberately not a
 * sub-agent session), which breaks the premise: one drop used to be processed
 * twice — the file appeared in the main session's draft AND in the auxiliary
 * one, and was uploaded to both sessions (verified live: one drop, two
 * `POST /api/session/uploadFileBinary` calls, one per session id).
 *
 * ## What this module does
 *
 * While at least one auxiliary surface is mounted, the plugin owns the
 * document's CAPTURE-phase drag/drop path:
 *
 * - the drop's own POSITION decides the target session, read from
 *   `[data-conversation-session]` — the framework's own attribution attribute
 *   (`ui-conversation` resolves the stop shortcut with the same
 *   `closest("[data-conversation-session]")` lookup);
 * - the original event is stopped before any bubble listener can run, so
 *   neither composer's document-wide intake fires;
 * - the exact files are re-delivered to the TARGET composer's own Lexical
 *   editor as a synthetic `paste`, which runs that composer's ordinary
 *   PASTE → intake path. No intake policy is duplicated here: the official
 *   code still decides uploads vs `@path` mentions, image limits and toasts,
 *   with the ORIGINAL `File` objects — so `webkitGetAsEntry` (directory
 *   detection) and the desktop `__DSH_HOST_PATHS__.pathFor` bridge keep
 *   working exactly as they do for a real drop.
 *
 * With no auxiliary surface mounted the router is inert: it never calls
 * `preventDefault` and never stops propagation, so the shipped
 * single-composer behaviour is unchanged.
 * @module client/drop-router
 */

/** Auxiliary surface pin (`AuxPaneBody` / `AuxRightbarPanel` roots). */
export const AUX_SURFACE_SELECTOR = '[data-aux-chat]'

/** Attribute naming the session an auxiliary surface is bound to. */
export const AUX_SESSION_ATTR = 'data-aux-session'

/** Attribute the framework pins on every rendered conversation occurrence. */
export const OCCURRENCE_SELECTOR = '[data-conversation-session]'

/** Attribute naming that occurrence's session. */
export const OCCURRENCE_SESSION_ATTR = 'data-conversation-session'

/** The composer's own Lexical root inside one conversation occurrence. */
export const COMPOSER_EDITOR_SELECTOR = '[data-conversation-region="composer"] [contenteditable="true"]'

/** Drag-hover pin the stylesheet reads (`styles.css`). */
export const AUX_DRAG_ATTR = 'data-aux-drag'

/** Drag-hover value set while a file drag hovers an auxiliary surface. */
export const AUX_DRAG_ACTIVE = 'active'

/** Minimal element face (structurally satisfied by `Element`). */
export interface DropElementLike {
  closest(selector: string): DropElementLike | null
  querySelector(selector: string): DropElementLike | null
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  dispatchEvent(event: unknown): boolean
}

/** Minimal `DataTransfer` face. */
export interface DropTransferLike {
  readonly types?: ArrayLike<string> | undefined
  readonly files?: ArrayLike<unknown> | undefined
  readonly items?: { add(file: unknown): void } | undefined
  dropEffect?: string | undefined
}

/** Minimal drag/drop event face. */
export interface DropEventLike {
  readonly target?: unknown
  readonly dataTransfer?: DropTransferLike | null | undefined
  preventDefault(): void
  stopPropagation(): void
  stopImmediatePropagation?(): void
}

/** Minimal document face (structurally satisfied by `Document`). */
export interface DropDocumentLike {
  querySelector(selector: string): DropElementLike | null
  querySelectorAll(selector: string): ArrayLike<DropElementLike>
  addEventListener(type: string, listener: (event: DropEventLike) => void, capture?: boolean): void
  removeEventListener(type: string, listener: (event: DropEventLike) => void, capture?: boolean): void
}

/** The view's constructors the router needs to rebuild one paste event. */
export interface DropViewLike {
  readonly ClipboardEvent?: (new (type: string, init?: Record<string, unknown>) => unknown) | undefined
  readonly DataTransfer?: (new () => DropTransferLike) | undefined
}

/** One resolved drop: the session it belongs to and where to deliver it. */
export interface DropRoute {
  /** Session that owns the drop. */
  readonly sessionId: string
  /** That session's composer editor (the synthetic paste target). */
  readonly editor: DropElementLike
  /** Auxiliary surface under the drop, when the drop landed in one. */
  readonly pane: DropElementLike | undefined
  /** Whether the drop landed inside an auxiliary surface. */
  readonly insideAux: boolean
}

/** Options for {@link installDropRouter}. */
export interface DropRouterOptions {
  readonly document?: DropDocumentLike | undefined
  readonly view?: DropViewLike | undefined
  /**
   * Reports whether a session id belongs to a sub-agent conversation. Sub-agent
   * composers refuse files (`canAcceptDrop` is false there), so the shipped
   * document listener silently discards a drop aimed at one; this router
   * reroutes those drops to the ordinary composer instead.
   */
  readonly isSubagentSession?: ((sessionId: string) => boolean) | undefined
}

function elementOf(target: unknown): DropElementLike | undefined {
  const candidate = target as Partial<DropElementLike> | null | undefined
  if (candidate === null || candidate === undefined) return undefined
  if (typeof candidate.closest !== 'function') return undefined
  return candidate as DropElementLike
}

function closestOf(element: DropElementLike, selector: string): DropElementLike | undefined {
  try {
    return element.closest(selector) ?? undefined
  } catch {
    return undefined
  }
}

function attributeOf(element: DropElementLike | undefined, name: string): string | undefined {
  if (element === undefined) return undefined
  try {
    const value = element.getAttribute(name)
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

function editorWithin(element: DropElementLike | undefined): DropElementLike | undefined {
  if (element === undefined) return undefined
  try {
    return element.querySelector(COMPOSER_EDITOR_SELECTOR) ?? undefined
  } catch {
    return undefined
  }
}

function hasFiles(transfer: DropTransferLike | null | undefined): transfer is DropTransferLike {
  if (transfer === null || transfer === undefined) return false
  const types = transfer.types
  if (types === null || types === undefined) return false
  const length = typeof (types as ArrayLike<string>).length === 'number' ? (types as ArrayLike<string>).length : 0
  if (typeof (types as { includes?: unknown }).includes === 'function') {
    try {
      return (types as unknown as { includes(value: string): boolean }).includes('Files')
    } catch {
      /* fall through to the indexed scan */
    }
  }
  for (let index = 0; index < length; index += 1) {
    if ((types as ArrayLike<string>)[index] === 'Files') return true
  }
  return false
}

function filesOf(transfer: DropTransferLike): readonly unknown[] {
  const files = transfer.files
  if (files === null || files === undefined) return []
  const length = typeof files.length === 'number' ? files.length : 0
  const collected: unknown[] = []
  for (let index = 0; index < length; index += 1) collected.push(files[index])
  return collected
}

function sessionOfOccurrence(element: DropElementLike | undefined): string | undefined {
  return attributeOf(element, OCCURRENCE_SESSION_ATTR)
}

/**
 * Find the ordinary (non-auxiliary, non-sub-agent) conversation occurrence a
 * drop with no occurrence of its own belongs to. Document order puts the main
 * column before anything embedded in its transcript, and sub-agent occurrences
 * are skipped because their composers refuse files.
 */
function mainOccurrence(doc: DropDocumentLike, isSubagentSession: (id: string) => boolean): DropElementLike | undefined {
  let occurrences: ArrayLike<DropElementLike>
  try {
    occurrences = doc.querySelectorAll(OCCURRENCE_SELECTOR)
  } catch {
    return undefined
  }
  const length = typeof occurrences.length === 'number' ? occurrences.length : 0
  for (let index = 0; index < length; index += 1) {
    const element = occurrences[index]
    if (element === undefined) continue
    const sessionId = sessionOfOccurrence(element)
    if (sessionId === undefined) continue
    if (closestOf(element, AUX_SURFACE_SELECTOR) !== undefined) continue
    if (isSubagentSession(sessionId)) continue
    return element
  }
  return undefined
}

function occurrenceForSession(doc: DropDocumentLike, sessionId: string): DropElementLike | undefined {
  let occurrences: ArrayLike<DropElementLike>
  try {
    occurrences = doc.querySelectorAll(OCCURRENCE_SELECTOR)
  } catch {
    return undefined
  }
  const length = typeof occurrences.length === 'number' ? occurrences.length : 0
  for (let index = 0; index < length; index += 1) {
    const element = occurrences[index]
    if (element !== undefined && sessionOfOccurrence(element) === sessionId) return element
  }
  return undefined
}

/**
 * Attribute one drop to a session by position alone (no editor requirement),
 * so drag-hover styling can use the same decision as the drop itself.
 * @param doc - document to read occurrences from.
 * @param target - the drop's own target node.
 * @param isSubagentSession - sub-agent predicate; defaults to "never".
 * @returns the located session, surface, and occurrence.
 */
export function locateDropTarget(
  doc: DropDocumentLike,
  target: unknown,
  isSubagentSession: (sessionId: string) => boolean = () => false,
): { sessionId: string | undefined; pane: DropElementLike | undefined; occurrence: DropElementLike | undefined; insideAux: boolean } {
  const element = elementOf(target)
  const pane = element === undefined ? undefined : closestOf(element, AUX_SURFACE_SELECTOR)
  const insideAux = pane !== undefined
  const occurrence = element === undefined ? undefined : closestOf(element, OCCURRENCE_SELECTOR)
  let sessionId = insideAux ? sessionOfOccurrence(occurrence) ?? attributeOf(pane, AUX_SESSION_ATTR) : sessionOfOccurrence(occurrence)
  if (sessionId !== undefined && !insideAux && isSubagentSession(sessionId)) {
    // A sub-agent composer refuses files; the shipped behaviour for such a drop
    // is the ordinary composer, so resolve it as if the drop had no occurrence.
    sessionId = undefined
  }
  let chosen = occurrence
  if (sessionId === undefined) {
    chosen = mainOccurrence(doc, isSubagentSession)
    sessionId = sessionOfOccurrence(chosen)
  }
  return { sessionId, pane, occurrence: chosen, insideAux }
}

/**
 * Resolve one drop to its session and delivery editor.
 * @param doc - document to read occurrences from.
 * @param target - the drop's own target node.
 * @param isSubagentSession - sub-agent predicate; defaults to "never".
 * @returns the route, or `undefined` when no composer can take the files.
 */
export function resolveDropRoute(
  doc: DropDocumentLike,
  target: unknown,
  isSubagentSession: (sessionId: string) => boolean = () => false,
): DropRoute | undefined {
  const located = locateDropTarget(doc, target, isSubagentSession)
  if (located.sessionId === undefined) return undefined
  const editor =
    editorWithin(located.occurrence) ??
    (located.insideAux ? editorWithin(located.pane) : undefined) ??
    editorWithin(occurrenceForSession(doc, located.sessionId))
  if (editor === undefined) return undefined
  return {
    sessionId: located.sessionId,
    editor,
    pane: located.insideAux ? located.pane : undefined,
    insideAux: located.insideAux,
  }
}

/**
 * Rebuild the drop's files as a paste event for one composer editor. The
 * original transfer is reused verbatim when the view accepts it, which keeps
 * `webkitGetAsEntry` and the identity of every `File` (the desktop path bridge
 * resolves paths by that identity).
 */
function pasteFor(view: DropViewLike | undefined, transfer: DropTransferLike): unknown {
  const ClipboardEventCtor = view?.ClipboardEvent
  if (typeof ClipboardEventCtor !== 'function') return undefined
  try {
    return new ClipboardEventCtor('paste', { clipboardData: transfer, bubbles: false, cancelable: true })
  } catch {
    /* the view refused a foreign transfer; rebuild a file-only one */
  }
  const DataTransferCtor = view?.DataTransfer
  if (typeof DataTransferCtor !== 'function') return undefined
  try {
    const copy = new DataTransferCtor()
    for (const file of filesOf(transfer)) copy.items?.add(file)
    return new ClipboardEventCtor('paste', { clipboardData: copy, bubbles: false, cancelable: true })
  } catch {
    return undefined
  }
}

/**
 * Install the router on one document.
 * @param options - document/view overrides (tests) and the sub-agent predicate.
 * @returns the disposer that removes every listener and clears the drag pin.
 */
export function installDropRouter(options: DropRouterOptions = {}): () => void {
  const doc = options.document ?? (typeof document === 'undefined' ? undefined : (document as unknown as DropDocumentLike))
  if (doc === undefined) return () => undefined
  // An offline or partial document face (the smoke harness installs a minimal
  // shim without event-target methods) must degrade to a no-op, never to a boot
  // failure.
  if (typeof doc.addEventListener !== 'function' || typeof doc.removeEventListener !== 'function') return () => undefined
  const view = options.view ?? (globalThis as unknown as DropViewLike)
  const isSubagent = options.isSubagentSession ?? (() => false)

  /** Auxiliary surfaces own the drop only while at least one is mounted. */
  const routerActive = (): boolean => {
    if (typeof doc.querySelector !== 'function') return false
    try {
      return doc.querySelector(AUX_SURFACE_SELECTOR) !== null
    } catch {
      return false
    }
  }

  let hintPane: DropElementLike | undefined
  const clearHint = (): void => {
    const pane = hintPane
    hintPane = undefined
    if (pane === undefined) return
    try {
      pane.removeAttribute(AUX_DRAG_ATTR)
    } catch {
      /* decoration only */
    }
  }
  const setHint = (pane: DropElementLike): void => {
    if (hintPane === pane) return
    clearHint()
    hintPane = pane
    try {
      pane.setAttribute(AUX_DRAG_ATTR, AUX_DRAG_ACTIVE)
    } catch {
      /* decoration only */
    }
  }

  const onDragEnter = (event: DropEventLike): void => {
    if (!routerActive()) return
    if (!hasFiles(event.dataTransfer)) return
    const located = locateDropTarget(doc, event.target, isSubagent)
    if (!located.insideAux || located.pane === undefined) return
    event.stopPropagation()
    setHint(located.pane)
  }

  const onDragOver = (event: DropEventLike): void => {
    if (!routerActive()) return
    const transfer = event.dataTransfer
    if (!hasFiles(transfer)) return
    const located = locateDropTarget(doc, event.target, isSubagent)
    if (!located.insideAux || located.pane === undefined) return
    // The surface must accept the drag itself: stopping the document listeners
    // also stops their `preventDefault`, and an unaccepted dragover suppresses
    // the drop event entirely.
    event.preventDefault()
    event.stopPropagation()
    setHint(located.pane)
    if (transfer !== null && transfer !== undefined) {
      try {
        transfer.dropEffect = 'copy'
      } catch {
        /* not writable on every carrier */
      }
    }
  }

  const onDragLeave = (event: DropEventLike): void => {
    if (hintPane === undefined) return
    const located = locateDropTarget(doc, event.target, isSubagent)
    if (located.insideAux && located.pane === hintPane) return
    clearHint()
  }

  const onDragEnd = (): void => {
    clearHint()
  }

  const onDrop = (event: DropEventLike): void => {
    const transfer = event.dataTransfer
    clearHint()
    if (!hasFiles(transfer)) return
    if (!routerActive()) return
    const route = resolveDropRoute(doc, event.target, isSubagent)
    if (route === undefined) return
    const paste = pasteFor(view, transfer)
    if (paste === undefined) return
    event.preventDefault()
    // Capture phase on the document is the first stop of the propagation path,
    // so this also suppresses the document-level bubble listeners every
    // composer installed — exactly one intake runs for this drop.
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
    else event.stopPropagation()
    route.editor.dispatchEvent(paste)
  }

  doc.addEventListener('dragenter', onDragEnter, true)
  doc.addEventListener('dragover', onDragOver, true)
  doc.addEventListener('dragleave', onDragLeave, true)
  doc.addEventListener('dragend', onDragEnd, true)
  doc.addEventListener('drop', onDrop, true)
  return () => {
    clearHint()
    doc.removeEventListener('dragenter', onDragEnter, true)
    doc.removeEventListener('dragover', onDragOver, true)
    doc.removeEventListener('dragleave', onDragLeave, true)
    doc.removeEventListener('dragend', onDragEnd, true)
    doc.removeEventListener('drop', onDrop, true)
  }
}
