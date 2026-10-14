#!/usr/bin/env node
/**
 * Offline smoke test for the built client bundle. It reproduces the parts of the
 * browser contract the bundle depends on — the `__ModuleLoader__` registration
 * facade, a `document` with head/style, and the platform seed table — then
 * materializes the factory and calls `apply` with a stand-in client context.
 *
 * This does NOT prove the panel renders; it proves the bundle registers, its
 * factory runs, it requires only legal seed words, and `apply` contributes the
 * slots/locale entries it claims to.
 * @module scripts/smoke
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Registrations submitted through the facade, in order. */
const registrations = []
/** `<style>` tags the bundle injected. */
const styles = []

// ── platform seed table (the shell's frozen static module table) ─────────────
const React = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  createElement: (type, props, ...children) => ({ type, props, children }),
}
const seeds = {
  react: React,
  'react/jsx-runtime': {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: Symbol.for('react.fragment'),
  },
  'react-dom': {},
  'react-dom/client': {},
  '@deepseek-ai/cordis': {},
  '@deepseek-ai/dsh-client-store': {},
  '@deepseek-ai/dsh-client-ui-slots': { resolveSlotLabel: () => undefined },
  '@deepseek-ai/dsh-client-ui-primitives': {},
  '@deepseek-ai/dsh-client-ui-dockkit': {},
}

const required = []
const require_ = (spec) => {
  required.push(spec)
  if (Object.hasOwn(seeds, spec)) return seeds[spec]
  throw new Error(
    `client-modules: require("${spec}") missed the module table — not a platform seed word, ` +
      'and this package declares no dsh.client.external row for it',
  )
}

globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: (tag) => styles.push(tag) },
}

// ── run the bundle ──────────────────────────────────────────────────────────
const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
new Function('window', 'document', source)(globalThis.window, globalThis.document)

const assert = (condition, message) => {
  if (!condition) throw new Error(`smoke: ${message}`)
}

assert(registrations.length === 1, `expected 1 registration, got ${String(registrations.length)}`)
const [registration] = registrations
assert(registration.id === pkg.name, `registration id ${registration.id} !== package name ${pkg.name}`)
assert(typeof registration.factory === 'function', 'registration carries no factory')
assert(registration.chunk === undefined, 'entry registration must not carry a chunk name')

const exports_ = registration.factory(require_)
assert(typeof exports_.apply === 'function', 'bundle does not export apply')
assert(Array.isArray(exports_.inject), 'bundle does not export an inject array')

// ── exercise apply against a recording context ──────────────────────────────
const effects = []
const registered = []
const injected = []
const dictionaries = []
const ctx = {
  effect: (setup, label) => {
    effects.push(label)
    setup()
  },
  locale: {
    register: (ns, dicts) => {
      dictionaries.push({ ns, keys: Object.keys(dicts.en) })
      return () => {}
    },
  },
  slots: {
    inject: (key, callback) => {
      injected.push(key)
      callback()
      return () => {}
    },
    register: (options) => {
      registered.push(options)
      return () => {}
    },
  },
}
exports_.apply(ctx)

// Effects: dictionaries, controller, seats (+ hidden command rows), close
// handler, shortcut, /side command. The exact count is a structural fact of
// the wiring; assert the label set so a dropped effect is caught.
const expectedEffects = [
  'aux-chat: registry + dictionaries',
  'aux-chat: controller',
  'aux-chat: seats',
  'aux-chat: close handler',
  'aux-chat: shortcut',
  'aux-chat: /side command',
]
for (const label of expectedEffects) {
  assert(effects.includes(label), `effect "${label}" was not registered (got: ${effects.join(', ')})`)
}
assert(styles.length === 1, `expected 1 injected <style>, got ${String(styles.length)}`)
assert(styles[0].dataset.plugin === pkg.name, 'style tag is not tagged with the plugin id')
// The dictionary must cover every label the panel renders. An exact count would
// turn each new label into a build failure for no gain, so the gate is the label
// set the UI actually translates.
const shipped = dictionaries[0]?.keys ?? []
assert(dictionaries.length === 1, 'dictionary registration is incomplete')
assert(
  ['panel', 'empty', 'close', 'handoff'].every((key) => shipped.includes(key)),
  `dictionary is missing required labels; got ${shipped.join(', ')}`,
)

// The plugin is a conversation-scoped RIGHT COLUMN: it must occupy the frame's
// rightbar seat and offer its control in the conversation header, and it must
// NOT occupy the left sidebar list or the keyed main panel any more.
const sidebarRow = registered.find((row) => row.name === 'sidebar.panellist')
const panel = registered.find((row) => row.name === 'main')
assert(sidebarRow === undefined, 'sidebar.panellist must no longer be occupied')
assert(panel === undefined, 'main must no longer be occupied')
const rightbar = registered.find((row) => row.name === 'rightbar')
const headerToggle = registered.find((row) => row.name === 'conversation.session.header.utilities')
assert(rightbar !== undefined, 'no rightbar registration')
assert(headerToggle !== undefined, 'no conversation.session.header.utilities registration')
assert(
  rightbar.children?.['rightbar.session']?.scope === 'session',
  'rightbar must declare its session-scoped rightbar.session child',
)
assert(
  registered.some((row) => row.name === 'aux-chat.conversation'),
  'the plugin conversation hole is not registered',
)
// The internal command rows must render to nothing in every transcript.
for (const command of ['aux-init', 'aux-end']) {
  assert(
    registered.some((row) => row.name === 'conversation.chat.commandview' && row.key === command),
    `hidden commandview row for /${command} is not registered`,
  )
}

const externalRequests = required.filter((spec) => !Object.hasOwn(seeds, spec))
assert(
  externalRequests.length === 0,
  `bundle required non-seed modules without declaring them: ${externalRequests.join(', ')}`,
)

console.log(
  [
    'smoke: OK',
    `  registration id : ${registration.id}`,
    `  exports         : ${Object.keys(exports_).sort().join(', ')}`,
    `  inject          : ${exports_.inject.join(', ')}`,
    `  seed requires   : ${[...new Set(required)].join(', ')}`,
    `  slots injected  : ${injected.join(', ')}`,
    `  rightbar seat   : ${rightbar.name} (children ${Object.keys(rightbar.children ?? {}).join(', ')})`,
    `  header toggle   : ${headerToggle.name} (id ${headerToggle.id}, order ${String(headerToggle.order)}, ns ${headerToggle.locale})`,
  ].join('\n'),
)
