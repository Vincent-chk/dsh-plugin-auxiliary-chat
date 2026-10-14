#!/usr/bin/env node
/**
 * Build both halves of the plugin with no DSH source checkout and no build
 * framework:
 *
 *   lib/index.js   host half  — plain ESM copy of src/index.ts with the type
 *                              syntax stripped (Node runs it directly).
 *   lib/client.js  client half — factory-form CommonJS wrapped in the
 *                              `window.__ModuleLoader__.load({...})`
 *                              registration the shell installs in <head>.
 *
 * WHY A WRAPPER: client-modules executes a plugin bundle as a classic script
 * whose only job is to REGISTER a factory. tsdown plus the (unpublished) DSH
 * client preset produces exactly the same shape; the wrapper below is that
 * shape written by hand, which is why nothing here depends on the DSH repo.
 * @module scripts/build
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const ID = pkg.name

/**
 * Specifiers the browser module table seeds or that another plugin package
 * answers. They must NOT be inlined: the browser resolves them through
 * `require()` against the frozen platform table / the boot graph.
 *
 * This list is exactly the platform seed table
 * (react, react/jsx-runtime, react-dom, react-dom/client,
 * @deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
 * @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
 * @deepseek-ai/dsh-client-ui-dockkit) plus every package this plugin declares in
 * `dsh.client.external`. Anything else must be bundled in.
 */
const EXTERNAL = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
  ...((pkg.dsh?.client?.external ?? [])),
]

/** Locate esbuild without assuming any particular node_modules layout. */
function resolveEsbuild() {
  const candidates = [
    join(root, 'node_modules', 'esbuild'),
    join(process.env.DSH_PROFILES_DIR ?? '/Users/a1-6/.dsh/profiles', 'node_modules', 'esbuild'),
  ]
  for (const base of candidates) {
    try {
      return createRequire(join(base, 'noop.js'))('esbuild')
    } catch {
      /* try the next anchor */
    }
  }
  try {
    return createRequire(import.meta.url)('esbuild')
  } catch {
    console.error(
      [
        'build: esbuild was not found.',
        '',
        'Install it once, outside the DSH profile, then re-run:',
        '  npm i -D esbuild          # or: pnpm add -D esbuild',
        'Or point DSH_PROFILES_DIR at a directory whose node_modules has esbuild.',
        '',
        'esbuild is only a devDependency of THIS package: the Host process never',
        'loads it, and DSH never needs it installed in a profile.',
      ].join('\n'),
    )
    process.exit(1)
  }
}

/**
 * Inline `import css from "./x.css?inline"` using a markdown esbuild plugin, so
 * the CSS text lands in the bundle with no asset-file indirection (which the
 * bundle protocol cannot serve: a client bundle must be self-contained).
 * @returns the esbuild plugin.
 */
const inlineCss = {
  name: 'inline-css',
  setup(build) {
    build.onResolve({ filter: /\?inline$/ }, (args) => ({
      path: join(args.resolveDir, args.path.replace(/\?inline$/, '')),
      namespace: 'inline-css',
    }))
    build.onLoad({ filter: /.*/, namespace: 'inline-css' }, (args) => ({
      contents: readFileSync(args.path, 'utf8'),
      loader: 'text',
    }))
  },
}

/** Strip the trailing sourceMappingURL comment esbuild may append. */
function stripMapTrailer(code) {
  return code.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n')
}

