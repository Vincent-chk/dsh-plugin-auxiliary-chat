#!/usr/bin/env node
/**
 * ⚠️ STALE (2026-10-14): this harness targets the retired single-command
 * `/aux-chat` API and no longer runs against the current two-phase
 * create + `/aux-init` design. It is kept for reference only. The live
 * offline gates are `scripts/build|smoke|verify|integration.mjs`,
 * `npm run race-check` (PRD v2.0 close/identity chain), and
 * `scripts/e2e-isolated.mjs` (real-stack contract probes).
 */
/**
 * Offline behavioural self-check for the client half (owner: aux-client).
 *
 * `scripts/smoke.mjs` proves the bundle registers and that `apply` contributes
 * its slots, but it never renders a component and never exercises a swap. This
 * harness reproduces the two platform seeds the bundle actually requires
 * (`react`, `react/jsx-runtime`) with a tiny hook shim, re-implements the slot
 * registry's "declaring is claiming" semantics faithfully enough to be
 * meaningful, and then drives the REAL registrations:
 *
 *   PHASE A — no official right Sidebar (this machine):
 *     A1 the three path-A seats exist and panellist/main are gone,
 *     A2 the conversation-header toggle reports geometry to `ctx.layout`
 *        (`openRightbar(true, false)` / `closeRightbar()`),
 *     A3 the rightbar occupant pins itself to the right edge at the resolved
 *        width and binds the main session,
 *     A4 create → `/aux-chat`, tab, retain(aux, auxChatPanel),
 *     A5 the conversation hole re-binds to the auxiliary session and renders
 *        `conversation.content` with `{variant:'embedded', phase, hero}`,
 *        a `views` selection and a fallback,
 *     A6 the full phase matrix,
 *     A7 hiding the column keeps every tab and reference (the lifecycle the
 *        user confirmed) and re-shows the same session,
 *     A8 handoff through the public input machine, and the clipboard fallback,
 *     A9 closing a tab releases the reference and sends `/aux-end`,
 *     A10 page unload sends `/aux-end` for every open tab.
 *
 *   PHASE B — official `sidebarRightTabs` present: no `rightbar` occupation,
 *     the two-stage official registration instead.
 *
 *   PHASE C — the official package arrives late: path A is torn down (including
 *     the conversation hole, which follows the declaration) and path B installs.
 *
 * Run (after `node scripts/build.mjs --half client`):
 *   node src/client/__selfcheck__/render-check.mjs
 * @module client/__selfcheck__/render-check
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(join(root, 'lib/client.js'), 'utf8')

const RETAIN_SOURCE = 'auxChatPanel'
const MAIN = 'session-main-0001'
const CONCLUSION = '辅助结论：已定位到根因，建议回滚第 42 行的改动。'

const checks = []
const failures = []
function check(label, condition, detail) {
  const ok = Boolean(condition)
  checks.push({ label, ok })
  if (!ok) failures.push(`${label}${detail === undefined ? '' : `  [${detail}]`}`)
}

// ── platform seeds ─────────────────────────────────────────────────────────
const Fragment = Symbol.for('react.fragment')
/**
 * Hook runtime.
 *
 * One-shot `render()` calls stay stateless (hooks are inert), which is all the
 * pure presentational assertions need. `mountRoot()` switches to a real-enough
 * runtime — per-component-type hook slots, dependency-checked effects, and a
 * re-render pass driven by `settle()` — because the Path B lifecycle
 * (create-on-mount, abort-destroys, retry) only exists inside effects and
 * state.
 */
let activeInst = null
let rootState = null
const React = {
  Fragment,
  useState: (initial) => {
    if (activeInst === null) return [typeof initial === 'function' ? initial() : initial, () => {}]
    const index = activeInst.cursor
    activeInst.cursor += 1
    if (activeInst.hooks[index] === undefined) {
      activeInst.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = activeInst.hooks[index]
    return [
      slot.value,
      (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        if (rootState !== null) rootState.dirty = true
      },
    ]
  },
  useEffect: (fn, deps) => {
    if (activeInst === null) return
    const index = activeInst.cursor
    activeInst.cursor += 1
    const previous = activeInst.hooks[index]
    const unchanged =
      previous !== undefined &&
      Array.isArray(deps) &&
      Array.isArray(previous.deps) &&
      deps.length === previous.deps.length &&
      deps.every((value, slot) => Object.is(value, previous.deps[slot]))
    if (unchanged) return
    activeInst.hooks[index] = { deps, cleanup: previous?.cleanup, fn }
    activeInst.pending.push(index)
  },
  useSyncExternalStore: (subscribe, getSnapshot) => {
    if (activeInst === null) return getSnapshot()
    const index = activeInst.cursor
    activeInst.cursor += 1
    if (activeInst.hooks[index] === undefined) activeInst.hooks[index] = {}
    const slot = activeInst.hooks[index]
    if (slot.subscribe !== subscribe) {
      if (typeof slot.unsubscribe === 'function') slot.unsubscribe()
      slot.subscribe = subscribe
      slot.unsubscribe = subscribe(() => {
        if (rootState !== null) rootState.dirty = true
      })
    }
    return getSnapshot()
  },
  createContext: (value) => ({ value }),
  useContext: (context) => context?.value,
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
}

/** Run the effects one component scheduled during the last render pass. */
function flushEffects(inst) {
  const pending = inst.pending
  inst.pending = []
  for (const index of pending) {
    const slot = inst.hooks[index]
    if (slot === undefined || typeof slot.fn !== 'function') continue
    if (typeof slot.cleanup === 'function') {
      try {
        slot.cleanup()
      } catch {
        /* isolated */
      }
      slot.cleanup = undefined
    }
    const cleanup = slot.fn()
    slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
  }
}

/**
 * One mounted root: a fresh instance table, so a re-mount really is a mount.
 * @returns a handle whose `tree` is always the latest committed render.
 */
function mountRoot(component, props) {
  rootState = { component, props, instances: new Map(), dirty: false, last: null }
  renderRoot()
  return {
    get tree() {
      return rootState === null ? null : rootState.last
    },
    /** Re-render with merged props (a real Session switch, not a remount). */
    setProps(next) {
      if (rootState !== null) rootState.props = { ...rootState.props, ...next }
      return renderRoot()
    },
    rerender: () => renderRoot(),
  }
}

/** Render the mounted root once, then run whatever it scheduled. */
function renderRoot() {
  if (rootState === null) return null
  rootState.dirty = false
  // Render through the element path so `renderComponent` gives the root its
  // instance (and therefore its hooks) — calling the component directly would
  // leave `activeInst` null and every effect inert.
  const out = render({ type: rootState.component, props: rootState.props })
  for (const inst of rootState.instances.values()) flushEffects(inst)
  rootState.last = out
  return out
}

/** Tear the mounted root down (runs every cleanup) and forget it. */
function unmountRoot() {
  if (rootState === null) return
  for (const inst of rootState.instances.values()) {
    inst.pending = []
    for (const hook of inst.hooks) {
      if (typeof hook?.unsubscribe === 'function') {
        try {
          hook.unsubscribe()
        } catch {
          /* isolated */
        }
        hook.unsubscribe = undefined
      }
      if (typeof hook?.cleanup === 'function') {
        try {
          hook.cleanup()
        } catch {
          /* isolated */
        }
        hook.cleanup = undefined
      }
    }
  }
  rootState = null
}
const jsxRuntime = {
  Fragment,
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
}
const seeds = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': {},
  'react-dom/client': {},
  '@deepseek-ai/cordis': {},
  '@deepseek-ai/dsh-client-store': {},
  '@deepseek-ai/dsh-client-ui-slots': {},
  '@deepseek-ai/dsh-client-ui-primitives': {},
  '@deepseek-ai/dsh-client-ui-dockkit': {},
}

