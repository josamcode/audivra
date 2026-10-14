import { statfsSync } from 'node:fs'
import { AUDIVRA_VERSION, getConfig, securityDir } from '@audivra/config'
import type { OwnedResourceInventory, SystemCheck, SystemDiagnostics, ToolVersionStatus } from '@audivra/contracts'
import { countActiveSecurityExecutions, listUnfinishedSecurityExecutions, pingDb, type Db } from '@audivra/database'
import { dockerVersion, liveOwnedProcesses, runProcess } from '@audivra/tool-runtime'
import { directorySize } from '../resources.ts'
import { sensorRuntimeStatuses } from '../sensors/availability.ts'
import { specialistEnabled, strixProviderProfile, strixVersionPin } from '../specialist/config.ts'

/*
 * Phase 6F — deterministic environment diagnostics shared by `pnpm doctor` and the System → Health view.
 * It reuses the existing status primitives (DB ping, Docker probe, disk check, sensor approved-vs-installed,
 * owned-process registry, execution counts) and reports each requirement with an explanation, consequence and
 * remediation. It reads only; it never installs, pulls, prunes or mutates anything.
 */

const check = (id: string, label: string, required: boolean, state: SystemCheck['state'], detail: string, consequence: string, remediation: string): SystemCheck => ({ id, label, required, state, detail, consequence, remediation })

