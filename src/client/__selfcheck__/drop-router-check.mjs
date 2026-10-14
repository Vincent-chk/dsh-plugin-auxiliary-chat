/**
 * Drop-router self-check.
 *
 * Drives the real `client/drop-router.ts` against a minimal DOM that models the
 * exact hostile shape: a conversation tree with an ordinary composer, a
 * sub-agent occurrence, and one or more auxiliary surfaces, plus the
 * document-level drop listener `ui-attachment` installs once per composer
 * (`installDocumentDropEvents`). The baseline check proves the harness
 * reproduces the reported defect (one drop, two intakes); the rest prove the
 * router's attribution, inertness, and delivery.
 *
 * Usage: node --experimental-transforms-types src/client/__selfcheck__/drop-router-check.mjs
 */
import {
  AUX_DRAG_ACTIVE,
  AUX_DRAG_ATTR,
  AUX_SESSION_ATTR,
  AUX_SURFACE_SELECTOR,
  COMPOSER_EDITOR_SELECTOR,
  OCCURRENCE_SELECTOR,
  OCCURRENCE_SESSION_ATTR,
  installDropRouter,
  locateDropTarget,
  resolveDropRoute,
} from '../drop-router.ts'

const passes = []
const failures = []
const check = (ok, label) => (ok ? passes.push(label) : failures.push(`FAIL ${label}`))

// ── mini DOM (only the selector grammar the router uses) ───────────────────

const SIMPLE = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u

function parseSelector(selector) {
  return selector.trim().split(/\s+/u).map((part) => {
    const match = SIMPLE.exec(part)
    if (match === null) throw new Error(`unsupported selector: ${part}`)
    return { name: match[1], value: match[2] }
  })
}

const matchesSimple = (element, simple) => {
  const actual = element.getAttribute(simple.name)
  if (actual === null) return false
  return simple.value === undefined ? true : actual === simple.value
}

function matchesSelector(element, selector) {
  const parts = parseSelector(selector)
  if (!matchesSimple(element, parts[parts.length - 1])) return false
  let ancestor = element.parent
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    let found = false
    while (ancestor !== null && ancestor.tag !== '#document') {
      if (matchesSimple(ancestor, parts[index])) {
        found = true
        ancestor = ancestor.parent
        break
      }
      ancestor = ancestor.parent
    }
    if (!found) return false
  }
  return true
}

class FakeElement {
  constructor(tag, attrs = {}) {
    this.tag = tag
    this.attrs = { ...attrs }
    this.children = []
    this.parent = null
    this.listeners = []
    this.dispatched = []
  }

