/**
 * One-time local setup: `pnpm run setup` (note: `pnpm setup` is a pnpm built-in that edits your
 * global PNPM_HOME — use `pnpm run setup`). Idempotent; safe to re-run.
 *
 *  1. .env from .env.example
 *  2. PostgreSQL: use DATABASE_URL if reachable, else start the bundled docker-compose database
 *  3. Create + migrate the app and test databases
 *  4. Playwright Chromium (project version)
 *  5. Optional project-local binaries (Katana, httpx) into .tools/bin — skip with --skip-tools
 *  6. Docker scanner images, only on request: --with-scanners (ZAP + testssl.sh), --with-sitespeed
 *  7. Report tool and AI runtime status
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getConfig, LOCAL_BIN_DIR, LOCAL_TOOLS_DIR, REPO_ROOT, resetConfig } from '@audivra/config'
import { canConnect, ensureDatabase, runMigrations } from '@audivra/database'
import {
  chromiumExecutable,
  DOCKER_IMAGES,
  dockerImagePresent,
  dockerVersion,
  getSystemStatus,
  LOCAL_BROWSERS_DIR,
  runProcess,
} from '@audivra/tool-runtime'

const args = new Set(process.argv.slice(2))
const ok = (msg: string) => console.log(`  ✓ ${msg}`)
const warn = (msg: string) => console.log(`  ! ${msg}`)
const step = (msg: string) => console.log(`\n▸ ${msg}`)

async function main() {
  console.log('Audivra setup')

  step('Runtime')
  const [major] = process.versions.node.split('.').map(Number)
  if ((major ?? 0) < 22) throw new Error(`Node.js >= 22.12 is required (found ${process.version})`)
  ok(`Node ${process.version}, platform ${process.platform}/${process.arch}`)

  step('Environment file')
  const envFile = path.join(REPO_ROOT, '.env')
  if (!existsSync(envFile)) {
    copyFileSync(path.join(REPO_ROOT, '.env.example'), envFile)
    ok('Created .env from .env.example')
  } else ok('.env present')
  resetConfig()
  const config = getConfig()

  step('PostgreSQL')
  const serverUrl = new URL(config.DATABASE_URL)
  serverUrl.pathname = '/postgres'
  let reachable = await canConnect(serverUrl.toString())
  if (!reachable.ok) {
    warn(`DATABASE_URL server not reachable (${reachable.error})`)
    const docker = await runProcess({
      command: 'docker',
      args: ['version', '--format', '{{.Server.Version}}'],
      timeoutMs: 15000,
    })
    if (docker.failed) {
      throw new Error(
        'PostgreSQL is unreachable and Docker is not available. Start PostgreSQL and set DATABASE_URL in .env.',
      )
    }
    console.log('    starting bundled database: docker compose up -d db')
    const up = await runProcess({
      command: 'docker',
      args: ['compose', 'up', '-d', 'db'],
      cwd: REPO_ROOT,
      timeoutMs: 300_000,
    })
    if (up.failed) throw new Error(`docker compose failed: ${up.stderr.slice(-500)}`)
    for (let i = 0; i < 60 && !reachable.ok; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      reachable = await canConnect(serverUrl.toString())
    }
    if (!reachable.ok) throw new Error(`Database container did not become ready: ${reachable.error}`)
  }
  ok(`Server reachable at ${serverUrl.host}`)
  for (const url of [config.DATABASE_URL, config.TEST_DATABASE_URL]) {
    const name = new URL(url).pathname.slice(1)
    if (await ensureDatabase(url)) ok(`Created database ${name}`)
    await runMigrations(url)
    ok(`Migrated ${name}`)
  }

  step('Browser (Playwright Chromium)')
  if (chromiumExecutable()) ok(`Chromium present: ${chromiumExecutable()}`)
  else {
    console.log(`    installing Chromium for Playwright into ${path.relative(REPO_ROOT, LOCAL_BROWSERS_DIR)} (one-time download, ~170 MB)…`)
    const install = await runProcess({
      command: process.execPath,
      args: [path.join(REPO_ROOT, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'],
      // Project-local: never fills (or depends on) the shared cache on the system drive.
      env: { PLAYWRIGHT_BROWSERS_PATH: LOCAL_BROWSERS_DIR },
      timeoutMs: 900_000,
    })
    if (install.failed || !chromiumExecutable())
      throw new Error(`Chromium install failed: ${install.stderr.slice(-500)}`)
    ok('Chromium installed')
  }

  step('Optional tools (project-local)')
  if (args.has('--skip-tools')) warn('Skipped (--skip-tools)')
  else {
    for (const tool of ['katana', 'httpx']) {
      try {
        const result = await installProjectDiscoveryTool(tool)
        ok(result)
      } catch (error) {
        warn(
          `${tool}: not installed (${error instanceof Error ? error.message : String(error)}). Audits still work without it.`,
        )
      }
    }
  }

  step('Docker scanners (passive security, deep performance)')
  await setupDockerScanners()

  step('Tool registry')
  const status = await getSystemStatus({ refresh: true })
  for (const tool of status.tools) {
    console.log(
      `  ${tool.name.padEnd(32)} ${tool.state.toUpperCase().padEnd(10)} ${(tool.version ?? '').padEnd(10)} ${tool.detail ?? ''}`,
    )
  }
  const claude = status.tools.find((t) => t.id === 'claude')
  if (claude?.state !== 'ready') {
    warn(
      'Claude Code is not ready: audits will run baseline-only until it is (install Claude Code and run `claude auth login`).',
    )
  }

  console.log('\nSetup complete. Start the app with:  pnpm dev   →  http://127.0.0.1:' + config.WEB_PORT)
}

/**
 * ZAP (passive baseline) and testssl.sh run in Docker; sitespeed.io is an optional deep-performance
 * tool. The images are large, so they are only pulled on request (they land on Docker's data disk).
 */