// ── minimal DOM ────────────────────────────────────────────────────────────
const styleTags = []
const moduleRegistrations = []
globalThis.window = {
  __ModuleLoader__: { load: (registration) => moduleRegistrations.push(registration) },
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', style: {}, value: '', setAttribute() {}, select() {}, remove() {} }),
  querySelector: () => null,
  head: { appendChild: (tag) => styleTags.push(tag) },
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => false,
}

// ── a faithful-enough slot registry ────────────────────────────────────────
/**
 * "Declaring is claiming": a registration's `children` table declares keys, and
 * `inject(key, cb)` runs as soon as the key is declared — collapsing the
 * declaration disposes what it contributed. This mirrors SlotCore closely
 * enough to make the dual-path swap observable.
 */
function makeSlots() {
  const live = []
  const declared = new Map()
  /** key -> [{ callback, active: Disposable[] }]; a collapse disposes the
   *  active effects but KEEPS the registration, so a later declaration runs it
   *  again — exactly what SlotRegistry.inject documents. */
  const injections = new Map()
  const log = []

  const disposeRecord = (record) => {
    const active = record.active
    record.active = []
    for (const dispose of active) {
      try {
        dispose()
      } catch {
        /* isolated */
      }
    }
  }
  const runRecord = (record) => {
    const produced = record.callback()
    record.active = typeof produced === 'function' ? [produced] : [...(produced ?? [])]
  }
  const declare = (key) => {
    const next = (declared.get(key) ?? 0) + 1
    declared.set(key, next)
    if (next !== 1) return
    for (const record of injections.get(key) ?? []) runRecord(record)
  }
  const undeclare = (key) => {
    const next = (declared.get(key) ?? 0) - 1
    if (next > 0) {
      declared.set(key, next)
      return
    }
    declared.delete(key)
    for (const record of injections.get(key) ?? []) disposeRecord(record)
  }
  const anyDeclared = (key) => (declared.get(key) ?? 0) > 0

  return {
    log,
    live,
    get entries() {
      return live
    },
    /** Test-only: declare a framework-owned slot this plugin registers into. */
    declareKey(key) {
      declare(key)
      return () => {
        undeclare(key)
      }
    },
    register(options, component) {
      const entry = { options, component, disposed: false }
      live.push(entry)
      log.push(`register:${String(options.name)}`)
      let released = false
      const release = () => {
        if (released) return
        released = true
        entry.disposed = true
        const index = live.indexOf(entry)
        if (index >= 0) live.splice(index, 1)
        for (const key of Object.keys(options.children ?? {})) undeclare(key)
      }
      for (const key of Object.keys(options.children ?? {})) declare(key)
      return release
    },
    inject(key, callback) {
      const record = { callback, active: [] }
      const list = injections.get(key) ?? []
      list.push(record)
      injections.set(key, list)
      if (anyDeclared(key)) runRecord(record)
      let released = false
      return () => {
        if (released) return
        released = true
        disposeRecord(record)
        const index = list.indexOf(record)
        if (index >= 0) list.splice(index, 1)
      }
    },
    find: (name) => live.find((entry) => entry.options.name === name && !entry.disposed),
    all: (name) => live.filter((entry) => entry.options.name === name && !entry.disposed),
  }
}

