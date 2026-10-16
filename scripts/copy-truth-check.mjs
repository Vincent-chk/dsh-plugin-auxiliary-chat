#!/usr/bin/env node
/**
 * Standalone copy↔behaviour gate (plan v2 P0/WP0.3). Also folded into verify.
 * @module scripts/copy-truth-check
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCopyTruthChecks } from './copy-gates.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = runCopyTruthChecks(root)
for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.message}`)
if (results.some((r) => !r.ok)) process.exit(1)
console.log(`copy-truth-check: ${results.length}/${results.length} checks passed`)