export async function collectDiagnostics(options: { db: Db; now?: () => Date }): Promise<SystemDiagnostics> {
  const now = options.now ?? (() => new Date())
  const config = getConfig()
  const checks: SystemCheck[] = []

  // Database + migrations.
  let dbOk = false
  try {
    const latency = await pingDb(options.db)
    dbOk = true
    checks.push(check('database', 'PostgreSQL', true, 'ready', `Reachable (${latency} ms).`, 'Audivra cannot store or read any assessment state.', ''))
  } catch (error) {
    checks.push(check('database', 'PostgreSQL', true, 'unavailable', error instanceof Error ? error.message : 'unreachable', 'Audivra cannot run at all.', 'Start PostgreSQL (or `docker compose up -d db`) and set DATABASE_URL in .env, then `pnpm run setup`.'))
  }
  if (dbOk) {
    try {
      // Touch a security table through an existing repo read; a missing security schema throws.
      await countActiveSecurityExecutions(options.db)
      checks.push(check('migrations', 'Database migrations', true, 'ready', 'Security schema present.', 'Security features are unavailable.', ''))
    } catch {
      checks.push(check('migrations', 'Database migrations', true, 'needs-setup', 'Security tables are missing.', 'Security features are unavailable.', 'Run `pnpm run setup` (or `pnpm db:migrate`) to apply migrations.'))
    }
  }

  // Docker (needed for isolated sensors + the specialist; comparisons/research work without it).
  const docker = await dockerVersion().catch(() => null)
  checks.push(docker ? check('docker', 'Docker', false, 'ready', `Docker ${docker}.`, '', '') : check('docker', 'Docker', false, 'unavailable', 'Docker is not running.', 'Isolated sensors and the specialist engine cannot run; authorization/business comparisons and the research loop still work.', 'Start Docker Desktop / the Docker daemon.'))

  // Disk.
  const data = securityDir()
  let freeMb = Number.POSITIVE_INFINITY
  try {
    const s = statfsSync(data)
    freeMb = (Number(s.bavail) * Number(s.bsize)) / 1_048_576
  } catch { /* path may not exist yet */ }
  const minMb = config.SECURITY_MIN_FREE_DISK_MB
  checks.push(freeMb >= minMb ? check('disk', 'Disk space', true, 'ready', `${Math.round(freeMb)} MB free (min ${minMb} MB).`, '', '') : check('disk', 'Disk space', true, freeMb < minMb / 2 ? 'unavailable' : 'needs-setup', `${Math.round(freeMb)} MB free, below the ${minMb} MB floor.`, 'Security executions are refused when free disk is below the floor.', 'Free disk space or run the Audivra disk cleanup (owned artifacts/workspaces only).'))

  // Vault key.
  const hasKey = !!config.AUDIVRA_SECRET_KEY || !!config.AUDIVRA_SECRET_KEY_FILE
  checks.push(check('vault', 'Credential vault key', true, 'ready', hasKey ? 'A configured key is set.' : 'Using the persisted local dev key.', 'Identity-aware execution and session establishment are unavailable.', hasKey ? '' : 'For production, set AUDIVRA_SECRET_KEY (or _FILE) and keep it OUT of database backups.'))

  // AI provider (optional — deterministic verification degrades gracefully).
  const aiOn = config.AUDIVRA_AI !== 'off'
  checks.push(check('ai-provider', 'AI provider', false, aiOn ? 'ready' : 'optional', aiOn ? `Preferred: ${config.AI_PROVIDER}.` : 'AI is disabled.', 'AI reasoning (hypotheses, research planning, finding prose) is unavailable; deterministic analysis and verification still work.', aiOn ? '' : 'Set AUDIVRA_AI=claude and configure a provider to enable AI reasoning.'))

  // Specialist (Strix) — optional.
  const strix = strixProviderProfile()
  const strixState: SystemCheck['state'] = !specialistEnabled() ? 'optional' : !docker ? 'unavailable' : !strix.configured ? 'needs-setup' : !strixVersionPin().cliVersion ? 'needs-setup' : 'ready'
  checks.push(check('specialist', 'Specialist engine (Strix)', false, strixState, !specialistEnabled() ? 'Disabled (STRIX_ENABLED not set).' : `enabled; provider ${strix.configured ? 'configured' : 'not configured'}.`, 'Optional deep specialist research is unavailable; all core capabilities still work.', strixState === 'ready' || strixState === 'optional' ? '' : 'Run `pnpm setup:strix` and configure a provider; live-target modes also require a proven containment spike.'))

  // Owned-resource inventory (reported, never auto-cleaned here).
  const [activeExecutions, unfinished] = dbOk ? await Promise.all([countActiveSecurityExecutions(options.db).catch(() => 0), listUnfinishedSecurityExecutions(options.db).catch(() => [])]) : [0, []]
  const ownedContainers = docker ? await ownedContainerNames() : []
  const resources: OwnedResourceInventory = {
    storageBytes: await directorySize(data).catch(() => 0),
    dataDir: data,
    ownedProcesses: liveOwnedProcesses().length,
    ownedContainers,
    ownedNetworks: docker ? await ownedNetworkNames() : [],
    activeExecutions,
    unfinishedExecutions: unfinished.length,
  }

  const tools: ToolVersionStatus[] = (await sensorRuntimeStatuses().catch(() => [])).map((t) => ({ name: t.name, approved: t.version ?? null, installed: t.state === 'ready' ? (t.version ?? null) : null, state: t.state === 'ready' ? 'ready' : t.state === 'unavailable' ? 'unavailable' : 'needs-setup', match: t.state === 'ready' }))

  const required = checks.filter((c) => c.required)
  const overall: SystemDiagnostics['overall'] = required.some((c) => c.state === 'unavailable' || c.state === 'misconfigured') ? 'blocked' : checks.some((c) => c.state !== 'ready' && c.state !== 'optional') ? 'degraded' : 'ready'
  return { version: AUDIVRA_VERSION, checkedAt: now().toISOString(), overall, checks, tools, resources }
}

/** Audivra-owned containers only (name-prefixed `audivra-`), reported for the disk/leak views. Never removed here. */
async function ownedContainerNames(): Promise<string[]> {
  const r = await runProcess({ command: 'docker', args: ['ps', '-a', '--filter', 'name=^audivra-', '--format', '{{.Names}}'], timeoutMs: 15_000 }).catch(() => null)
  return r && !r.failed ? r.stdout.split('\n').map((l) => l.trim()).filter((n) => /^audivra-[a-z0-9-]+$/.test(n)) : []
}
async function ownedNetworkNames(): Promise<string[]> {
  const r = await runProcess({ command: 'docker', args: ['network', 'ls', '--filter', 'name=^audivra-', '--format', '{{.Name}}'], timeoutMs: 15_000 }).catch(() => null)
  return r && !r.failed ? r.stdout.split('\n').map((l) => l.trim()).filter((n) => /^audivra-[a-z0-9-]+$/.test(n)) : []
}