// ── recording client context factory ───────────────────────────────────────
function makeEnv(options = {}) {
  let officialPresent = options.official === true
  /** Flip on to make the next `/aux-chat` answer with `kind:'error'`. */
  let failCreate = false
  const commands = []
  const drafts = []
  const retained = []
  const released = []
  const bindings = new Map()
  const layoutCalls = []
  const registeredTypes = []
  let clipboardWrites = 0

  const bindingFor = (sessionId) => ({
    sessionId,
    ctx: { __agentScope: sessionId },
    eventSource: {
      getSnapshot: () => ({
        entries:
          sessionId === MAIN
            ? []
            : [
                { type: 'event', event: { type: 'user/message', data: { message: { content: [] } } } },
                { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: CONCLUSION }] } } } },
                { type: 'transient', event: { type: 'assistant/live-chunk', data: {} } },
              ],
      }),
      subscribe: () => () => {},
    },
  })
  bindings.set(MAIN, bindingFor(MAIN))

  const sessions = {
    list: {
      getSnapshot: () => ({ ids: [MAIN], byId: { [MAIN]: { id: MAIN, blank: false, retainedBy: { mainView: 1 } } } }),
      subscribe: () => () => {},
    },
    retain: (target, retainOptions) => {
      retained.push({ target, options: retainOptions })
      if (!bindings.has(target)) bindings.set(target, bindingFor(target))
      return { sessionId: target, binding: bindings.get(target), ready: Promise.resolve(), release: () => released.push(target) }
    },
    binding: (id) => bindings.get(id),
    scope: (id) => bindings.get(id)?.ctx,
    retainInfo: () => ({ getSnapshot: () => ({ retainedBy: {} }), subscribe: () => () => {} }),
  }

  const conversation = {
    input: { for: (actx) => ({ setDraft: (text) => drafts.push({ actx, text }), notify: () => {} }) },
  }

  const slots = makeSlots()
  // Framework-owned seats this plugin registers into. The real composition
  // declares them (ui-layout's AppFrame owns `rightbar`, ui-conversation owns
  // the session header, the official right Sidebar owns its pane seat).
  slots.declareKey('rightbar')
  slots.declareKey('conversation.session.header.utilities')
  if (options.official === true) {
    slots.declareKey('sidebar.right.pane.tab')
    slots.declareKey('sidebar.right.pane.tab.title')
  }
  const effects = []
  const dictionaries = []
  const official = {
    register(definition) {
      registeredTypes.push(definition)
      return () => {
        const index = registeredTypes.indexOf(definition)
        if (index >= 0) registeredTypes.splice(index, 1)
      }
    },
  }
  const ctx = {
    effect: (setup, label) => {
      effects.push(label)
      setup()
    },
    get: (name) => {
      if (name === 'remote') {
        return {
          commands: {
            execute: async (agentId, line, attachments) => {
              commands.push({ agentId, line, attachments })
              if (line.startsWith('/aux-chat') && failCreate) {
                return { ok: true, value: { result: { kind: 'error', text: '镜像失败：找不到可镜像的主会话' } } }
              }
              const text = line.startsWith('/aux-chat')
                ? JSON.stringify({ ok: true, info: { cwd: '/tmp/ws' }, warnings: ['系统提示词不可读，已跳过'] })
                : JSON.stringify({ ok: true, sessionId: agentId, logRemoved: true, cacheRemoved: true, markerRemoved: true })
              return { ok: true, value: { result: { kind: 'success', text } } }
            },
          },
        }
      }
      if (name === 'conversation') return options.conversationAvailable === false ? undefined : conversation
      if (name === 'layout') {
        return {
          openRightbar: (track, fullscreen) => layoutCalls.push({ kind: 'open', track, fullscreen }),
          closeRightbar: () => layoutCalls.push({ kind: 'close' }),
        }
      }
      if (name === 'sidebarRightTabs') return officialPresent ? official : undefined
      return undefined
    },
    locale: {
      register: (ns, dicts) => {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind: () => (key) => dictionaries[0]?.dicts.en?.[key] ?? key,
    },
    slots: {
      inject: (key, callback) => slots.inject(key, callback),
      register: (opts, component) => slots.register(opts, component),
    },
    sessions,
  }
  if (options.lateOfficial === true) {
    ctx.inject = (deps, callback) => {
      ctx.__latch = { deps, callback }
      return { dispose: () => {} }
    }
  }
  return { ctx, slots, sessions, commands, drafts, retained, released, layoutCalls, registeredTypes, effects, dictionaries,
    setOfficial: (value) => { officialPresent = value },
    setFailCreate: (value) => { failCreate = value } }
}

let clipboardAvailable = false
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get: () => (clipboardAvailable ? { clipboard: { writeText: async () => {} } } : { clipboard: undefined }),
})

// ── tiny renderer over the JSX-runtime output ──────────────────────────────
/**
 * Invoke one function component. Inside a mounted root each component TYPE gets
 * its own hook slots (one live instance per type, which is all this harness
 * renders); outside one, hooks are inert.
 * @param type - component function.
 * @param props - its props.
 * @returns its element tree.
 */
function renderComponent(type, props) {
  if (rootState === null) return type(props)
  let inst = rootState.instances.get(type)
  if (inst === undefined) {
    inst = { hooks: [], cursor: 0, pending: [] }
    rootState.instances.set(type, inst)
  }
  inst.cursor = 0
  const previous = activeInst
  activeInst = inst
  try {
    return type(props)
  } finally {
    activeInst = previous
  }
}
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(render)
  if (typeof node === 'object' && node !== null && 'type' in node) {
    const { type, props } = node
    if (typeof type === 'function') return render(renderComponent(type, props ?? {}))
    if (type === Fragment) return render(props?.children ?? null)
    return { tag: String(type), props: props ?? {}, children: render(props?.children ?? null) }
  }
  return String(node)
}
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  if (typeof node === 'object' && 'children' in node) walk(node.children, visit)
}
function byClass(node, className) {
  let found
  walk(node, (element) => {
    if (found !== undefined) return
    const value = element?.props?.className
    if (typeof value === 'string' && value.split(/\s+/).includes(className)) found = element
  })
  return found
}
function allByClass(node, className) {
  const found = []
  walk(node, (element) => {
    const value = element?.props?.className
    if (typeof value === 'string' && value.split(/\s+/).includes(className)) found.push(element)
  })
  return found
}
function allButtons(node) {
  const found = []
  walk(node, (element) => {
    if (element?.tag === 'button') found.push(element)
  })
  return found
}
function buttonByLabel(node, label) {
  return allButtons(node).find((button) => button.props?.['aria-label'] === label)
}
function textOf(node) {
  let text = ''
  walk(node, (element) => {
    if (typeof element === 'string') text += element
  })
  return text
}
const settle = async () => {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve))
  if (rootState === null) return
  // Store updates and effect completions are not subscriptions here: re-render
  // the mounted root, and keep going while an effect/`setState` asked for more.
  for (let pass = 0; pass < 4; pass += 1) {
    renderRoot()
    for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve))
    if (!rootState.dirty) break
  }
}

// ── load the bundle once ───────────────────────────────────────────────────
new Function('window', 'document', source)(globalThis.window, globalThis.document)
check('bundle registers exactly one module', moduleRegistrations.length === 1, String(moduleRegistrations.length))
check('classic-script registration is the first statement', source.startsWith('window.__ModuleLoader__.load({'))
check('factory returns module.exports', source.includes('return module.exports;'))
check('darwin top inset uses the frame clearance token', source.includes('calc(28px + var(--dsh-frame-top-clearance, 0px))'))
const exports_ = moduleRegistrations[0].factory((spec) => {
  if (Object.hasOwn(seeds, spec)) return seeds[spec]
  throw new Error(`unexpected require("${spec}")`)
})

// ═══ PHASE A ═══════════════════════════════════════════════════════════════
const env = makeEnv()
exports_.apply(env.ctx)
const slots = env.slots

check('A: apply installs exactly 2 effects', env.effects.length === 2, env.effects.join(' | '))
check('A: one style tag stamped with the plugin id', styleTags.length === 1 && styleTags[0].dataset.plugin === pkg.name)
// Mirrors the gate in scripts/smoke.mjs (the panel no longer has its own
// create control, so 'newTab' is not required any more; extras are allowed).
const requiredLabels = ['panel', 'empty', 'close', 'handoff']
check(
  'A: one dictionary covering every required label',
  env.dictionaries.length === 1 && requiredLabels.every((key) => key in (env.dictionaries[0]?.dicts.en ?? {})),
  Object.keys(env.dictionaries[0]?.dicts.en ?? {}).join(', '),
)