  append(child) {
    child.parent = this
    this.children.push(child)
    return child
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value)
  }

  removeAttribute(name) {
    delete this.attrs[name]
  }

  closest(selector) {
    let node = this
    while (node !== null && node.tag !== '#document') {
      if (matchesSelector(node, selector)) return node
      node = node.parent
    }
    return null
  }

  descendants() {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  querySelectorAll(selector) {
    return this.descendants().filter((element) => matchesSelector(element, selector))
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  addEventListener(type, listener, capture = false) {
    this.listeners.push({ type, listener, capture: capture === true })
  }

  removeEventListener(type, listener, capture = false) {
    const index = this.listeners.findIndex(
      (entry) => entry.type === type && entry.listener === listener && entry.capture === (capture === true),
    )
    if (index >= 0) this.listeners.splice(index, 1)
  }

  dispatchEvent(event) {
    if (event.target === undefined) event.target = this
    this.dispatched.push(event)
    propagate(event, this)
    return !event.defaultPrevented
  }
}

function propagate(event, target) {
  const path = []
  for (let node = target; node !== null; node = node.parent) path.unshift(node)
  const run = (node, capture) => {
    for (const entry of [...node.listeners]) {
      if (entry.capture !== capture || entry.type !== event.type) continue
      if (event.immediate) return
      entry.listener(event)
    }
  }
  for (const node of path) {
    if (event.stopped) return
    if (node === target) break
    run(node, true)
  }
  if (!event.stopped) run(target, true)
  if (!event.stopped) run(target, false)
  for (const node of path.slice(0, -1).reverse()) {
    if (event.stopped) return
    run(node, false)
  }
}

// ── fake view (ClipboardEvent / DataTransfer) ──────────────────────────────

class FakeDataTransfer {
  constructor() {
    this._files = []
    this.items = { add: (file) => { this._files.push(file) } }
  }

  get files() {
    return this._files
  }

  get types() {
    return ['Files']
  }
}

class FakeClipboardEvent {
  constructor(type, init = {}) {
    this.type = type
    this.clipboardData = init.clipboardData ?? null
    this.bubbles = init.bubbles === true
    this.cancelable = init.cancelable === true
  }
}

/** A view whose ClipboardEvent refuses foreign transfers (fallback path). */
class StrictClipboardEvent extends FakeClipboardEvent {
  constructor(type, init = {}) {
    if (init.clipboardData !== undefined && !(init.clipboardData instanceof FakeDataTransfer)) {
      throw new TypeError('clipboardData must be a DataTransfer')
    }
    super(type, init)
  }
}

const FILE_ONLY_VIEW = { ClipboardEvent: FakeClipboardEvent, DataTransfer: FakeDataTransfer }

function makeEvent(type, { target, dataTransfer = null } = {}) {
  const event = {
    type,
    target,
    dataTransfer,
    defaultPrevented: false,
    stopped: false,
    immediate: false,
    preventDefault() { event.defaultPrevented = true },
    stopPropagation() { event.stopped = true },
    stopImmediatePropagation() { event.stopped = true; event.immediate = true },
  }
  return event
}

const fileEvent = (type, name, target) => {
  const transfer = new FakeDataTransfer()
  transfer.items.add({ name, kind: 'file' })
  return makeEvent(type, { target, dataTransfer: transfer })
}

// ── page builder ───────────────────────────────────────────────────────────

function buildPage({ auxIds = [], withEditors = true, subagent = false } = {}) {
  const doc = new FakeElement('#document')
  const body = doc.append(new FakeElement('body'))
  const drafts = {}
  const intake = []

  const editorOf = (sessionId, host) => {
    if (!withEditors) return null
    const seat = host.append(new FakeElement('div', { 'data-conversation-region': 'composer' }))
    const editor = seat.append(new FakeElement('div', { contenteditable: 'true' }))
    editor.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files ?? [])]
      drafts[sessionId] = [...(drafts[sessionId] ?? []), ...files.map((file) => file.name)]
    })
    return editor
  }

  const main = body.append(new FakeElement('div', { [OCCURRENCE_SESSION_ATTR]: 'main-1' }))
  editorOf('main-1', main)

  let sub = null
  if (subagent) {
    sub = main.append(new FakeElement('div', { [OCCURRENCE_SESSION_ATTR]: 'sub-1' }))
    editorOf('sub-1', sub)
  }

  const panes = auxIds.map((auxId) => {
    const pane = body.append(new FakeElement('div', { 'data-aux-chat': 'pane', [AUX_SESSION_ATTR]: auxId }))
    const occurrence = pane.append(new FakeElement('div', { [OCCURRENCE_SESSION_ATTR]: auxId }))
    editorOf(auxId, occurrence)
    return { pane, occurrence }
  })

  /** The official per-composer document listener (ui-attachment shape). */
  const installOfficial = (sessionId, { canAccept = true } = {}) => {
    const listener = (event) => {
      if (!canAccept) return
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      intake.push({ by: 'official', sessionId, files: files.map((file) => file.name) })
      drafts[sessionId] = [...(drafts[sessionId] ?? []), ...files.map((file) => file.name)]
    }
    doc.addEventListener('drop', listener, false)
    return listener
  }

  return { doc, body, main, sub, panes, drafts, intake, installOfficial }
}

