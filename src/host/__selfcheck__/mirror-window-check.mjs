/**
 * Reference-history window self-check.
 *
 * `buildFullTranscript` renders the main session's committed transcript for the
 * hidden form-A injection. Before 2026-10-14 it was all-or-nothing: the first
 * entry that would exceed `mirrorMaxChars` returned `undefined`, so a long main
 * session handed the side chat NOTHING (observed live: a 2.6 MB parent, and the
 * auxiliary session's prompt carried no main-session content at all).
 *
 * It now delivers a contiguous NEWEST tail plus exact accounting. This check
 * drives the real function with a fake session so that behaviour stays pinned.
 *
 * Usage: node --experimental-transform-types src/host/__selfcheck__/mirror-window-check.mjs
 */
import { MAX_INHERIT_TOOL_CHARS, buildFullTranscript } from '../mirror.ts'

// copy-truth: inhFull inhWindow inhSummary inhOff inhEmpty
const passes = []
const failures = []
const check = (ok, label) => (ok ? passes.push(label) : failures.push(`FAIL ${label}`))

/** Build a fake session whose events derive to plain text messages. */
function fakeSession(entries) {
  const events = entries.map((entry) => ({
    type: entry.type ?? 'user/message',
    data:
      entry.type === 'tool/result'
        ? { source: { kind: 'user' }, text: entry.text }
        : { source: { kind: entry.kind ?? 'user' }, text: entry.text },
  }))
  return {
    surface: { nodes: events.map((_, index) => index) },
    snapshotEvents: () => events,
    deriveEventMessage: (event) => ({
      content: [{ type: 'text', text: String(event.data?.text ?? '') }],
    }),
  }
}

const traced = []
const trace = (line) => traced.push(line)
const textOf = (entry) => entry.text

// ── W01: under budget keeps everything, no header noise ────────────────────
{
  traced.length = 0
  const session = fakeSession([
    { text: 'first fact' },
    { text: 'second fact' },
    { text: 'third fact' },
  ])
  const window = buildFullTranscript(session, 10_000, trace)
  check(window !== undefined, 'W01 under budget yields a window')
  check(window?.entries === 3, `W01 all three entries delivered (${String(window?.entries)})`)
  check(window?.truncated === false && window?.omitted === 0, 'W01 nothing reported as omitted')
  check(!window.text.includes('容量上限'), 'W01 no truncation header when nothing was cut')
  check(window.text.indexOf('first fact') < window.text.indexOf('third fact'), 'W01 entries stay in chronological order')
}

// ── W02: over budget keeps a NEWEST tail instead of returning nothing ──────
{
  const entries = Array.from({ length: 12 }, (_, index) => ({ text: `${'x'.repeat(900)} entry-${String(index)}` }))
  const session = fakeSession(entries)
  const budget = 4_000
  const window = buildFullTranscript(session, budget, trace)
  check(window !== undefined, 'W02 a long parent still yields a window (was: undefined)')
  check(window?.truncated === true && (window?.omitted ?? 0) > 0, `W02 truncation reported (omitted=${String(window?.omitted)})`)
  check(window.text.includes('entry-11'), 'W02 the NEWEST entry is present')
  check(!window.text.includes('entry-0'), 'W02 the oldest entry was dropped')
  check(window.chars + 2 * window.entries <= budget, `W02 rendered entries fit the budget (${String(window?.chars)} ≤ ${String(budget)})`)
  check(window.text.startsWith('（参考历史因容量上限'), 'W02 the header states the omission')
  check(window.entries === window.text.split('## ').length - 1, 'W02 entry count matches the rendered blocks')
}

// ── W03: the window is contiguous — a small old entry is not smuggled in ──
{
  const entries = [
    { text: 'ancient small fact' },
    { text: 'y'.repeat(3_000) },
    { text: 'middle fact' },
    { text: 'newest fact' },
  ]
  const session = fakeSession(entries)
  const window = buildFullTranscript(session, 1_200, trace)
  check(window !== undefined, 'W03 a window exists')
  check(window?.text.includes('newest fact'), 'W03 newest kept')
  check(!window?.text.includes('ancient small fact'), 'W03 nothing older than the cut is included (contiguous tail)')
  check((window?.omitted ?? 0) >= 1, `W03 omission counted (${String(window?.omitted)})`)
}

