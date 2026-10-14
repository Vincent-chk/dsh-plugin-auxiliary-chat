/**
 * Lazy resolution of the three Host helper VALUES this plugin cannot reach
 * through a context service.
 *
 * Two values are needed: the prompt renderers (the mirrored system prompt) and
 * the `Config` schema (resolved at module scope). Nothing else — the plugin
 * constructs no messages and seeds no history, and it reads the session's own
 * conversation through the public `Session` surface instead of a package import.
 *
 * Why lazy: Node resolves ESM specifiers through REAL paths, which was
 * reproduced on this machine — a package reached through a symlink failed with
 * `ERR_MODULE_NOT_FOUND` for a dependency that existed only next to the link. A
 * plugin installed as a symlink into a profile (`pnpm add file:/path/to/repo`)
 * therefore cannot rely on a static import of `@deepseek-ai/dsh-*`: the import
 * would abort plugin load and the panel would never appear. A lazy import
 * degrades to a warning instead.
 *
 * Resolution is attempted in order and the winner is reported in `loaded`:
 *
 *   1. the bare specifier (works whenever the package resolves from the plugin);
 *   2. every `node_modules` directory reachable by walking up from
 *      `ctx.baseUrl` (the loader's anchor, the profile directory),
 *      `import.meta.url` (the plugin itself) and `process.argv[1]` (the Host
 *      entry point, i.e. the installation root of the running DSH);
 *   3. `$DSH_PROFILES_DIR`, `$DSH_HOME/profiles` and the current directory,
 *      which cover the npx/global layouts where the Harness packages sit in one
 *      flat `node_modules`.
 *
 * @module host/dsh-modules
 */
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveDshHome } from './env.ts'
import type { DshModules, HostContext } from './types.ts'

/**
 * ESM entry of each package we need, from its published `exports` map.
 *
 * `@deepseek-ai/schemastery` is here for the plugin's `Config` schema, which
 * must exist at module scope; `lib/index.mjs` is its `exports["."].import`
 * target (it also ships a CJS build).
 */
export const PACKAGE_ENTRY: Record<string, string> = {
  '@deepseek-ai/dsh-system-prompt': 'lib/index.js',
  '@deepseek-ai/dsh-scope': 'lib/index.js',
  '@deepseek-ai/schemastery': 'lib/index.mjs',
}

/** Normalize a path or file URL into a directory URL ending in `/`. */
function asBaseUrl(anchor: string): string | undefined {
  const trimmed = anchor.trim()
  if (trimmed === '') return undefined
  try {
    const href = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : pathToFileURL(trimmed).href
    const url = new URL(href)
    if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
    return url.href
  } catch {
    return undefined
  }
}

/**
 * Every `node_modules` directory reachable from one starting point.
 *
 * `<dir>/node_modules` is added for EVERY ancestor `<dir>`, not only for
 * ancestors literally named `node_modules`: the profile directory is
 * `<DSH_HOME>/profiles/<name>/`, so the flat installation root sits in a
 * SIBLING branch (`<DSH_HOME>/profiles/node_modules`) that only the
 * `<dir>/node_modules` form finds.
 */
function nodeModulesAbove(start: string, into: Set<string>): void {
  let current: string
  try {
    current = /^[a-z][a-z0-9+.-]*:/i.test(start) ? fileURLToPath(start) : start
  } catch {
    return
  }
  for (let depth = 0; depth < 16; depth += 1) {
    into.add(join(current, 'node_modules'))
    if (basename(current) === 'node_modules') into.add(current)
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/**
 * Candidate `node_modules` directories, most specific first.
 * @param ctx - Host context.
 * @returns absolute directories that may hold the Harness packages.
 */
function candidateRoots(ctx: HostContext | undefined): string[] {
  const seen = new Set<string>()
  const seeds: Array<string | undefined> = [ctx?.baseUrl, import.meta.url, process.argv[1]]
  for (const seed of seeds) {
    if (typeof seed === 'string' && seed !== '') nodeModulesAbove(seed, seen)
  }
  const home = resolveDshHome()
  for (const extra of [process.env['DSH_PROFILES_DIR'], join(home, 'profiles'), process.env['DSH_PROFILES_DIR'] === undefined ? undefined : join(process.env['DSH_PROFILES_DIR'], 'node_modules'), process.cwd()]) {
    if (typeof extra !== 'string' || extra === '') continue
    seen.add(join(extra, 'node_modules'))
    seen.add(extra)
  }
  return [...seen]
}

/**
 * Import one Host package: bare specifier first, then every anchored
 * `node_modules` candidate.
 *
 * Exported because `apply.ts` needs the same resolution at MODULE SCOPE for the
 * `Config` schema, where no context exists yet — `ctx` is optional here.
 *
 * @param ctx - Host context when one exists (contributes `baseUrl` as an anchor).
 * @param specifier - bare package name, must be a key of {@link PACKAGE_ENTRY}.
 * @param loaded - optional sink recording how resolution succeeded.
 * @returns the module namespace, or `undefined` when nothing resolved.
 */
export async function importHostPackage(
  ctx: HostContext | undefined,
  specifier: string,
  loaded: string[] = [],
): Promise<Record<string, unknown> | undefined> {
  const entry = PACKAGE_ENTRY[specifier]
  if (entry === undefined) return undefined
  try {
    const module = (await import(specifier)) as Record<string, unknown>
    loaded.push(specifier)
    return module
  } catch {
    /* fall through to path-anchored resolution */
  }
  for (const root of candidateRoots(ctx)) {
    const base = asBaseUrl(root)
    if (base === undefined) continue
    try {
      const url = new URL(`${specifier}/${entry}`, base)
      const module = (await import(url.href)) as Record<string, unknown>
      loaded.push(`${specifier}@${url.href}`)
      return module
    } catch {
      /* try the next candidate root */
    }
  }
  ctx?.logger?.warn?.(`aux-chat: could not resolve ${specifier}; that capability will degrade`)
  return undefined
}

/**
 * Build the memoized loader this plugin's create path uses.
 * @param ctx - Host context; only `baseUrl` and `logger` are read.
 * @returns an async function resolving to whatever subset of {@link DshModules} is reachable.
 */
export function makeDshLoader(ctx: HostContext): () => Promise<DshModules> {
  let pending: Promise<DshModules> | undefined
  return () => {
    pending ??= (async (): Promise<DshModules> => {
      const loaded: string[] = []
      const systemPrompt = await importHostPackage(ctx, '@deepseek-ai/dsh-system-prompt', loaded)
      const modules: DshModules = { loaded }
      const renderPrompt = systemPrompt?.['renderPrompt']
      if (typeof renderPrompt === 'function') modules.renderPrompt = (assembly) => (renderPrompt as (a: unknown) => string)(assembly)
      const renderContextSnapshot = systemPrompt?.['renderContextSnapshot']
      if (typeof renderContextSnapshot === 'function') {
        modules.renderContextSnapshot = (assembly) => (renderContextSnapshot as (a: unknown) => string)(assembly)
      }
      const scope = await importHostPackage(ctx, '@deepseek-ai/dsh-scope', loaded)
      const createScope = scope?.['createScope']
      if (typeof createScope === 'function') {
        modules.createScope = (parent: HostContext, key: unknown) =>
          (createScope as (ctx: HostContext, key: unknown) => { ctx: unknown; dispose(): Promise<void> })(parent, key) as unknown as {
            ctx: HostContext
            dispose(): Promise<void>
          }
      }
      if (loaded.length > 0) ctx.logger?.info?.(`aux-chat: host helpers loaded from ${loaded.join(', ')}`)
      return modules
    })()
    return pending
  }
}