const namesIn = (drafts, sessionId) => drafts[sessionId] ?? []

// ── D00 baseline: the harness models the reported defect ───────────────────

{
  const page = buildPage({ auxIds: ['aux-1'] })
  page.installOfficial('main-1')
  page.installOfficial('aux-1')
  const auxSeat = page.panes[0].occurrence.querySelector(COMPOSER_EDITOR_SELECTOR).parent
  auxSeat.dispatchEvent(fileEvent('drop', 'leak.txt', auxSeat))
  check(
    namesIn(page.drafts, 'main-1').includes('leak.txt') && namesIn(page.drafts, 'aux-1').includes('leak.txt'),
    'D00 baseline: without the router one drop reaches BOTH composers (the reported defect)',
  )
}

// ── D01 inertness without an auxiliary surface ────────────────────────────

{
  const page = buildPage()
  const official = page.installOfficial('main-1')
  const off = installDropRouter({ document: page.doc, view: FILE_ONLY_VIEW })
  const seat = page.main.querySelector(COMPOSER_EDITOR_SELECTOR).parent
  const event = fileEvent('drop', 'plain.txt', seat)
  seat.dispatchEvent(event)
  check(event.defaultPrevented === false, 'D01 a drop with no auxiliary surface is not intercepted')
  check(namesIn(page.drafts, 'main-1').includes('plain.txt'), 'D01 the official listener still receives it')
  check(page.intake.length === 1, 'D01 exactly one official intake ran')
  off()
  void official
}

// ── D02 drop inside the auxiliary surface lands in the auxiliary session ──

{
  const page = buildPage({ auxIds: ['aux-1'] })
  page.installOfficial('main-1')
  page.installOfficial('aux-1')
  const off = installDropRouter({ document: page.doc, view: FILE_ONLY_VIEW })
  const seat = page.panes[0].occurrence.querySelector(COMPOSER_EDITOR_SELECTOR).parent
  const event = fileEvent('drop', 'side.txt', seat)
  seat.dispatchEvent(event)
  check(event.defaultPrevented === true, 'D02 the drop is intercepted')
  check(page.intake.length === 0, 'D02 no document-level intake ran (neither composer)')
  check(namesIn(page.drafts, 'aux-1').join() === 'side.txt', 'D02 the auxiliary composer received the file exactly once')
  check(namesIn(page.drafts, 'main-1').length === 0, 'D02 the main composer received nothing')
  off()
}

// ── D03 drop inside the main column lands in the main session only ────────

{
  const page = buildPage({ auxIds: ['aux-1'] })
  page.installOfficial('main-1')
  page.installOfficial('aux-1')
  const off = installDropRouter({ document: page.doc, view: FILE_ONLY_VIEW })
  const seat = page.main.querySelector(COMPOSER_EDITOR_SELECTOR).parent
  const event = fileEvent('drop', 'main.txt', seat)
  seat.dispatchEvent(event)
  check(event.defaultPrevented === true, 'D03 the drop is intercepted')
  check(namesIn(page.drafts, 'main-1').join() === 'main.txt', 'D03 the main composer received the file exactly once')
  check(namesIn(page.drafts, 'aux-1').length === 0, 'D03 the auxiliary composer received nothing')
  off()
}

// ── D04 drop outside every conversation falls back to the main session ────

{
  const page = buildPage({ auxIds: ['aux-1'] })
  const off = installDropRouter({ document: page.doc, view: FILE_ONLY_VIEW })
  const chrome = page.body.append(new FakeElement('div', {}))
  const event = fileEvent('drop', 'chrome.txt', chrome)
  chrome.dispatchEvent(event)
  check(event.defaultPrevented === true, 'D04 a drop on window chrome is intercepted')
  check(namesIn(page.drafts, 'main-1').join() === 'chrome.txt', 'D04 it is delivered to the main session')
  off()
}

// ── D05 drop on auxiliary pane chrome (no occurrence) uses the pane pin ───

