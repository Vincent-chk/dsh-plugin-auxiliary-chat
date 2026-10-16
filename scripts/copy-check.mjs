#!/usr/bin/env node
/**
 * Standalone copy gate (plan v2 P0/WP0.2). Also folded into scripts/verify.mjs.
 * @module scripts/copy-check
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCopyChecks } from './copy-gates.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = runCopyChecks(root)
for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.message}`)
if (results.some((r) => !r.ok)) process.exit(1)
console.log(`copy-check: ${results.length}/${results.length} checks passed`)