// Regression guard for the reported crash: `remote.commands` is a REAL Cordis
// sub-service (the gateway mounts each Remote namespace as its own service), and
// resolving an undeclared service path THROWS — `cannot get property
// "remote.commands" without inject`. Probing it lazily through `ctx.get` is not
// a defensive option; the dependency must be declared. This assertion is the
// offline equivalent of that activation failure.
check(
  'A0: the command transport is a DECLARED inject dependency',
  Array.isArray(exports_.inject) &&
    exports_.inject.includes('remote') &&
    exports_.inject.includes('remote.commands'),
  JSON.stringify(exports_.inject),
)

const labelOf = (key) => env.dictionaries[0].dicts.en[key] ?? key
const labelHandoff = labelOf('handoff')
const labelClose = labelOf('close')
const toggleEntry = slots.find('conversation.session.header.utilities')
const rightbarEntry = slots.find('rightbar')
const sessionEntry = slots.find('rightbar.session')
const holeEntry = slots.find('aux-chat.conversation')

check('A1: conversation-header toggle registered', toggleEntry !== undefined)
check('A1: rightbar occupied', rightbarEntry !== undefined)
check('A1: rightbar declares the session-scoped rightbar.session child', rightbarEntry?.options.children?.['rightbar.session']?.scope === 'session')
check('A1: rightbar.session registered and declares the conversation hole', sessionEntry?.options.children?.['aux-chat.conversation']?.scope === 'session')
check('A1: conversation hole registered', holeEntry !== undefined)
check('A1: left sidebar entry is gone', slots.find('sidebar.panellist') === undefined)
check('A1: keyed main panel is gone', slots.find('main') === undefined)
check('A1: rightbar.session is not registered while undeclared', slots.all('rightbar.session').length === 1)

// ── toggle geometry ────────────────────────────────────────────────────────
const toggleProps = { t: (key) => env.dictionaries[0].dicts.en[key] ?? key, sessionId: MAIN }
// Expand the column here, WITHOUT a main session attached yet: this is the one
// toggle state in which the click reports geometry without starting a create
// (the create path is "open my auxiliary chat", and with no attached session
// there is nothing to open). Attaching happens in A3's panel render; A4 then
// drives the explicit create and A7b re-asserts the click-creates behaviour.
const toggleOff = render(toggleEntry.component({ t: toggleProps.t }))
check('A2: toggle renders collapsed by default', toggleOff?.props?.['aria-pressed'] === false, String(toggleOff?.props?.['aria-pressed']))
toggleOff.props.onClick()
check('A2: expanding reports a grid track, not fullscreen', JSON.stringify(env.layoutCalls) === JSON.stringify([{ kind: 'open', track: true, fullscreen: false }]), JSON.stringify(env.layoutCalls))
check('A2: expanding without a main session created nothing', env.commands.length === 0, JSON.stringify(env.commands))

// ── the rightbar occupant ──────────────────────────────────────────────────
const factoryCalls = []
const providerCalls = []
const bodyShares = {
  renderFactorySlot: (name, inputProps, options) => {
    factoryCalls.push({ name, inputProps, options })
    return options?.fallback ?? null
  },
  useSession: (selector) => selector({ running: false, openState: 'open', blank: true, promptAttempted: false, awaitingFirstTurn: false }),
  useConversation: (selector) => selector({ activeTargets: new Set() }),
  useSessions: (selector) => selector(env.sessions.list.getSnapshot()),
  t: (key) => env.dictionaries[0].dicts.en[key] ?? key,
}
const panelShares = {
  width: 720,
  viewportWidth: 1600,
  canShow: true,
  useSessions: (selector) => selector(env.sessions.list.getSnapshot()),
  t: (key) => env.dictionaries[0].dicts.en[key] ?? key,
  SessionProvider: (props) => {
    providerCalls.push(props.session?.sessionId)
    return props.children
  },
  renderSlot: (key, owner) => {
    if (key !== 'rightbar.session') return null
    return sessionEntry.component({
      ...owner,
      t: (k) => env.dictionaries[0].dicts.en[k] ?? k,
      renderSlot: (childKey, childOwner, childOpts) =>
        childKey === 'aux-chat.conversation'
          ? holeEntry.component({ ...childOwner, sessionId: owner.mainSessionId, ...bodyShares })
          : (childOpts?.fallback ?? null),
      SessionProvider: (props) => {
        providerCalls.push(props.session?.sessionId)
        return props.children
      },
    })
  },
}

const tree = render(rightbarEntry.component(panelShares))
check('A3: column root is the right-edge column', byClass(tree, 'auxc-column') !== undefined)
check('A3: column carries the resolved frame width', byClass(tree, 'auxc-column')?.props?.style?.width === 720, JSON.stringify(byClass(tree, 'auxc-column')?.props?.style))
check('A3: main session retained with the frozen source', env.retained.some((entry) => entry.target === MAIN && entry.options.source === RETAIN_SOURCE), JSON.stringify(env.retained))
check('A3: main session bound through SessionProvider', providerCalls.includes(MAIN), JSON.stringify(providerCalls))
check('A3: empty state explains the feature', textOf(tree).includes('No auxiliary sessions yet'), textOf(tree))
// The panel must expose NO create entry of its own: creating an auxiliary
// session is the conversation-header toggle's job (open = focus the current
// main session's auxiliary chat, creating one when it has none). A create
// control inside the panel was judged a DUPLICATED "new session" affordance.
check('A3: no create entry anywhere in the panel', byClass(tree, 'auxc-tabnew') === undefined && byClass(tree, 'auxc-new') === undefined)
check(
  'A3: no button in the panel claims a create label',
  allButtons(tree).every((button) => {
    const label = String(button.props?.['aria-label'] ?? button.props?.title ?? '')
    return !/new|新建|create/i.test(label)
  }),
  JSON.stringify(allButtons(tree).map((b) => b.props?.['aria-label'] ?? b.props?.title)),
)
// The plugin-owned tab strip was the "extra page architecture" the user
// reported: in Path B the host tab IS the session, and in Path A the column
// shows one session at a time. Neither renders a tab list.
check('A3: the panel renders NO internal tab strip', byClass(tree, 'auxc-tabs') === undefined)
const headButtons = allButtons(byClass(tree, 'auxc-head'))
check(
  'A3: the header offers exactly the handoff and close actions',
  headButtons.length === 2 && headButtons.every((button) => [labelHandoff, labelClose].includes(String(button.props?.['aria-label']))),
  JSON.stringify(headButtons.map((button) => button.props?.['aria-label'])),
)

