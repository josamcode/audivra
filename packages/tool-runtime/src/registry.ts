import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { getConfig, LOCAL_BIN_DIR, LOCAL_TOOLS_DIR, REPO_ROOT } from '@audivra/config'
import type { SystemStatus, ToolStatus } from '@audivra/contracts'
import { probeVersion, runProcess } from './exec.ts'

const require = createRequire(path.join(REPO_ROOT, 'package.json'))
const isWindows = process.platform === 'win32'

/** Directories that hold project-local tool executables; prepended to PATH for audit processes. */
export function toolBinDirs(): string[] {
  return [path.join(REPO_ROOT, 'node_modules', '.bin'), LOCAL_BIN_DIR]
}

/** Locates an installed package directory (works for ESM-only packages whose exports hide package.json). */
export function packageDir(name: string): string | null {
  const direct = path.join(REPO_ROOT, 'node_modules', ...name.split('/'))
  if (existsSync(path.join(direct, 'package.json'))) return direct
  try {
    return path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    return null
  }
}

export function packageVersion(name: string): string | null {
  const dir = packageDir(name)
  if (!dir) return null
  try {
    return (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/**
 * Project-local browser cache (`.tools/ms-playwright`). `pnpm run setup` installs Chromium here when
 * the machine-wide Playwright cache does not have the matching build, so Audivra never depends on
 * (or fills) the system drive's shared cache.
 */
export const LOCAL_BROWSERS_DIR = path.join(LOCAL_TOOLS_DIR, 'ms-playwright')

/** Path of the Chromium build that matches the project's Playwright version, if installed. */
export function chromiumExecutable(): string | null {
  try {
    const playwright = require('playwright') as { chromium: { executablePath(): string } }
    const exe = playwright.chromium.executablePath()
    if (exe && existsSync(exe)) return exe
    // The same build inside the project-local cache: <cache>/chromium-NNNN/chrome-win64/chrome.exe.
    const parts = exe.split(/[\\/]/)
    const root = parts.lastIndexOf('ms-playwright')
    if (root >= 0) {
      const local = path.join(LOCAL_BROWSERS_DIR, ...parts.slice(root + 1))
      if (existsSync(local)) return local
    }
    return null
  } catch {
    return null
  }
}

/**
 * Environment that points browser-based tools at Audivra's Chromium: Playwright scripts the AI writes
 * (PLAYWRIGHT_BROWSERS_PATH), Lighthouse/chrome-launcher (CHROME_PATH) and Puppeteer-based tools such
 * as Pa11y and Unlighthouse (PUPPETEER_EXECUTABLE_PATH).
 */
export function browserEnv(): Record<string, string> {
  const chrome = chromiumExecutable()
  if (!chrome) return {}
  const env: Record<string, string> = { CHROME_PATH: chrome, PUPPETEER_EXECUTABLE_PATH: chrome }
  const parts = chrome.split(/[\\/]/)
  const build = parts.findIndex((p) => /^chromium-\d+$/.test(p))
  if (build > 0) env.PLAYWRIGHT_BROWSERS_PATH = parts.slice(0, build).join(path.sep)
  return env
}

/** Finds a binary in the project-local tool dir or on PATH. */
export function findBinary(name: string): string | null {
  const exts = isWindows ? ['.exe', '.cmd', ''] : ['']
  const dirs = [LOCAL_BIN_DIR, ...(process.env.PATH ?? '').split(path.delimiter)]
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * How the AI should start containers from its terminal (shown as tool hints). Containers must be named
 * `audivra-<audit>-…` so Audivra can stop exactly those when the audit ends or is cancelled. On Windows
 * (Git Bash) path conversion is disabled and the workspace is mounted by its Windows path.
 */
const DOCKER_RUN = process.platform === 'win32' ? 'MSYS_NO_PATHCONV=1 docker run --rm' : 'docker run --rm'
const WORKSPACE_MOUNT = process.platform === 'win32' ? '$(pwd -W)' : '$PWD'

/** Docker images Audivra can use for passive scanning and deep performance checks. */
export const DOCKER_IMAGES = {
  zap: 'zaproxy/zap-stable:latest',
  testssl: 'drwetter/testssl.sh:latest',
  sitespeed: 'sitespeedio/sitespeed.io:latest',
} as const

let dockerVersionCache: Promise<string | null> | undefined
export function dockerVersion(): Promise<string | null> {
  dockerVersionCache ??= (async () => {
    const result = await runProcess({ command: 'docker', args: ['version', '--format', '{{.Server.Version}}'], timeoutMs: 10_000 })
    return result.failed ? null : result.stdout.trim() || null
  })()
  return dockerVersionCache
}

export async function dockerImagePresent(image: string): Promise<boolean> {
  const result = await runProcess({ command: 'docker', args: ['image', 'inspect', image, '--format', '{{.Id}}'], timeoutMs: 10_000 })
  return !result.failed && result.stdout.trim().length > 0
}

type ProbeResult = Omit<ToolStatus, 'id' | 'name' | 'group' | 'optional'>
type Probe = () => Promise<ProbeResult>

interface ToolDefinition {
  id: string
  name: string
  group: string
  optional: boolean
  probe: Probe
}

const npmTool =
  (pkg: string, command: string | null, needsBrowser = false): Probe =>
  async () => {
    const version = packageVersion(pkg)
    if (!version) return { state: 'unavailable', version: null, via: 'npm', detail: 'Package not installed (run pnpm install).', command }
    if (needsBrowser && !chromiumExecutable()) {
      return { state: 'needs-setup', version, via: 'npm (project-local)', detail: 'Chromium not installed (run pnpm run setup).', command }
    }
    return { state: 'ready', version, via: 'npm (project-local)', detail: null, command }
  }

const binaryTool =
  (binary: string, versionArgs: string[], command: string): Probe =>
  async () => {
    const found = findBinary(binary)
    if (!found) return { state: 'unavailable', version: null, via: 'binary', detail: 'Not installed (pnpm run setup downloads it when possible).', command: null }
    const version = await probeVersion(found, versionArgs)
    return { state: 'ready', version, via: found.startsWith(LOCAL_BIN_DIR) ? 'binary (.tools/bin)' : 'binary (PATH)', detail: found, command }
  }

const dockerTool =
  (image: string, command: string, purpose: string): Probe =>
  async () => {
    const docker = await dockerVersion()
    if (!docker) return { state: 'unavailable', version: null, via: 'Docker', detail: 'Docker is not running.', command: null }
    if (await dockerImagePresent(image)) return { state: 'ready', version: null, via: 'Docker', detail: `${image} — ${purpose}`, command }
    return { state: 'needs-setup', version: null, via: 'Docker', detail: `${image} not pulled yet (pnpm run setup pulls it).`, command }
  }

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { id: 'playwright', name: 'Playwright', group: 'Browser', optional: false, probe: npmTool('playwright', 'node scripts using `playwright`', true) },
  { id: 'playwright-mcp', name: 'Playwright MCP (AI browser)', group: 'Browser', optional: false, probe: npmTool('@playwright/mcp', null, true) },
  { id: 'lighthouse', name: 'Lighthouse', group: 'Performance', optional: true, probe: npmTool('lighthouse', 'lighthouse <url> --output=json --output-path=tools/lighthouse/<name>', true) },
  { id: 'unlighthouse', name: 'Unlighthouse (site-wide Lighthouse)', group: 'Performance', optional: true, probe: npmTool('unlighthouse', 'unlighthouse-ci --site <url> --reporter jsonExpanded --output-path tools/unlighthouse', true) },
  {
    id: 'sitespeed',
    name: 'sitespeed.io',
    group: 'Performance',
    optional: true,
    probe: dockerTool(DOCKER_IMAGES.sitespeed, `${DOCKER_RUN} --name audivra-<audit>-sitespeed -v "${WORKSPACE_MOUNT}/tools/sitespeed:/sitespeed.io" ${DOCKER_IMAGES.sitespeed} <url> -n 3 --outputFolder /sitespeed.io/<name>`, 'deep multi-run performance'),
  },
  { id: 'crawler', name: 'Crawler (built-in)', group: 'SEO / crawl', optional: false, probe: async () => ({ state: 'ready', version: null, via: 'in-process', detail: 'Bounded same-site crawl with SEO/localization extraction', command: null }) },
  { id: 'katana', name: 'Katana', group: 'SEO / crawl', optional: true, probe: binaryTool('katana', ['-version'], 'katana -u <url> -d 2 -jc -fs fqdn -rl 2 -ct 45s -or -ob -j -silent -o tools/katana-ai.jsonl') },
  { id: 'linkinator', name: 'Linkinator', group: 'SEO / crawl', optional: true, probe: npmTool('linkinator', 'linkinator <url> --format json') },
  { id: 'cheerio', name: 'Cheerio (HTML parsing)', group: 'SEO / crawl', optional: true, probe: npmTool('cheerio', 'node scripts using `cheerio`') },
  { id: 'axe-core', name: 'axe-core', group: 'Accessibility', optional: true, probe: npmTool('@axe-core/playwright', 'node scripts using `@axe-core/playwright`', true) },
  { id: 'pa11y', name: 'Pa11y (HTML_CodeSniffer)', group: 'Accessibility', optional: true, probe: npmTool('pa11y', 'pa11y <url> --runner htmlcs --reporter json --config tools/pa11y.config.json', true) },
  { id: 'httpx', name: 'httpx (Wappalyzer fingerprints)', group: 'Technology', optional: true, probe: binaryTool('httpx', ['-version'], 'httpx -u <url> -td -title -status-code -tls-grab -json -silent') },
  { id: 'signatures', name: 'Technology signatures (built-in)', group: 'Technology', optional: true, probe: async () => ({ state: 'ready', version: null, via: 'in-process', detail: 'Headers, resource URLs, markup and JS globals', command: null }) },
  { id: 'testssl', name: 'testssl.sh', group: 'Security', optional: true, probe: dockerTool(DOCKER_IMAGES.testssl, `${DOCKER_RUN} --name audivra-<audit>-testssl-ai ${DOCKER_IMAGES.testssl} --quiet --ip one -p -S -P <host>`, 'protocols, ciphers, certificate') },
  { id: 'zap', name: 'OWASP ZAP baseline (passive)', group: 'Security', optional: true, probe: dockerTool(DOCKER_IMAGES.zap, `${DOCKER_RUN} --name audivra-<audit>-zap-ai ${DOCKER_IMAGES.zap} zap-baseline.py -t <url> -m 1 -z "-config spider.processform=false -config spider.postform=false"`, 'spider + passive scan rules only') },
  {
    id: 'nuclei',
    name: 'Nuclei',
    group: 'Security',
    optional: true,
    probe: async () => {
      const found = findBinary('nuclei')
      return {
        state: 'disabled',
        version: found ? await probeVersion(found, ['-version']) : null,
        via: found ? 'binary' : null,
        detail: `${found ? 'Installed' : 'Not installed'} — disabled by policy: vulnerability templates are active scanning and require an explicit authorized mode.`,
        command: null,
      }
    },
  },
  {
    id: 'curl',
    name: 'curl',
    group: 'Runtime',
    optional: true,
    probe: async () => {
      const version = await probeVersion('curl', ['--version'])
      return version
        ? { state: 'ready', version, via: 'system', detail: null, command: 'curl' }
        : { state: 'unavailable', version: null, via: null, detail: null, command: null }
    },
  },
  {
    id: 'docker',
    name: 'Docker',
    group: 'Runtime',
    optional: true,
    probe: async () => {
      const version = await dockerVersion()
      return version
        ? { state: 'ready', version, via: 'system', detail: 'Runs ZAP, testssl.sh and sitespeed.io containers', command: null }
        : { state: 'unavailable', version: null, via: null, detail: 'Docker daemon not reachable.', command: null }
    },
  },
  {
    id: 'claude',
    name: 'Claude Code (AI runtime)',
    group: 'AI',
    optional: false,
    probe: async () => {
      const config = getConfig()
      if (config.AUDIVRA_AI === 'off') return { state: 'disabled', version: null, via: 'CLI', detail: 'AI disabled (AUDIVRA_AI=off).', command: null }
      const version = await probeVersion(config.CLAUDE_BIN, ['--version'])
      if (!version) return { state: 'unavailable', version: null, via: 'CLI', detail: 'Claude Code CLI not found on PATH.', command: null }
      const auth = await runProcess({ command: config.CLAUDE_BIN, args: ['auth', 'status'], timeoutMs: 15_000 })
      try {
        const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string }
        if (!parsed.loggedIn) return { state: 'needs-setup', version, via: 'CLI', detail: 'Not logged in. Run `claude auth login`.', command: null }
        const plan = parsed.subscriptionType ? ` (${parsed.subscriptionType})` : ''
        return { state: 'ready', version, via: 'CLI (local login)', detail: `Authenticated via ${parsed.authMethod ?? 'unknown'}${plan}`, command: null }
      } catch {
        return { state: 'ready', version, via: 'CLI (local login)', detail: 'Authentication status unknown', command: null }
      }
    },
  },
]

let cache: { at: number; value: SystemStatus } | undefined
let inflight: Promise<SystemStatus> | undefined

/** Probes every registered tool. Results are cached for a few minutes because probes spawn processes. */
export async function getSystemStatus(options: { refresh?: boolean } = {}): Promise<SystemStatus> {
  if (!options.refresh && cache && Date.now() - cache.at < 5 * 60_000) return cache.value
  if (options.refresh) dockerVersionCache = undefined
  inflight ??= (async () => {
    const tools = await Promise.all(
      TOOL_DEFINITIONS.map(async (def): Promise<ToolStatus> => {
        try {
          const status = await def.probe()
          return { id: def.id, name: def.name, group: def.group, optional: def.optional, ...status }
        } catch (error) {
          return {
            id: def.id,
            name: def.name,
            group: def.group,
            optional: def.optional,
            state: 'error',
            version: null,
            via: null,
            detail: error instanceof Error ? error.message : String(error),
            command: null,
          }
        }
      }),
    )
    const value: SystemStatus = { checkedAt: new Date().toISOString(), tools }
    cache = { at: Date.now(), value }
    return value
  })().finally(() => {
    inflight = undefined
  })
  return inflight
}

export function isToolReady(status: SystemStatus, id: string): boolean {
  return status.tools.some((t) => t.id === id && t.state === 'ready')
}

export function toolStatus(status: SystemStatus, id: string): ToolStatus | undefined {
  return status.tools.find((t) => t.id === id)
}
