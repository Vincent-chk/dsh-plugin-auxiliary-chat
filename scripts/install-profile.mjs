#!/usr/bin/env node
/**
 * Wire this plugin into a DSH profile through a `link:` dependency.
 *
 * WHY NOT `dsh plugin --profile desktop add`: the CLI hard-refuses the desktop
 * profile ("managed exclusively by the Electron application", dsh/lib/bin.js
 * rejectElectronProfile), so a local plugin is installed by editing the profile
 * manifest and running pnpm in the profile directory — the same end state the
 * supported path produces.
 *
 * SAFETY:
 *  - `--check` prints the planned change and writes nothing (default posture).
 *  - `--apply` backs up package.json first, then edits in place.
 *  - `--uninstall` removes exactly the two lines this script adds (plus a backup).
 *  - `pnpm install` is NOT run here; the script prints the exact command so the
 *    operator keeps that step explicit. Pass `--pnpm` to run it inline.
 * @module scripts/install-profile
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const NAME = pkg.name

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const UNINSTALL = argv.includes('--uninstall')
const RUN_PNPM = argv.includes('--pnpm')
const LINK_ONLY = argv.includes('--no-pnpm')
const profileFlag = argv.indexOf('--profile-dir')
const profileDir = profileFlag === -1 ? '/Users/a1-6/.dsh/profiles/desktop' : resolve(argv[profileFlag + 1] ?? '')

const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`install: no profile manifest at ${manifestPath}`)
  process.exit(1)
}

const original = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(original)
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []

const already = manifest.dependencies[NAME] === `link:${root}` && manifest.dsh.profile.bundles.includes(NAME)

console.log(`profile      : ${profileDir}`)
console.log(`plugin       : ${NAME}`)
console.log(`link target  : ${root}`)
console.log(`current state: ${already ? 'already installed' : UNINSTALL ? 'installed → will remove' : 'not installed'}`)

if (UNINSTALL) {
  delete manifest.dependencies[NAME]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((bundle) => bundle !== NAME)
} else {
  manifest.dependencies[NAME] = `link:${root}`
  if (!manifest.dsh.profile.bundles.includes(NAME)) manifest.dsh.profile.bundles.push(NAME)
}

const next = `${JSON.stringify(manifest, null, 2)}\n`
console.log('\n--- package.json after change ---')
console.log(next)

if (!APPLY) {
  console.log('dry run: nothing written. Re-run with --apply to write (a backup is kept).')
  console.log(`then: cd ${profileDir} && pnpm install`)
  process.exit(0)
}

const backup = `${manifestPath}.bak-${String(Date.now())}`
copyFileSync(manifestPath, backup)
writeFileSync(manifestPath, next)
console.log(`\nwrote ${manifestPath}`)
console.log(`backup ${backup}`)

// The directory link pnpm would create for a `link:` dependency. Written by
// hand when asked, so wiring a plugin never has to re-resolve (and re-link) the
// other 249 entries of a live profile — the same shape this profile already uses
// for every @deepseek-ai package.
if (LINK_ONLY && !UNINSTALL) {
  const scopeDir = join(profileDir, 'node_modules', ...NAME.split('/').slice(0, -1))
  const linkPath = join(profileDir, 'node_modules', ...NAME.split('/'))
  mkdirSync(scopeDir, { recursive: true })
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(root, linkPath, 'dir')
  console.log(`linked ${linkPath} -> ${root}`)
}
if (LINK_ONLY && UNINSTALL) {
  const linkPath = join(profileDir, 'node_modules', ...NAME.split('/'))
  rmSync(linkPath, { recursive: true, force: true })
  console.log(`unlinked ${linkPath}`)
}

if (RUN_PNPM) {
  console.log(`running pnpm install in ${profileDir} ...`)
  execFileSync('pnpm', ['install'], { cwd: profileDir, stdio: 'inherit' })
}
console.log(`\nnext: cd ${profileDir} && pnpm install`)
console.log('then restart DeepSeek Harness Desktop (the Loader reads bundles at composition time).')
console.log(`rollback: node scripts/install-profile.mjs --uninstall --apply`)

// ── post-install resolution probe ────────────────────────────────────────────
// A `link:` dependency only works if the plugin's own peer (cordis) resolves
// from the profile's hoisted node_modules. Probe it without loading anything.
if (APPLY && !UNINSTALL) {
  const probe = join(profileDir, 'node_modules', ...NAME.split('/'), 'package.json')
  if (existsSync(probe)) {
    console.log(`resolved : ${probe}`)
    // A DSH profile hoists nothing locally: `@deepseek-ai/*` lives in the
    // PROFILES directory one level up, which is why `node_modules` here holds
    // only this plugin. Probe the way Node resolves — walk up the ancestors —
    // instead of assuming a local copy.
    try {
      const candidates = [profileDir, dirname(profileDir), dirname(dirname(profileDir))]
      const found = candidates.find((base) => existsSync(join(base, 'node_modules', '@deepseek-ai', 'cordis', 'package.json')))
      console.log(found === undefined ? 'peer FAIL: @deepseek-ai/cordis is not resolvable from the profile' : `peer ok  : @deepseek-ai/cordis resolves from ${found}`)
    } catch (error) {
      console.error(`peer probe failed: ${String(error)}`)
    }
  } else {
    console.log(`not yet linked: run pnpm install in ${profileDir}, then re-run this script with --check`)
  }
}