// ── create (driven through the header toggle, the ONLY create path) ────────
// The header control is a TOGGLE, and the panel is open since A2 — so the
// user path to a fresh session is: click (hide) → click (open = focus-or-
// create for the current main session). Driving exactly that path here also
// proves creation cannot happen through anything inside the panel.
render(toggleEntry.component(toggleProps)).props.onClick()
check('A4: the first click only hides the open column', env.layoutCalls[env.layoutCalls.length - 1]?.kind === 'close', JSON.stringify(env.layoutCalls))
check('A4: hiding did not create anything', env.commands.length === 0, JSON.stringify(env.commands.map((entry) => entry.line)))
render(toggleEntry.component(toggleProps)).props.onClick()
check('A4: re-opening reports a grid track again', env.layoutCalls[env.layoutCalls.length - 1]?.track === true, JSON.stringify(env.layoutCalls[env.layoutCalls.length - 1]))
await settle()
const createLine = env.commands.find((entry) => entry.line.startsWith('/aux-chat'))
check('A4: /aux-chat addressed at the main session', createLine?.agentId === MAIN, String(createLine?.agentId))
const createPayload = JSON.parse(createLine.line.slice('/aux-chat '.length))
check('A4: create payload carries sessionId + mirrorOf', createPayload.mirrorOf === MAIN && /^session-/.test(createPayload.sessionId), createLine.line)
const auxId = createPayload.sessionId
check('A4: auxiliary session retained with the frozen source', env.retained.some((entry) => entry.target === auxId && entry.options.source === RETAIN_SOURCE))
check('A4: exactly one auxiliary session was created', env.commands.filter((entry) => entry.line.startsWith('/aux-chat')).length === 1, JSON.stringify(env.commands.length))

const tree2 = render(rightbarEntry.component(panelShares))
check('A4: the header names the shown session', textOf(tree2).includes(auxId.slice(-9)), textOf(tree2))
check('A4: host warnings surfaced', textOf(tree2).includes('1 条镜像警告'), textOf(tree2))
check('A4: auxiliary session bound for the content', providerCalls.includes(auxId), JSON.stringify(providerCalls))
check('A4: conversation hole rendered', factoryCalls.length === 1, JSON.stringify(factoryCalls.map((call) => call.name)))

// ── conversation.content occurrence ────────────────────────────────────────
const call = factoryCalls[0]
check('A5: factory occurrence is embedded', call?.inputProps.variant === 'embedded', String(call?.inputProps.variant))
check('A5: factory occurrence carries a legal phase', ['settling', 'hero', 'active'].includes(call?.inputProps.phase), String(call?.inputProps.phase))
check('A5: factory occurrence carries hero boolean', typeof call?.inputProps.hero === 'boolean')
check('A5: factory selects the local views position', call?.options?.slots?.views !== undefined)
check('A5: factory occurrence has a fallback', call?.options?.fallback !== undefined)
check('A5: placeholder text rendered instead of a blank panel', textOf(tree2).includes('对话界面暂不可用'), textOf(tree2))

// ── phase matrix ───────────────────────────────────────────────────────────
const renderHole = (sessionSnapshot, listState) => {
  factoryCalls.length = 0
  render(holeEntry.component({
    sessionId: auxId,
    ...bodyShares,
    useSession: (selector) => selector(sessionSnapshot),
    useSessions: (selector) => selector(listState),
  }))
  return factoryCalls[0]?.inputProps
}
const blankList = { ids: [auxId], byId: {} }
const settling = renderHole({ running: false, openState: 'loading', blank: true, promptAttempted: false, awaitingFirstTurn: false }, blankList)
check('A6: settling while history opens', settling?.phase === 'settling' && settling.hero === false, JSON.stringify(settling))
const hero = renderHole({ running: false, openState: 'open', blank: true, promptAttempted: false, awaitingFirstTurn: false }, blankList)
check('A6: hero for a blank session whose history is open', hero?.phase === 'hero' && hero.hero === true, JSON.stringify(hero))
const heroViaList = renderHole({ running: false, openState: 'cold', blank: true, promptAttempted: false, awaitingFirstTurn: false }, { ids: [auxId], byId: { [auxId]: { id: auxId, blank: true } } })
check('A6: hero when the catalog already calls the session blank', heroViaList?.phase === 'hero', JSON.stringify(heroViaList))
const active = renderHole({ running: true, openState: 'open', blank: false, promptAttempted: true, awaitingFirstTurn: false }, blankList)
check('A6: active once the auxiliary session is running', active?.phase === 'active' && active.hero === false, JSON.stringify(active))
check('A6: missing factory capability still renders a placeholder', (() => {
  const tree3 = render(holeEntry.component({ sessionId: auxId, ...bodyShares, renderFactorySlot: undefined }))
  return textOf(tree3).includes('对话界面暂不可用')
})())

// ── A7: hiding the column keeps tabs, references and sessions ──────────────
const toggleOn = render(toggleEntry.component(toggleProps))
check('A7: toggle reports expanded', toggleOn?.props?.['aria-pressed'] === true, String(toggleOn?.props?.['aria-pressed']))
check('A7: no "background sessions" dot while expanded', byClass(toggleOn, 'auxc-toggle-dot') === undefined)
toggleOn.props.onClick()
check('A7: collapsing reports a closed rightbar', env.layoutCalls[env.layoutCalls.length - 1]?.kind === 'close', JSON.stringify(env.layoutCalls))
check('A7: hidden column renders nothing', render(rightbarEntry.component(panelShares)) === null)
check('A7: hidden column never released the auxiliary reference', !env.released.includes(auxId), JSON.stringify(env.released))
const toggleDot = render(toggleEntry.component(toggleProps))
check('A7: collapsed toggle shows the live-session dot', byClass(toggleDot, 'auxc-toggle-dot') !== undefined)
check('A7: collapsed toggle names the live count', String(toggleDot?.props?.title).includes('1'), String(toggleDot?.props?.title))
toggleDot.props.onClick()
check('A7: re-expanding reports a grid track again', env.layoutCalls[env.layoutCalls.length - 1]?.track === true, JSON.stringify(env.layoutCalls[env.layoutCalls.length - 1]))
const treeAfter = render(rightbarEntry.component(panelShares))
check('A7: tab survived the hide/show cycle', textOf(treeAfter).includes(auxId.slice(-9)), textOf(treeAfter))
check('A7: same auxiliary reference re-bound, never released', providerCalls.filter((id) => id === auxId).length >= 2 && !env.released.includes(auxId))

// ── A8: handoff ────────────────────────────────────────────────────────────
const handoffButton = buttonByLabel(treeAfter, labelHandoff)
check('A8: handoff action present in the header', handoffButton !== undefined)
handoffButton.props.onClick()
await settle()
check('A8: handoff wrote the conclusion into the main composer', env.drafts.length === 1 && env.drafts[0].text === CONCLUSION, JSON.stringify(env.drafts))
check('A8: handoff targeted the main agent scope', env.drafts[0]?.actx?.__agentScope === MAIN, JSON.stringify(env.drafts[0]?.actx))

