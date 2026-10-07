import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { getConfig, LOCAL_BIN_DIR, REPO_ROOT } from '@audivra/config'
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
    return (
      (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }).version ??
      null
    )
  } catch {
    return null
  }
}

/** Path of the Chromium build that matches the project's Playwright version, if installed. */
export function chromiumExecutable(): string | null {
  try {
    const playwright = require('playwright') as { chromium: { executablePath(): string } }
    const exe = playwright.chromium.executablePath()
    return exe && existsSync(exe) ? exe : null
  } catch {
    return null
  }
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

async function dockerImagePresent(image: string): Promise<boolean> {
  const result = await runProcess({
    command: 'docker',
    args: ['image', 'inspect', image, '--format', '{{.Id}}'],
    timeoutMs: 10000,
  })
  return !result.failed && result.stdout.trim().length > 0
}

type Probe = () => Promise<Omit<ToolStatus, 'id' | 'name' | 'group' | 'optional'>>

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
    if (!version)
      return {
        state: 'missing',
        version: null,
        via: 'npm',
        detail: 'Package not installed. Run pnpm install.',
        command,
      }
    if (needsBrowser && !chromiumExecutable()) {
      return {
        state: 'error',
        version,
        via: 'npm',
        detail: 'Chromium not installed. Run pnpm run setup.',
        command,
      }
    }
    return { state: 'ready', version, via: 'npm (project-local)', detail: null, command }
  }

const binaryTool =
  (binary: string, versionArgs: string[], command: string): Probe =>
  async () => {
    const found = findBinary(binary)
    if (!found) {
      return {
        state: 'missing',
        version: null,
        via: null,
        detail: 'Not installed. `pnpm run setup` downloads it when possible.',
        command: null,
      }
    }
    const version = await probeVersion(found, versionArgs)
    const local = found.startsWith(LOCAL_BIN_DIR)
    return {
      state: 'ready',
      version,
      via: local ? 'binary (.tools/bin)' : 'binary (PATH)',
      detail: found,
      command,
    }
  }

let dockerAvailable: Promise<string | null> | undefined
function dockerVersion(): Promise<string | null> {
  dockerAvailable ??= (async () => {
    const result = await runProcess({
      command: 'docker',
      args: ['version', '--format', '{{.Server.Version}}'],
      timeoutMs: 10000,
    })
    return result.failed ? null : result.stdout.trim() || null
  })()
  return dockerAvailable
}

