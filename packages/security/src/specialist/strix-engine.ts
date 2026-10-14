import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { SpecialistArtifact, SpecialistAvailability, SpecialistCompletion, SpecialistVulnerability } from '@audivra/contracts'
import { SPECIALIST_ARTIFACT_SCHEMA_VERSION } from '@audivra/contracts'
import { dockerImagePresent, runProcess } from '@audivra/tool-runtime'
import { SPECIALIST_ADAPTER_VERSION, strixLaunchEnv, strixVersionPin } from './config.ts'
import type { SpecialistCleanupResult, SpecialistEngine, SpecialistRunContext } from './engine.ts'

/*
 * Phase 6D — the REAL Strix adapter (reviewed, pinned, Apache-2.0; https://github.com/usestrix/strix). It is
 * gated: it is only reachable when STRIX_ENABLED, Docker is present, a provider profile is configured, and the
 * installed CLI matches the pinned version. Live-target modes additionally require an operator-proven
 * containment spike (STRIX_LIVE_CONTAINMENT_PROVEN) — otherwise only source-only runs are offered. The CLI is
 * launched as an Audivra-OWNED subprocess (process tree terminated by killOwnedForExecution) with a
 * per-execution container-name prefix; Audivra constructs every flag — no raw args from a model/user. This
 * code is never exercised by the normal test suite (the fake engine carries CI); only the optional, explicitly
 * configured real-Strix fixture test runs it.
 */

const RUN_PREFIX = (executionId: string) => `audivra-${executionId}-`

export class StrixSpecialistEngine implements SpecialistEngine {
  readonly id = 'strix' as const

  async availability(opts: { providerConfigured: boolean; dockerAvailable: boolean }): Promise<SpecialistAvailability> {
    const pin = strixVersionPin()
    const base = { engine: 'strix' as const, pin, dockerAvailable: opts.dockerAvailable, providerConfigured: opts.providerConfigured, enabledModes: [] as SpecialistAvailability['enabledModes'], checkedAt: new Date().toISOString() }
    const installed = await strixCliVersion()
    if (!installed) return { ...base, state: 'missing', installedVersion: null, reason: 'The strix CLI is not installed (run the explicit specialist setup).' }
    if (!opts.dockerAvailable) return { ...base, state: 'docker-unavailable', installedVersion: installed, reason: 'Docker is not available for the Strix sandbox.' }
    if (!opts.providerConfigured) return { ...base, state: 'provider-not-configured', installedVersion: installed, reason: 'No Strix LLM provider profile is configured.' }
    if (!pin.cliVersion) return { ...base, state: 'needs-setup', installedVersion: installed, reason: 'No approved Strix version is pinned (review and pin at setup).' }
    if (pin.cliVersion !== installed) return { ...base, state: 'version-mismatch', installedVersion: installed, reason: `Installed ${installed} does not match the pinned ${pin.cliVersion}; explicit review required.` }
    if (pin.sandboxImage && !(await dockerImagePresent(pin.sandboxImage))) return { ...base, state: 'needs-setup', installedVersion: installed, reason: 'The pinned Strix sandbox image is not present (run setup; no implicit pulls).' }
    return { ...base, state: 'ready', installedVersion: installed, enabledModes: ['source-only'], reason: 'Strix is installed, pinned and provider-configured (source-only; live modes require a proven containment spike).' }
  }

  async run(ctx: SpecialistRunContext): Promise<SpecialistArtifact> {
    const runsDir = path.join(ctx.workspaceDir, 'strix_runs')
    // Audivra builds every flag. No raw args/instructions are accepted from a model/user.
    const args = ['-n', '--scan-mode', ctx.config.budget.scanMode, '--runs-dir', runsDir]
    for (const target of ctx.config.targets) if (target.inScope) args.push('-t', target.value)
    const containerName = `${RUN_PREFIX(ctx.executionId)}sandbox`
    const result = await runProcess({
      command: 'strix',
      args,
      cwd: ctx.workspaceDir,
      env: { ...strixLaunchEnv(), STRIX_CONTAINER_NAME: containerName },
      timeoutMs: ctx.config.budget.wallClockMs,
      signal: ctx.signal,
      owner: { tool: 'strix', securityExecutionId: ctx.executionId, containerName },
      buffer: true,
    })
    const completion: SpecialistCompletion = result.cancelled ? 'cancelled' : result.timedOut ? 'budget-stopped' : result.failed && result.exitCode !== 1 ? 'failed' : 'completed'
    const vulnerabilities = await readStrixResults(runsDir).catch(() => [])
    return {
      schemaVersion: SPECIALIST_ARTIFACT_SCHEMA_VERSION,
      engine: 'strix',
      engineVersion: (await strixCliVersion()) ?? 'unknown',
      runId: ctx.executionId,
      mode: ctx.config.mode,
      completion: completion === 'failed' && vulnerabilities.length ? 'partial' : completion,
      coverageNote: `Strix ${ctx.config.budget.scanMode} run exited ${result.exitCode ?? 'null'} in ${Math.round(result.durationMs / 1000)}s.`,
      vulnerabilities,
      providerMeta: { model: ctx.config.providerProfileId, costUsd: null, turns: null },
    }
  }