async function setupDockerScanners() {
  const images: { id: string; image: string; size: string; flag: string }[] = [
    { id: 'testssl.sh', image: DOCKER_IMAGES.testssl, size: '~80 MB', flag: '--with-scanners' },
    { id: 'ZAP baseline', image: DOCKER_IMAGES.zap, size: '~3.7 GB', flag: '--with-scanners' },
    { id: 'sitespeed.io', image: DOCKER_IMAGES.sitespeed, size: '~5 GB', flag: '--with-sitespeed' },
  ]
  const docker = await dockerVersion()
  if (!docker) {
    warn('Docker is not running: ZAP, testssl.sh and sitespeed.io will show as unavailable (audits still work).')
    return
  }
  for (const { id, image, size, flag } of images) {
    if (await dockerImagePresent(image)) {
      ok(`${id}: ${image} present`)
      continue
    }
    if (!args.has(flag)) {
      warn(`${id}: not pulled (${size}). Run \`pnpm run setup -- ${flag}\` to enable it; check Docker's disk has room first.`)
      continue
    }
    console.log(`    pulling ${image} (${size})…`)
    const pull = await runProcess({ command: 'docker', args: ['pull', image], timeoutMs: 60 * 60_000 })
    if (pull.failed) warn(`${id}: pull failed (${pull.stderr.trim().split('\n').pop() ?? pull.errorMessage}). Audits still work without it.`)
    else ok(`${id}: pulled ${image}`)
  }
}

/** Downloads a ProjectDiscovery release binary for this platform into .tools/bin (no global install). */
async function installProjectDiscoveryTool(name: string): Promise<string> {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const target = path.join(LOCAL_BIN_DIR, exe)
  if (existsSync(target)) return `${name} already installed (.tools/bin)`
  const platform = { win32: 'windows', darwin: 'macOS', linux: 'linux' }[process.platform as string]
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch as string]
  if (!platform || !arch) throw new Error(`unsupported platform ${process.platform}/${process.arch}`)

  const release = (await (
    await fetch(`https://api.github.com/repos/projectdiscovery/${name}/releases/latest`, {
      headers: { 'user-agent': 'audivra-setup', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    })
  ).json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] }
  const asset = release.assets?.find((a) =>
    a.name.toLowerCase().includes(`_${platform.toLowerCase()}_${arch}.zip`),
  )
  if (!asset) throw new Error(`no release asset for ${platform}/${arch}`)

  const tmp = path.join(LOCAL_TOOLS_DIR, 'tmp', name)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  mkdirSync(LOCAL_BIN_DIR, { recursive: true })
  const zip = path.join(tmp, asset.name)
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new Error(`download failed (${response.status})`)
  await writeFile(zip, Buffer.from(await response.arrayBuffer()))
  // bsdtar (bundled with Windows 10+, macOS and most Linux distros) extracts zip archives.
  // On Windows use the system bsdtar explicitly: Git Bash's GNU tar on PATH treats "D:" as a remote host.
  const systemTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const tar = process.platform === 'win32' && existsSync(systemTar) ? systemTar : 'tar'
  const extract = await runProcess({ command: tar, args: ['-xf', zip, '-C', tmp], timeoutMs: 120_000 })
  if (extract.failed) throw new Error(`extract failed: ${extract.stderr.slice(-200)}`)
  const binary = readdirSync(tmp).find((f) => f === exe)
  if (!binary) throw new Error('binary not found in archive')
  renameSync(path.join(tmp, binary), target)
  rmSync(tmp, { recursive: true, force: true })
  return `${name} ${release.tag_name ?? ''} installed to .tools/bin`
}

main().catch((error: unknown) => {
  console.error(`\n✗ Setup failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
