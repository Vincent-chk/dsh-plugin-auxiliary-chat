/**
 * Copy governance gates (refactor plan v2, P0/WP0.2 + WP0.3).
 *
 * runCopyChecks  — G1/G2/G3: no Han characters outside the central dictionary
 *                  (comments and model-facing prompt builders allowlisted),
 *                  zh/en key parity, zero pre-close risk clauses.
 * runCopyTruthChecks — G4: every remaining state surface's copy keys exist AND
 *                  a test file carries a `copy-truth: <keys>` marker proving
 *                  the behaviour the copy describes; plus silent-close API
 *                  shape assertions (no confirmation component left).
 *
 * @module scripts/lib/copy-gates
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const HAN = /[一-龥]/

/** Files whose Han literals are NOT user-facing UI copy. */
const ALLOWLIST = new Set([
  'src/locale.ts', // the dictionary itself
  'src/contract.ts', // frozen identity constants ([辅助] prefix)
  'src/host/mirror.ts', // model-facing prompt text (injected, never rendered)
  'src/host/create.ts', // model-facing boundary instruction text
])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      if (entry === '__selfcheck__' || entry === 'node_modules') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** Strip block and line comments so prose never trips the gate. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, '$1')
}

export function runCopyChecks(root) {
  const results = []
  const violations = []
  for (const file of walk(join(root, 'src'))) {
    const rel = file.slice(root.length + 1).split('\\').join('/')
    if (ALLOWLIST.has(rel)) continue
    const source = stripComments(readFileSync(file, 'utf8'))
    for (const [index, line] of source.split('\n').entries()) {
      if (HAN.test(line)) violations.push(`${rel}:${String(index + 1)}: ${line.trim().slice(0, 60)}`)
    }
  }
  results.push({
    ok: violations.length === 0,
    message: `copy-check: no Han UI copy outside the dictionary (${violations.length} violation${violations.length === 1 ? '' : 's'})${violations.length === 0 ? '' : ` — ${violations.slice(0, 4).join(' | ')}`}`,
  })

  const locale = readFileSync(join(root, 'src/locale.ts'), 'utf8')
  const dicts = loadDictionaries(join(root, 'src/locale.ts'))
  const zhKeys = [...dicts.zh.keys()]
  const zhSet = new Set(dicts.zh.keys())
  const enSet = new Set(dicts.en.keys())
  const missingEn = [...zhSet].filter((k) => !enSet.has(k))
  const missingZh = [...enSet].filter((k) => !zhSet.has(k))
  results.push({
    ok: missingEn.length === 0 && missingZh.length === 0 && zhKeys.length > 0,
    message: `copy-check: zh/en key parity (zh=${String(zhSet.size)} en=${String(enSet.size)} missingEn=${missingEn.join(',') || 'none'} missingZh=${missingZh.join(',') || 'none'})`,
  })

  const risk = /永久删除|无法恢复|永久销毁|将被丢弃/
  const risky = [...dicts.zh.entries()].filter(([, value]) => risk.test(value)).map(([key]) => key)
  results.push({
    ok: risky.length === 0,
    message: `copy-check: zero pre-close risk clauses in the dictionary (${risky.join(',') || 'none'})`,
  })
  return results
}

/** Parse the flat dictionaries textually (they are single-line values). */
function loadDictionaries(spec) {
  const source = readFileSync(spec, 'utf8')
  const parse = (name) => {
    const start = source.indexOf(`export const ${name}: Record<string, string> = {`)
    const end = source.indexOf('\n}', start)
    const body = source.slice(start, end)
    const entries = new Map()
    for (const m of body.matchAll(/\n {2}(\w+): '((?:[^'\\]|\\.)*)',/g)) entries.set(m[1], m[2])
    return entries
  }
  return { zh: parse('zh'), en: parse('en') }
}

/** Six state surfaces: copy keys ↔ the test that proves the behaviour. */
const SURFACES = [
  { surface: 'creating', keys: ['preparingTitle', 'preparingBody'], proof: 'src/client/__selfcheck__/race-check.mjs' },
  { surface: 'closing', keys: ['closingTitle', 'closingBody', 'closingBodyLong'], proof: 'src/client/__selfcheck__/race-check.mjs' },
  { surface: 'closeFailed', keys: ['closeFailedTitle', 'closeFailedBody', 'retryClose'], proof: 'src/client/__selfcheck__/race-check.mjs' },
  { surface: 'ended', keys: ['endedTitle', 'endedDefault'], proof: 'src/client/__selfcheck__/race-check.mjs' },
  { surface: 'inheritance-bar', keys: ['inhFull', 'inhWindow', 'inhSummary', 'inhOff', 'inhEmpty'], proof: 'src/host/__selfcheck__/mirror-window-check.mjs' },
  { surface: 'handoff', keys: ['handoffDrafted', 'handoffNotify', 'handoffClipboard'], proof: '../tools/visual/scenarios/core-journey.mjs' },
]

export function runCopyTruthChecks(root) {
  const results = []
  const locale = readFileSync(join(root, 'src/locale.ts'), 'utf8')
  for (const surface of SURFACES) {
    const keysPresent = surface.keys.every((key) => new RegExp(`\\n {2}${key}: '`, 'm').test(locale))
    const proofPath = join(root, surface.proof)
    let markerFound = false
    try {
      const proof = readFileSync(proofPath, 'utf8')
      markerFound = proof.includes(`copy-truth: ${surface.keys.join(' ')}`) || proof.includes(`copy-truth: ${surface.surface}`)
    } catch {
      markerFound = false
    }
    results.push({
      ok: keysPresent && markerFound,
      message: `copy-truth: surface "${surface.surface}" keys present + behaviour proof marker (${keysPresent ? 'keys ok' : 'KEYS MISSING'}; ${markerFound ? 'proof ok' : 'PROOF MARKER MISSING'})`,
    })
  }

  const clientSources = walk(join(root, 'src/client'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
  const confirmGone =
    !clientSources.includes('ConfirmInline') &&
    !clientSources.includes('alertdialog') &&
    !clientSources.includes('skip-close-confirm') &&
    !clientSources.includes('closeNeedsConfirmation')
  results.push({
    ok: confirmGone,
    message: 'copy-truth: confirmation component / preference / branching fully removed from the client half',
  })

  const store = readFileSync(join(root, 'src/client/store.ts'), 'utf8')
  results.push({
    ok: store.includes('async startClose(') && store.includes('indicators()'),
    message: 'copy-truth: silent close protocol (startClose) and single-source indicators() present in the controller',
  })
  return results
}
