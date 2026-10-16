#!/usr/bin/env node
/**
 * LIVE offline gate for the HideChannel abstraction (plan v2 P2/WP2.2,
 * AC-C-09): channel resolution order, native-hide without archiving, and the
 * archive fallback when the native face is absent or refuses.
 *
 * Run: npm run hide-check
 * @module host/__selfcheck__/hide-channel-check
 */
import { resolveHideChannel, hideThroughChannel } from '../hide.ts'

const checks = []
const failures = []
const check = (ok, label, detail) => {
  checks.push({ ok, label })
  if (!ok) failures.push(`FAIL ${label}${detail === undefined ? '' : `  [${detail}]`}`)
}

const mkDeps = (config, face) => ({
  hideChannel: config,
  trace: () => {},
  owned: new Set(),
  ctx: {
    get: (name) => {
      if (name !== 'sessionVisibility') return undefined
      if (face === 'throw') throw new Error('no visibility face on this host')
      return face
    },
  },
})
const archive = async (_deps, id) => {
  archive.calls.push(id)
}
archive.calls = []

const none = resolveHideChannel(mkDeps('auto', undefined))
check(none.kind === 'archive-bridge', 'H1 auto without a native face falls back to the archive bridge', none.kind)
const face = { hidden: [], hideFromLists: (id) => { face.hidden.push(id) } }
const native = resolveHideChannel(mkDeps('auto', face))
check(native.kind === 'native' && native.face === face, 'H2 auto with a native face resolves native', native.kind)
const forced = resolveHideChannel(mkDeps('archive', face))
check(forced.kind === 'archive-bridge', 'H3 config=archive overrides an available native face', forced.kind)
const missing = resolveHideChannel(mkDeps('native', 'throw'))
check(missing.kind === 'archive-bridge', 'H4 config=native without a face degrades to the bridge', missing.kind)

await hideThroughChannel(mkDeps('auto', face), native, 'sess-1', [], archive)
check(face.hidden.includes('sess-1') && archive.calls.length === 0, 'H5 native channel hides without archiving', JSON.stringify(archive.calls))

const warnings = []
await hideThroughChannel(
  mkDeps('auto', face),
  { kind: 'native', face: { hideFromLists: () => { throw new Error('refused') } } },
  'sess-2',
  warnings,
  archive,
)
check(archive.calls.includes('sess-2') && warnings.length === 1, 'H6 a failing native hide falls back to archive with a warning', JSON.stringify(warnings))

await hideThroughChannel(mkDeps('auto', undefined), none, 'sess-3', [], archive)
check(archive.calls.includes('sess-3'), 'H7 bridge channel archives as before', JSON.stringify(archive.calls))

const passed = checks.filter((c) => c.ok).length
console.log(`hide-channel: ${passed}/${checks.length} checks passed`)
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