// ── A9: the column's close control ends the session and collapses ─────────
const closeButton = buttonByLabel(treeAfter, labelClose)
check('A9: close action present in the header', closeButton !== undefined)
closeButton.props.onClick()
await settle()
check('A9: close released the auxiliary reference', env.released.includes(auxId), JSON.stringify(env.released))
const endLine = env.commands.find((entry) => entry.line.startsWith('/aux-end'))
check('A9: /aux-end addressed at the auxiliary session', endLine?.agentId === auxId, String(endLine?.agentId))
check('A9: /aux-end payload is the auxiliary id', JSON.parse(endLine.line.slice('/aux-end '.length)).sessionId === auxId)
check('A9: close collapsed the column', env.layoutCalls[env.layoutCalls.length - 1]?.kind === 'close', JSON.stringify(env.layoutCalls[env.layoutCalls.length - 1]))
check('A9: the ended column renders nothing', render(rightbarEntry.component(panelShares)) === null)
check('A9: still no internal tab strip or create button', byClass(tree, 'auxc-tabs') === undefined && byClass(tree, 'auxc-tabnew') === undefined)

// ── A7b: the toggle's click path opens a WORKING session ───────────────────
// Regression: the first click must not leave the user staring at an empty
// column, and a later click must not silently create a second session.
const freshEnv = makeEnv()
exports_.apply(freshEnv.ctx)
const freshSlots = freshEnv.slots
const freshRightbar = freshSlots.find('rightbar')
const freshToggle = freshSlots.find('conversation.session.header.utilities')
const freshToggleProps = { t: (key) => freshEnv.dictionaries[0].dicts.en[key] ?? key, sessionId: MAIN }
const freshOff = render(freshToggle.component(freshToggleProps))
check('A7b: a fresh environment starts collapsed with no tabs', freshOff?.props?.['aria-pressed'] === false)
freshOff.props.onClick()
check('A7b: opening reports a grid track immediately', freshEnv.layoutCalls[freshEnv.layoutCalls.length - 1]?.track === true, JSON.stringify(freshEnv.layoutCalls))
check('A7b: opening with no tab creates one', freshEnv.commands.filter((entry) => entry.line.startsWith('/aux-chat')).length === 1, JSON.stringify(freshEnv.commands.map((entry) => entry.line)))
await settle()
const freshCreate = freshEnv.commands.find((entry) => entry.line.startsWith('/aux-chat'))
check('A7b: the auto-created session mirrors the CURRENT main session', JSON.parse(freshCreate.line.slice('/aux-chat '.length)).mirrorOf === MAIN, freshCreate.line)
const freshTree = render(freshRightbar.component({ ...panelShares, useSessions: (selector) => selector(freshEnv.sessions.list.getSnapshot()) }))
const freshAuxId = JSON.parse(freshCreate.line.slice('/aux-chat '.length)).sessionId
check('A7b: the auto-created session is named in the header', textOf(freshTree).includes(freshAuxId.slice(-9)), textOf(freshTree))
check('A7b: the column still renders no tab strip', byClass(freshTree, 'auxc-tabs') === undefined)
// Second click: an existing session must be re-activated, never duplicated.
const freshOn = render(freshToggle.component(freshToggleProps))
freshOn.props.onClick()
await settle()
check('A7b: collapsing hides the column instead of creating', freshEnv.layoutCalls[freshEnv.layoutCalls.length - 1]?.kind === 'close', JSON.stringify(freshEnv.layoutCalls[freshEnv.layoutCalls.length - 1]))
check('A7b: collapsing created nothing', freshEnv.commands.filter((entry) => entry.line.startsWith('/aux-chat')).length === 1)
const freshDot = render(freshToggle.component(freshToggleProps))
freshDot.props.onClick()
await settle()
check('A7b: re-opening reuses the existing session (no second create)', freshEnv.commands.filter((entry) => entry.line.startsWith('/aux-chat')).length === 1, String(freshEnv.commands.filter((entry) => entry.line.startsWith('/aux-chat')).length))
check('A7b: re-opening reports a grid track', freshEnv.layoutCalls[freshEnv.layoutCalls.length - 1]?.track === true)

// ── A8b: clipboard fallback ───────────────────────────────────────────────
// Its OWN environment: `apply()` republishes the module-level controller
// singleton, so click-driven scenarios must not share an environment with
// assertions that render another environment's trees.
const clipboardEnv = makeEnv({ conversationAvailable: false })
exports_.apply(clipboardEnv.ctx)
const clipboardToggle = clipboardEnv.slots.find('conversation.session.header.utilities')
render(clipboardToggle.component({ t: (key) => clipboardEnv.dictionaries[0].dicts.en[key] ?? key })).props.onClick()
const clipboardRightbar = clipboardEnv.slots.find('rightbar')
const clipboardSession = clipboardEnv.slots.find('rightbar.session')
const clipboardHole = clipboardEnv.slots.find('aux-chat.conversation')
const clipboardPanel = {
  ...panelShares,
  useSessions: (selector) => selector(clipboardEnv.sessions.list.getSnapshot()),
  renderSlot: (key, owner) =>
    clipboardSession.component({
      ...owner,
      t: (k) => clipboardEnv.dictionaries[0].dicts.en[k] ?? k,
      SessionProvider: (props) => props.children,
      renderSlot: (childKey, childOwner, childOpts) =>
        childKey === 'aux-chat.conversation'
          ? clipboardHole.component({ ...childOwner, sessionId: owner.mainSessionId, ...bodyShares })
          : (childOpts?.fallback ?? null),
    }),
}
const clipboardToggle2 = clipboardEnv.slots.find('conversation.session.header.utilities')
const clipboardClick = () => render(clipboardToggle2.component({ t: (key) => clipboardEnv.dictionaries[0].dicts.en[key] ?? key, sessionId: MAIN })).props.onClick()
render(clipboardRightbar.component(clipboardPanel))
clipboardClick()   // shown → hide
clipboardClick()   // hidden → open = focus-or-create
await settle()
clipboardAvailable = true
const clipboardTree2 = render(clipboardRightbar.component(clipboardPanel))
buttonByLabel(clipboardTree2, clipboardEnv.dictionaries[0].dicts.en.handoff).props.onClick()
await settle()
clipboardAvailable = false
check('A8: handoff falls back to the clipboard without the input machine', clipboardEnv.drafts.length === 0 && textOf(render(clipboardRightbar.component(clipboardPanel))).includes('剪贴板'), textOf(render(clipboardRightbar.component(clipboardPanel))))