/** Turn bundled CommonJS into the registration stub the browser expects. */
function wrapClient(body) {
  return [
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(ID)},`,
    '\tfactory: (require) => {',
    // esbuild's CJS output targets a Node module scope. The browser hands the
    // factory only `require`, so the module/exports pair the lazy-CJS contract
    // documents must be declared here — exactly as tsdown's client preset does.
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    body
      .replace(/^/gm, '\t\t')
      .replace(/\n+$/, '\n'),
    // The factory RESULT is the bundle's exports: `factory(require)` is the
    // materialization contract, and a missing return yields `undefined` exports.
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n')
}

const esbuild = resolveEsbuild()

/** `--half host|client` builds one half only, so two authors can build in parallel. */
const argv = process.argv.slice(2)
const halfIndex = argv.indexOf('--half')
const HALF = halfIndex === -1 ? 'both' : argv[halfIndex + 1]
if (HALF !== 'both' && HALF !== 'host' && HALF !== 'client') {
  console.error(`build: --half must be "host" or "client", got ${JSON.stringify(HALF)}`)
  process.exit(1)
}

mkdirSync(join(root, 'lib'), { recursive: true })

// ── host half ────────────────────────────────────────────────────────────────
// BUNDLED, because the plugin owns several source files: Node cannot import
// `.ts`, so relative specifiers must be inlined here. `packages: 'external'`
// keeps every bare specifier exactly as written, so the profile's own
// resolution decides where @deepseek-ai/* come from — the same contract the
// shipped host bundles have (they are single files importing bare package
// names only).
const host = HALF === 'client' ? undefined : await esbuild.build({
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  write: false,
  logLevel: 'warning',
})
if (host !== undefined) writeFileSync(join(root, 'lib/index.js'), host.outputFiles[0].text)

// Type declarations are copied verbatim: the Loader resolves `types` but never
// needs a declaration build, and shipping the authored ones keeps them honest.
//
// Written per OWNER, never wholesale: `cpSync` onto an existing `lib/types`
// REMOVES what the other half published (the host copy would delete
// `lib/types/client/**`), which is exactly the kind of cross-half interference a
// per-half build exists to avoid.
function publishTypes(publish) {
  if (!publish) return
  const typesSrc = join(root, 'src/types')
  if (!existsSync(typesSrc)) {
    console.warn('build: src/types is absent; lib/types will not be published')
    return
  }
  cpSync(typesSrc, join(root, 'lib/types'), { recursive: true, force: true })
}

if (HALF === 'both') rmSync(join(root, 'lib/types'), { recursive: true, force: true })
publishTypes(HALF !== 'client')

// The client half's declaration face: `package.json` advertises
// `exports["./client"].types`, so the file must exist for a resolving consumer.
if (HALF !== 'host') {
  const clientTypes = join(root, 'lib/types/client')
  mkdirSync(clientTypes, { recursive: true })
  writeFileSync(
    join(clientTypes, 'index.d.ts'),
    [
      '/**',
      ' * Client (browser) half of this plugin.',
      ' *',
      ' * The bundle is a classic-script factory registered with',
      ' * `window.__ModuleLoader__.load`, so its module face is described here',
      ' * rather than inferred from a source emit.',
      ' */',
      "import type { Context } from '@deepseek-ai/cordis'",
      '',
      '/** Cordis client services this plugin waits for. */',
      "export declare const inject: string[]",
      '',
      '/**',
      ' * Install the sidebar entry, the auxiliary-chat panel, and the locale namespace.',
      ' * @param ctx - client root context.',
      ' */',
      'export declare function apply(ctx: Context): void',
      '',
    ].join('\n'),
  )
}

// ── client half ──────────────────────────────────────────────────────────────
const client = HALF === 'host' ? undefined : await esbuild.build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: EXTERNAL,
  plugins: [inlineCss],
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
  logLevel: 'warning',
})
if (client !== undefined) writeFileSync(join(root, 'lib/client.js'), wrapClient(stripMapTrailer(client.outputFiles[0].text)))

// The artifact stamps: client-hmr polls `lib/client.js` metadata (mtime, ctime,
// size) every 500 ms and reloads the browser plugin when it changes. Writing the
// file is the whole trigger — but a rewrite whose mtime/ctime/size are all
// unchanged is invisible, so never "restore" a build by copying identical bytes.
for (const file of HALF === 'host' ? ['lib/index.js'] : HALF === 'client' ? ['lib/client.js'] : ['lib/index.js', 'lib/client.js']) {
  const text = readFileSync(join(root, file), 'utf8')
  if (text.length === 0) throw new Error(`build: ${file} is empty`)
}
rmSync(join(root, 'node_modules', '.cache'), { recursive: true, force: true })
console.log(`build: ${HALF === 'host' ? 'lib/index.js' : HALF === 'client' ? 'lib/client.js' : 'lib/index.js, lib/client.js'} (${ID})`)
