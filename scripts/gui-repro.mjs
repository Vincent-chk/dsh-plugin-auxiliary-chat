/**
 * Boot the isolated profile stack (same as e2e-isolated) and KEEP it running,
 * printing the authenticated GUI URL. Used to reproduce client-side behaviour
 * in a real browser against a throwaway DSH_HOME.
 * Usage: node scripts/gui-repro.mjs [--port 19531]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const PORT = portFlag === -1 ? 19531 : Number(argv[portFlag + 1])
const DSH_HOME_SRC = process.env['DSH_HOME'] ?? join(process.env['HOME'] ?? '', '.dsh')
const DSH_CLI = join(DSH_HOME_SRC, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(DSH_CLI)) { console.error(`no dsh CLI at ${DSH_CLI}`); process.exit(1) }

const scratch = mkdtempSync(join(tmpdir(), 'aux-gui-'))
const home = join(scratch, 'home')
const profileDir = join(home, 'profiles', 'e2e')
mkdirSync(profileDir, { recursive: true })

const sourceManifest = join(DSH_HOME_SRC, 'profiles', 'desktop', 'package.json')
const manifest = JSON.parse(readFileSync(sourceManifest, 'utf8'))
const manifestBase = existsSync(join(DSH_HOME_SRC, 'profiles', 'desktop', 'pnpm-workspace.yaml'))
  ? readFileSync(join(DSH_HOME_SRC, 'profiles', 'desktop', 'pnpm-workspace.yaml'), 'utf8')
  : 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const bundles = manifest.dsh.profile.bundles.filter((b) => b !== pkg.name)
for (const name of ['@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-ui-sidebar-files']) {
  if (!bundles.includes(name)) bundles.push(name)
}
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify({ name: 'dsh-profile-e2e', private: true, dependencies: { [pkg.name]: `link:${root}` }, dsh: { profile: { bundles: [...bundles, pkg.name] } } }, null, 2)}\n`,
)
writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), manifestBase)
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
symlinkSync(join(DSH_HOME_SRC, 'profiles', 'node_modules'), join(home, 'profiles', 'node_modules'), 'dir')
const scopeDir = join(profileDir, 'node_modules', ...pkg.name.split('/').slice(0, -1))
mkdirSync(scopeDir, { recursive: true })
symlinkSync(root, join(scopeDir, pkg.name.split('/').at(-1)), 'dir')

// A scratch workspace dir the GUI can pick.
const ws = join(scratch, 'ws')
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'hello.txt'), 'workspace scratch file\n')

const child = spawn(process.execPath, [DSH_CLI, '--profile', 'e2e', '--port', String(PORT), '--no-open'], {
  cwd: profileDir,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (c) => { log += String(c); process.stdout.write(c) })
child.stderr.on('data', (c) => { log += String(c); process.stderr.write(c) })

const deadline = Date.now() + 90_000
const timer = setInterval(() => {
  const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
  if (match !== null) {
    clearInterval(timer)
    console.log(`\nGUI_URL=${match[0]}`)
    console.log(`WS_DIR=${ws}`)
    console.log(`SCRATCH=${scratch}`)
    console.log(`HOST_PID=${String(child.pid)}`)
  } else if (/startup failed/.test(log)) {
    clearInterval(timer)
    console.error('startup failed')
    process.exit(1)
  } else if (Date.now() > deadline) {
    clearInterval(timer)
    console.error('timeout waiting for URL')
    process.exit(1)
  }
}, 400)

process.on('SIGTERM', () => { try { child.kill('SIGTERM') } catch {} ; process.exit(0) })
process.on('SIGINT', () => { try { child.kill('SIGTERM') } catch {} ; process.exit(0) })
child.on('exit', (code) => { console.log(`host exited ${String(code)}`); process.exit(code ?? 0) })