// ── W04: nothing derivable → undefined (the summary fallback) ─────────────
{
  const session = fakeSession([])
  check(buildFullTranscript(session, 10_000, trace) === undefined, 'W04 an empty parent yields undefined (summary fallback)')
}

// ── W05: a budget too small for the newest entry → undefined ──────────────
{
  const session = fakeSession([{ text: 'z'.repeat(5_000) }])
  check(buildFullTranscript(session, 100, trace) === undefined, 'W05 an impossible budget yields undefined (summary fallback)')
}

// ── W06: hidden kinds skipped, compact checkpoints kept ───────────────────
{
  const session = fakeSession([
    { text: 'user typed this' },
    { text: 'injected mirror from an outer plugin', kind: 'aux-chat-mirror' },
    { text: 'compaction checkpoint content', kind: 'compact-checkpoint' },
  ])
  const window = buildFullTranscript(session, 10_000, trace)
  check(window?.text.includes('user typed this'), 'W06 ordinary user messages included')
  check(!window?.text.includes('injected mirror from an outer plugin'), 'W06 foreign context kinds stay out')
  check(window?.text.includes('compaction checkpoint content'), 'W06 compaction checkpoints are part of the committed history')
}

// ── W07: tool results stay hard-capped ────────────────────────────────────
{
  const session = fakeSession([{ type: 'tool/result', text: 't'.repeat(20_000) }])
  const window = buildFullTranscript(session, 100_000, trace)
  check(window !== undefined, 'W07 a huge tool result still yields a window')
  check(window.chars <= MAX_INHERIT_TOOL_CHARS + 200, `W07 tool results are condensed (${String(window?.chars)} chars)`)
}


// ── W08–W15: structural markers (plan v2 P3/WP3.1, goal G10) ───────────────
{
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' } }, message: { content: [{ type: 'text', text: 'run the tests' }] } },
    {
      type: 'assistant/message',
      data: { source: { kind: 'model' } },
      message: {
        content: [
          { type: 'reasoning', text: 'hmm' },
          { type: 'text', text: 'I will check' },
          { type: 'tool-call', name: 'read', arguments: '{}' },
          { type: 'tool-call', name: 'grep', arguments: '{}' },
        ],
      },
    },
    {
      type: 'assistant/message',
      data: { source: { kind: 'model' } },
      message: { content: [{ type: 'tool-call', name: 'edit', arguments: '{}' }, { type: 'text', text: 'done' }] },
    },
    { type: 'tool/result', data: { source: { kind: 'tool' } }, message: { content: [{ type: 'text', text: 'ok output' }] } },
  ]
  const session = {
    surface: { nodes: events.map((_, index) => index) },
    snapshotEvents: () => events,
    deriveEventMessage: (event) => event.message,
  }
  const window = buildFullTranscript(session, 100_000, trace)
  const text = window?.text ?? ''
  check(text.includes('[reasoning omitted ×1]'), 'W08 reasoning blocks are declared omitted')
  check(text.includes('[tool calls ×2: read, grep]'), 'W09 multi-tool entries carry a count+names marker')
  check(!text.includes('[tool calls ×1'), 'W10 single-tool entries stay noise-free')
  check(text.includes('## User (seq 0)'), 'W11 user entries carry a role header')
  check(text.includes('## Assistant (seq 1)'), 'W12 assistant entries carry a role header')
  check(text.includes('[called read({})]'), 'W13 tool calls keep their per-call marker')
  check(text.indexOf('## User (seq 0)') < text.indexOf('## Assistant (seq 1)'), 'W14 chronological order preserved')
  check(text.includes('## Tool result (seq 3)'), 'W15 tool results carry their own role header')
}

for (const line of passes) console.log(`ok   ${line}`)
for (const line of failures) console.error(line)
console.log(
  failures.length === 0
    ? `mirror-window: ${String(passes.length)} checks passed`
    : `mirror-window: ${String(failures.length)} FAILED`,
)
process.exit(failures.length === 0 ? 0 : 1)