{
  const page = buildPage({ auxIds: ['aux-1'] })
  const auxPane = page.panes[0].occurrence
  const chrome = auxPane.parent.append(new FakeElement('div', {}))
  const off = installDropRouter({ document: page.doc, view: FILE_ONLY_VIEW })
  const event = fileEvent('drop', 'chrome-aux.txt', chrome)
  chrome.dispatchEvent(event)
  check(namesIn(page.drafts, 'aux-1').join() === 'chrome-aux.txt', 'D05 pane-chrome drop is delivered to the auxiliary session')
  off()
}

// ── D06 sub-agent occurrence reroutes to the ordinary composer ────────────

{
  const page = buildPage({ auxIds: ['aux-1'], subagent: true })
  const off = installDropRouter({
    document: page.doc,
    view: FILE_ONLY_VIEW,
    isSubagentSession: (sessionId) => sessionId === 'sub-1',
  })
  const seat = page.sub.querySelector(COMPOSER_EDITOR_SELECTOR).parent
  const event = fileEvent('drop', 'sub.txt', seat)
  seat.dispatchEvent(event)
  check(namesIn(page.drafts, 'sub-1').length === 0, 'D06 a sub-agent composer never receives the drop')
  check(namesIn(page.drafts, 'main-1').join() === 'sub.txt', 'D06 it reaches the ordinary composer instead')
  off()
}

// ── D07 non-file transfers stay untouched ────────────────────────────────

{
  const page = buildPage({ auxIds: ['aux-1'] })
  const off = installDropRouter({ document: page.doc, view: FILE_ONLY_VIEW })
  const seat = page.panes[0].occurrence.querySelector(COMPOSER_EDITOR_SELECTOR).parent
  const event = makeEvent('drop', { target: seat, dataTransfer: { types: ['text/plain'], files: [] } })
  seat.dispatchEvent(event)
  check(event.defaultPrevented === false, 'D07 a text drag is not intercepted')
  off()
}

// ── D08 no editor -> no interception (official path survives) ─────────────

{
  const page = buildPage({ auxIds: ['aux-1'], withEditors: false })
  const official = page.installOfficial('aux-1')
  const off = installDropRouter({ document: page.doc, view: FILE_ONLY_VIEW })
  const seat = page.panes[0].occurrence.append(new FakeElement('div', {}))
  const event = fileEvent('drop', 'no-editor.txt', seat)
  seat.dispatchEvent(event)
  check(event.defaultPrevented === false, 'D08 a drop with no reachable editor is left to the official path')
  check(namesIn(page.drafts, 'aux-1').includes('no-editor.txt'), 'D08 the official listener handled it')
  off()
  void official
}

// ── D09 drag-hover: accepted inside, untouched outside ───────────────────

{
  const page = buildPage({ auxIds: ['aux-1'] })
  const off = installDropRouter({ document: page.doc, view: FILE_ONLY_VIEW })
  const pane = page.panes[0].pane
  const seat = page.panes[0].occurrence.querySelector(COMPOSER_EDITOR_SELECTOR).parent
  const over = fileEvent('dragover', 'hover.txt', seat)
  seat.dispatchEvent(over)
  check(over.defaultPrevented === true, 'D09 dragover inside the auxiliary surface is accepted')
  check(over.dataTransfer.dropEffect === 'copy', 'D09 the drop effect is advertised as copy')
  check(pane.getAttribute(AUX_DRAG_ATTR) === AUX_DRAG_ACTIVE, 'D09 the surface is pinned as the drag target')
  const outside = fileEvent('dragover', 'hover.txt', page.body)
  page.body.dispatchEvent(outside)
  check(outside.defaultPrevented === false, 'D09 dragover outside the surface is untouched')
  const drop = fileEvent('drop', 'hover.txt', seat)
  seat.dispatchEvent(drop)
  check(pane.getAttribute(AUX_DRAG_ATTR) === null, 'D09 the drag pin clears on drop')
  off()
}

// ── D10 listeners are capture-phase and the disposer removes them ────────