const dockerTool =
  (image: string, command: string): Probe =>
  async () => {
    const docker = await dockerVersion()
    if (!docker)
      return {
        state: 'missing',
        version: null,
        via: 'docker',
        detail: 'Docker daemon is not available.',
        command: null,
      }
    const present = await dockerImagePresent(image)
    return present
      ? { state: 'ready', version: null, via: 'docker', detail: image, command }
      : {
          state: 'available',
          version: null,
          via: 'docker',
          detail: `${image} (pulled on first use)`,
          command,
        }
  }

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: 'playwright',
    name: 'Playwright',
    group: 'Browser',
    optional: false,
    probe: npmTool('playwright', 'node scripts using `playwright`', true),
  },
  {
    id: 'playwright-mcp',
    name: 'Playwright MCP (AI browser)',
    group: 'Browser',
    optional: false,
    probe: npmTool('@playwright/mcp', null, true),
  },
  {
    id: 'lighthouse',
    name: 'Lighthouse',
    group: 'Performance',
    optional: true,
    probe: npmTool('lighthouse', 'lighthouse', true),
  },
  {
    id: 'linkinator',
    name: 'Linkinator',
    group: 'SEO / crawl',
    optional: true,
    probe: npmTool('linkinator', 'linkinator'),
  },
  {
    id: 'axe-core',
    name: 'axe-core',
    group: 'Accessibility',
    optional: true,
    probe: npmTool('@axe-core/playwright', 'node scripts using `@axe-core/playwright`', true),
  },
  {
    id: 'cheerio',
    name: 'Cheerio (HTML parsing)',
    group: 'SEO / crawl',
    optional: true,
    probe: npmTool('cheerio', 'node scripts using `cheerio`'),
  },
  {
    id: 'katana',
    name: 'Katana',
    group: 'SEO / crawl',
    optional: true,
    probe: binaryTool('katana', ['-version'], 'katana -u <url> -d 2 -jc -rl 5 -silent -o tools/katana.txt'),
  },
  {
    id: 'httpx',
    name: 'httpx',
    group: 'Technology',
    optional: true,
    probe: binaryTool(
      'httpx',
      ['-version'],
      'httpx -u <url> -td -title -status-code -tls-grab -json -silent',
    ),
  },
  {
    id: 'pa11y',
    name: 'Pa11y',
    group: 'Accessibility',
    optional: true,
    probe: async () => {
      const version = packageVersion('pa11y')
      return version
        ? { state: 'ready', version, via: 'npm (project-local)', detail: null, command: 'pa11y' }
        : {
            state: 'missing',
            version: null,
            via: null,
            detail: 'Not installed; axe-core covers automated accessibility checks.',
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
        : { state: 'missing', version: null, via: null, detail: null, command: null }
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
        ? { state: 'ready', version, via: 'system', detail: null, command: 'docker' }
        : {
            state: 'missing',
            version: null,
            via: null,
            detail: 'Docker daemon not reachable.',
            command: null,
          }
    },
  },
  {
    id: 'testssl',
    name: 'testssl.sh',
    group: 'Security',
    optional: true,
    probe: dockerTool(
      'drwetter/testssl.sh:latest',
      'docker run --rm drwetter/testssl.sh --quiet --jsonfile-pretty /dev/stdout <host>',
    ),
  },
  {
    id: 'zap',
    name: 'OWASP ZAP (baseline, passive)',
    group: 'Security',
    optional: true,
    probe: dockerTool(
      'zaproxy/zap-stable:latest',
      'docker run --rm zaproxy/zap-stable zap-baseline.py -t <url>',
    ),
  },
  {
    id: 'nuclei',
    name: 'Nuclei',
    group: 'Security',
    optional: true,
    probe: async () => ({
      state: 'disabled',
      version: null,
      via: null,
      detail: 'Disabled by default: active scanning is out of scope for public-target audits.',
      command: null,
    }),
  },
  {
    id: 'claude',
    name: 'Claude Code (AI runtime)',
    group: 'AI',
    optional: false,
    probe: async () => {
      const config = getConfig()
      if (config.AUDIVRA_AI === 'off') {
        return {
          state: 'disabled',
          version: null,
          via: 'cli',
          detail: 'AI disabled (AUDIVRA_AI=off).',
          command: null,
        }
      }
      const version = await probeVersion(config.CLAUDE_BIN, ['--version'])
      if (!version)
        return {
          state: 'missing',
          version: null,
          via: 'cli',
          detail: 'Claude Code CLI not found on PATH.',
          command: null,
        }
      const auth = await runProcess({
        command: config.CLAUDE_BIN,
        args: ['auth', 'status'],
        timeoutMs: 15000,
      })
      try {
        const parsed = JSON.parse(auth.stdout) as {
          loggedIn?: boolean
          authMethod?: string
          subscriptionType?: string
        }
        if (!parsed.loggedIn)
          return {
            state: 'error',
            version,
            via: 'cli',
            detail: 'Not logged in. Run `claude auth login`.',
            command: null,
          }
        const plan = parsed.subscriptionType ? ` (${parsed.subscriptionType})` : ''
        return {
          state: 'ready',
          version,
          via: 'cli',
          detail: `Authenticated via ${parsed.authMethod ?? 'unknown'}${plan}`,
          command: null,
        }
      } catch {
        return { state: 'ready', version, via: 'cli', detail: 'Authentication status unknown', command: null }
      }
    },
  },
]

let cache: { at: number; value: SystemStatus } | undefined
let inflight: Promise<SystemStatus> | undefined

/** Probes every registered tool. Results are cached for a few minutes because probes spawn processes. */
export async function getSystemStatus(options: { refresh?: boolean } = {}): Promise<SystemStatus> {
  if (!options.refresh && cache && Date.now() - cache.at < 5 * 60_000) return cache.value
  if (options.refresh) dockerAvailable = undefined
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