// ── A10: page unload ───────────────────────────────────────────────────────
let unload
const unloadWindow = globalThis.window.addEventListener
globalThis.window.addEventListener = (type, listener) => {
  if (type === 'beforeunload') unload = listener
  return unloadWindow(type, listener)
}
const unloadEnv = makeEnv()
exports_.apply(unloadEnv.ctx)
render(unloadEnv.slots.find('conversation.session.header.utilities').component({ t: (key) => unloadEnv.dictionaries[0].dicts.en[key] ?? key })).props.onClick()
const unloadRightbar = unloadEnv.slots.find('rightbar')
const unloadToggle = unloadEnv.slots.find('conversation.session.header.utilities')
const unloadClick = () => render(unloadToggle.component({ t: (key) => unloadEnv.dictionaries[0].dicts.en[key] ?? key, sessionId: MAIN })).props.onClick()
render(unloadRightbar.component({ ...panelShares, useSessions: (selector) => selector(unloadEnv.sessions.list.getSnapshot()), renderSlot: () => null }))
unloadClick()   // shown by the setup click above → hide
unloadClick()   // hidden → open = focus-or-create
await settle()
await settle()
const beforeUnloadCount = unloadEnv.commands.filter((entry) => entry.line.startsWith('/aux-end')).length
unload()
await settle()
check('A10: beforeunload sends /aux-end for every open tab', unloadEnv.commands.filter((entry) => entry.line.startsWith('/aux-end')).length === beforeUnloadCount + 1, String(unloadEnv.commands.length))
globalThis.window.addEventListener = unloadWindow

// ═══ PHASE B ═══════════════════════════════════════════════════════════════
const officialEnv = makeEnv({ official: true })
exports_.apply(officialEnv.ctx)
check('B: no rightbar occupation alongside the official right Sidebar', officialEnv.slots.find('rightbar') === undefined)
check('B: official tab type registered once', officialEnv.registeredTypes.length === 1, String(officialEnv.registeredTypes.length))
const definition = officialEnv.registeredTypes[0]
check('B: type id is the package name', definition?.id === pkg.name, String(definition?.id))
check('B: type kind is aux-chat', definition?.kind === 'aux-chat', String(definition?.kind))
check('B: type registers in the extension band', definition?.priority === 'extension', String(definition?.priority))
check('B: type opens one page per open', definition?.multiple === true)
check('B: type offers a guide entry', Array.isArray(definition?.guide) && definition.guide.length === 1)
check('B: type keeps a visited body mounted', definition?.keepMounted === true)
check('B: chip-title seat registered under the same key', officialEnv.slots.find('sidebar.right.pane.tab.title')?.options?.key === pkg.name)
check('B: pane body registered under the same key', officialEnv.slots.find('sidebar.right.pane.tab')?.options?.key === pkg.name)
check('B: pane body declares the conversation hole', officialEnv.slots.find('sidebar.right.pane.tab')?.options?.children?.['aux-chat.conversation']?.scope === 'session')
check('B: conversation hole registered through the official seat', officialEnv.slots.find('aux-chat.conversation') !== undefined)
check('B: header toggle is not duplicated', (() => {
  const registrations = officialEnv.slots.all('conversation.session.header.utilities')
  return registrations.length === 0
})(), String(officialEnv.slots.all('conversation.session.header.utilities').length))

// ═══ PHASE B2: one host tab = one auxiliary session ═══════════════════════
// The user's report was "opening an auxiliary tab shows only an empty state and
// nothing can ever be created". The model that fixes it: the body OWNS its
// tab's session — create on mount, reuse for the tab's whole life, destroy when
// the tab record's own signal aborts. One root is mounted at a time, so every
// handle is used before the next `mountRoot`.
const paneEntry = officialEnv.slots.find('sidebar.right.pane.tab')
const paneTitleEntry = officialEnv.slots.find('sidebar.right.pane.tab.title')
const holeForOfficial = officialEnv.slots.find('aux-chat.conversation')
const officialLabel = (key) => officialEnv.dictionaries[0].dicts.en[key] ?? key
const createLines = () => officialEnv.commands.filter((entry) => entry.line.startsWith('/aux-chat'))
const endLines = () => officialEnv.commands.filter((entry) => entry.line.startsWith('/aux-end'))
const payloadOf = (line) => JSON.parse(line.slice(line.indexOf(' ') + 1))
const auxIdOf = (line) => payloadOf(line).sessionId

const tabInfoFor = (controller) => ({
  sidebar: { expanded: true, fullscreen: false },
  panel: { id: 'pane-1' },
  tab: { signal: controller.signal, visible: true },
})
const officialBody = {
  ...bodyShares,
  useSessions: (selector) => selector(officialEnv.sessions.list.getSnapshot()),
  t: officialLabel,
}
function paneProps(controller, mainSessionId) {
  return {
    sessionId: mainSessionId,
    useTabInfo: () => tabInfoFor(controller),
    t: officialLabel,
    SessionProvider: (props) => props.children,
    renderSlot: (key, owner, options) =>
      key === 'aux-chat.conversation'
        ? holeForOfficial.component({
            ...owner,
            sessionId: createLines().length === 0 ? undefined : auxIdOf(createLines()[createLines().length - 1].line),
            ...officialBody,
          })
        : (options?.fallback ?? null),
  }
}

// B2a — mount creates exactly one session, mirroring the current main session.
const firstTab = new AbortController()
const firstRoot = mountRoot(paneEntry.component, paneProps(firstTab, MAIN))
await settle()
check('B2: mounting the pane creates one auxiliary session', createLines().length === 1, JSON.stringify(officialEnv.commands.map((entry) => entry.line)))
check('B2: the created session mirrors the CURRENT main session', payloadOf(createLines()[0].line).mirrorOf === MAIN, createLines()[0].line)
const firstAuxId = auxIdOf(createLines()[0].line)
check('B2: the body renders NO internal tab strip', byClass(firstRoot.tree, 'auxc-tabs') === undefined)
check('B2: the body renders no in-panel title row', byClass(firstRoot.tree, 'auxc-head') === undefined)
check('B2: the conversation hole is rendered for the new session', byClass(firstRoot.tree, 'auxc-conv') !== undefined, textOf(firstRoot.tree).slice(0, 160))
check('B2: the session is not shown as a failure or a wait', byClass(firstRoot.tree, 'auxc-wait') === undefined && byClass(firstRoot.tree, 'auxc-retry') === undefined)
check('B2: the session was retained with the frozen source', officialEnv.retained.some((entry) => entry.target === firstAuxId && entry.options.source === RETAIN_SOURCE))