{
  const page = buildPage({ auxIds: ['aux-1'] })
  const off = installDropRouter({ document: page.doc, view: FILE_ONLY_VIEW })
  const dropEntry = page.doc.listeners.find((entry) => entry.type === 'drop')
  check(dropEntry !== undefined && dropEntry.capture === true, 'D10 the drop listener is capture-phase')
  const seat = page.panes[0].occurrence.querySelector(COMPOSER_EDITOR_SELECTOR).parent
  off()
  check(page.doc.listeners.every((entry) => entry.type !== 'drop'), 'D10 dispose removes the listener')
  const event = fileEvent('drop', 'after-off.txt', seat)
  seat.dispatchEvent(event)
  check(event.defaultPrevented === false, 'D10 a disposed router no longer intercepts')
}

// ── D11 two auxiliary surfaces route to their own sessions ───────────────

{
  const page = buildPage({ auxIds: ['aux-1', 'aux-2'] })
  const off = installDropRouter({ document: page.doc, view: FILE_ONLY_VIEW })
  const seat = page.panes[1].occurrence.querySelector(COMPOSER_EDITOR_SELECTOR).parent
  const event = fileEvent('drop', 'second.txt', seat)
  seat.dispatchEvent(event)
  check(namesIn(page.drafts, 'aux-2').join() === 'second.txt', 'D11 the drop lands in the surface it was dropped on')
  check(namesIn(page.drafts, 'aux-1').length === 0, 'D11 the other auxiliary surface is untouched')
  off()
}

// ── D12 a view that refuses a foreign transfer still delivers ────────────

{
  const page = buildPage({ auxIds: ['aux-1'] })
  const off = installDropRouter({
    document: page.doc,
    view: { ClipboardEvent: StrictClipboardEvent, DataTransfer: FakeDataTransfer },
  })
  const seat = page.panes[0].occurrence.querySelector(COMPOSER_EDITOR_SELECTOR).parent
  const event = fileEvent('drop', 'rebuilt.txt', seat)
  seat.dispatchEvent(event)
  check(event.defaultPrevented === true, 'D12 the drop is still intercepted when the view rejects the transfer')
  check(namesIn(page.drafts, 'aux-1').join() === 'rebuilt.txt', 'D12 the rebuilt file-only transfer delivers the file')
  off()
}

// ── D13 attribution helpers agree with the routed drop ───────────────────

{
  const page = buildPage({ auxIds: ['aux-1'] })
  const seat = page.panes[0].occurrence.querySelector(COMPOSER_EDITOR_SELECTOR).parent
  const located = locateDropTarget(page.doc, seat)
  check(located.sessionId === 'aux-1' && located.insideAux === true, 'D13 locateDropTarget attributes an auxiliary drop')
  const route = resolveDropRoute(page.doc, seat)
  check(route?.sessionId === 'aux-1', 'D13 resolveDropRoute names the same session')
  check(route?.editor === page.panes[0].occurrence.querySelector(COMPOSER_EDITOR_SELECTOR), 'D13 it targets that composer editor')
  check(AUX_SURFACE_SELECTOR === '[data-aux-chat]' && OCCURRENCE_SELECTOR === '[data-conversation-session]', 'D13 the routing selectors stay pinned')
}

// ── D14 a partial document face degrades to a no-op ─────────────────────

{
  let disposed = false
  const off = installDropRouter({
    document: { querySelector: () => null },
    view: FILE_ONLY_VIEW,
  })
  disposed = typeof off === 'function'
  off()
  check(disposed, 'D14 a document without event-target methods yields a no-op disposer (smoke shim)')
}

for (const line of passes) console.log(`ok   ${line}`)
for (const line of failures) console.error(line)
console.log(
  failures.length === 0
    ? `drop-router: ${String(passes.length)} checks passed`
    : `drop-router: ${String(failures.length)} FAILED`,
)
process.exit(failures.length === 0 ? 0 : 1)