  async cleanup(ctx: { executionId: string }): Promise<SpecialistCleanupResult> {
    // Remove EXACTLY this execution's owned containers by name prefix (never a global prune / wildcard kill).
    const prefix = RUN_PREFIX(ctx.executionId)
    const removed: string[] = []
    const unownedFound: string[] = []
    try {
      const listed = await runProcess({ command: 'docker', args: ['ps', '-a', '--filter', `name=^${prefix}`, '--format', '{{.Names}}'], timeoutMs: 15_000 })
      for (const name of listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
        if (!name.startsWith(prefix)) { unownedFound.push(name); continue }
        await runProcess({ command: 'docker', args: ['rm', '-f', name], timeoutMs: 30_000 })
        removed.push(name)
      }
    } catch {
      // Docker may be gone; the owned-process registry already tree-killed the CLI on cancel/timeout.
    }
    return { removed, unownedFound }
  }
}

async function strixCliVersion(): Promise<string | null> {
  try {
    const r = await runProcess({ command: 'strix', args: ['--version'], timeoutMs: 10_000 })
    if (r.failed) return null
    const m = r.stdout.match(/\d+\.\d+\.\d+/)
    return m ? m[0] : r.stdout.trim().slice(0, 40) || null
  } catch {
    return null
  }
}

/**
 * Parse the pinned-version structured results under `strix_runs/<run>`. Prefer structured output; never parse
 * the terminal UI. The exact field mapping is reviewed per pinned version — this reads a results JSON array of
 * vulnerabilities defensively and drops anything that is not structured.
 */
async function readStrixResults(runsDir: string): Promise<SpecialistVulnerability[]> {
  const runs = await readdir(runsDir, { withFileTypes: true }).catch(() => [])
  const out: SpecialistVulnerability[] = []
  for (const dir of runs.filter((d) => d.isDirectory())) {
    for (const name of ['vulnerabilities.json', 'results.json', 'findings.json']) {
      const file = path.join(runsDir, dir.name, name)
      if (!(await stat(file).then((s) => s.isFile()).catch(() => false))) continue
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
      const items = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { vulnerabilities?: unknown })?.vulnerabilities) ? (parsed as { vulnerabilities: unknown[] }).vulnerabilities : []
      for (const [i, raw] of items.entries()) out.push(mapNative(raw as Record<string, unknown>, `${dir.name}-${i}`))
    }
  }
  return out
}

function mapNative(raw: Record<string, unknown>, fallbackId: string): SpecialistVulnerability {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    nativeId: str(raw.id) ?? str(raw.uuid) ?? fallbackId,
    title: str(raw.title) ?? str(raw.name) ?? 'Specialist result',
    nativeSeverity: str(raw.severity) ?? 'unknown',
    nativeCategory: str(raw.category) ?? str(raw.owasp) ?? str(raw.cwe) ?? 'uncategorized',
    engineValidated: raw.validated === true || raw.verified === true,
    affected: { url: str(raw.url) ?? str((raw.target as Record<string, unknown>)?.url), sourcePath: str(raw.file) ?? str(raw.path), apiOperation: str(raw.operation), assetHint: str(raw.asset) },
    evidence: [],
    description: str(raw.description) ?? '',
    reproduction: str(raw.reproduction) ?? str(raw.poc),
  }
}

export { SPECIALIST_ADAPTER_VERSION }