// B2b — the bound Session may change under a kept-mounted body: it must NOT
// create a second session for the same tab.
firstRoot.setProps({ sessionId: 'session-main-0002' })
await settle()
check('B2: a Session switch creates nothing', createLines().length === 1, JSON.stringify(createLines().map((entry) => entry.line)))
check('B2: a Session switch keeps the same session rendered', byClass(firstRoot.tree, 'auxc-conv') !== undefined)

// B2c — the tab record disappearing is the destroy edge.
firstTab.abort()
await settle()
check('B2: aborting the tab sends /aux-end for its session', endLines().length === 1 && endLines()[0].agentId === firstAuxId, JSON.stringify(endLines()))
check('B2: aborting released the reference', officialEnv.released.includes(firstAuxId), JSON.stringify(officialEnv.released))
unmountRoot()

// B2d — a pane rendered while no Session is on screen must explain itself, not
// spin in the creating state forever; the Session arriving then creates once.
const noSessionTab = new AbortController()
const noSessionRoot = mountRoot(paneEntry.component, paneProps(noSessionTab, undefined))
await settle()
check('B2: no Session yet explains itself instead of spinning', textOf(noSessionRoot.tree).includes('还没有可镜像的主会话'), textOf(noSessionRoot.tree).slice(0, 160))
check('B2: no Session yet creates nothing', createLines().length === 1, String(createLines().length))
check('B2: no Session yet shows no wait spinner', byClass(noSessionRoot.tree, 'auxc-wait') === undefined)
noSessionRoot.setProps({ sessionId: MAIN })
await settle()
check('B2: the Session arriving creates exactly one session', createLines().length === 2, JSON.stringify(createLines().map((entry) => entry.line)))
check('B2: the arriving Session renders its conversation', byClass(noSessionRoot.tree, 'auxc-conv') !== undefined)
noSessionTab.abort()
await settle()
unmountRoot()

// B2e — a second tab is a second session, and remounting reuses it.
const secondTab = new AbortController()
mountRoot(paneEntry.component, paneProps(secondTab, MAIN))
await settle()
check('B2: a second tab creates its own session', createLines().length === 3, String(createLines().length))
const secondAuxId = auxIdOf(createLines()[2].line)
const secondTitle = render(paneTitleEntry.component({ useTabInfo: () => tabInfoFor(secondTab), t: officialLabel }))
check('B2: the chip title names its own session', textOf(secondTitle).includes(secondAuxId.slice(-9)), textOf(secondTitle))
unmountRoot()
const remount = mountRoot(paneEntry.component, paneProps(secondTab, MAIN))
await settle()
check('B2: remounting the same tab reuses its session', createLines().length === 3, JSON.stringify(createLines().map((entry) => entry.line)))
check('B2: the remount still renders the conversation', byClass(remount.tree, 'auxc-conv') !== undefined)

// B2f — a failed create must not be a dead end.
officialEnv.setFailCreate(true)
const thirdTab = new AbortController()
const failRoot = mountRoot(paneEntry.component, paneProps(thirdTab, MAIN))
await settle()
officialEnv.setFailCreate(false)
check('B2: a failed create shows the host reason', textOf(failRoot.tree).includes('创建辅助会话失败'), textOf(failRoot.tree))
const retryButton = byClass(failRoot.tree, 'auxc-retry')
check('B2: a failed create offers a retry button', retryButton !== undefined)
check('B2: a failed create renders no conversation yet', byClass(failRoot.tree, 'auxc-conv') === undefined)
const createsBeforeRetry = createLines().length
retryButton.props.onClick()
await settle()
check('B2: retry starts exactly one new attempt', createLines().length === createsBeforeRetry + 1, String(createLines().length))
check('B2: retry succeeds and renders the conversation', byClass(failRoot.tree, 'auxc-conv') !== undefined && byClass(failRoot.tree, 'auxc-retry') === undefined)

// B2g — destroying one tab leaves the others alone.
const thirdAuxId = auxIdOf(createLines()[createLines().length - 1].line)
thirdTab.abort()
await settle()
check('B2: aborting the third tab destroys only its own session', endLines().some((entry) => entry.agentId === thirdAuxId), JSON.stringify(endLines()))
check('B2: the other tab keeps its session', !endLines().some((entry) => entry.agentId === secondAuxId), JSON.stringify(endLines()))
secondTab.abort()
await settle()
// firstTab, noSessionTab, thirdTab, secondTab — four tabs, four destroys.
check('B2: closing the last tab leaves no session alive', endLines().length === 4, JSON.stringify(endLines()))
unmountRoot()

// ═══ PHASE C ═══════════════════════════════════════════════════════════════
const latchEnv = makeEnv({ lateOfficial: true })
exports_.apply(latchEnv.ctx)
check('C: path A installed while the official package is absent', latchEnv.slots.find('rightbar') !== undefined)
check('C: the late-arrival latch was armed', typeof latchEnv.ctx.__latch?.callback === 'function')
latchEnv.setOfficial(true)
latchEnv.ctx.__latch.callback()
check('C: owned column torn down once the official package arrives', latchEnv.slots.find('rightbar') === undefined)
check('C: path A conversation hole torn down with its declaration', latchEnv.slots.find('aux-chat.conversation') === undefined)
check('C: official type registered through the latch', latchEnv.registeredTypes.length === 1)
// The official package declares its own pane seat in its apply; this plugin
// must wait for that declaration instead of assuming the load order.
check('C: pane body waits for the official seat to be declared', latchEnv.slots.find('sidebar.right.pane.tab') === undefined)
latchEnv.slots.declareKey('sidebar.right.pane.tab')
check('C: official pane body installed once the seat exists', latchEnv.slots.find('sidebar.right.pane.tab')?.options?.key === pkg.name)
check('C: conversation hole re-registered under the official seat', latchEnv.slots.find('aux-chat.conversation') !== undefined)

// ── report ─────────────────────────────────────────────────────────────────
for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.label}`)
const requiredSeeds = [...new Set(['react', 'react/jsx-runtime'])]
console.log(
  [
    '',
    `selfcheck: ${failures.length === 0 ? 'OK' : 'FAILED'} (${checks.length - failures.length}/${checks.length})`,
    `  requires      : ${requiredSeeds.join(', ')} (all platform seeds)`,
    `  path A seats  : ${slots.entries.map((entry) => entry.options.name).join(', ')}`,
    `  path B seats  : ${officialEnv.slots.entries.map((entry) => entry.options.name).join(', ')}`,
  ].join('\n'),
)
if (failures.length > 0) {
  console.error('\nfailures:\n  - ' + failures.join('\n  - '))
  process.exit(1)
}
