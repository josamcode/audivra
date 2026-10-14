import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SpecialistArtifact, SpecialistAvailability, SpecialistCompletion, SpecialistVulnerability } from '@audivra/contracts'
import { SPECIALIST_ARTIFACT_SCHEMA_VERSION } from '@audivra/contracts'
import { SPECIALIST_ADAPTER_VERSION } from './config.ts'
import type { SpecialistCleanupResult, SpecialistEngine, SpecialistRunContext } from './engine.ts'

/*
 * Phase 6D — a deterministic fake specialist engine implementing the EXACT same adapter contract as the real
 * Strix engine. It needs no Docker and no LLM provider, so the unit tests, most integration tests and CI run
 * the whole specialist lifecycle (authority → run → artifacts → ingestion → verification boundary → cleanup)
 * without paid AI or external processes. A scenario can be scripted to exercise ingestion, dedupe, partial /
 * budget-stopped / provider-unavailable runs and out-of-scope results.
 */

export interface FakeSpecialistScenario {
  availability?: Partial<SpecialistAvailability>
  completion?: SpecialistCompletion
  vulnerabilities?: SpecialistVulnerability[]
  /** When set, run() waits (abortable) this long before returning — to exercise cancellation. */
  delayMs?: number
  /** Simulate the engine refusing/failing to reach its provider (honest, never "clean"). */
  providerUnavailable?: boolean
}

export class FakeSpecialistEngine implements SpecialistEngine {
  readonly id = 'strix' as const
  readonly #scenario: FakeSpecialistScenario

  constructor(scenario: FakeSpecialistScenario = {}) {
    this.#scenario = scenario
  }

  async availability(opts: { dockerAvailable: boolean; providerConfigured: boolean }): Promise<SpecialistAvailability> {
    return {
      engine: 'strix',
      state: 'ready',
      installedVersion: 'fake-1',
      pin: { engine: 'strix', cliVersion: 'fake-1', sandboxImage: null, adapterVersion: SPECIALIST_ADAPTER_VERSION },
      dockerAvailable: opts.dockerAvailable,
      providerConfigured: opts.providerConfigured,
      enabledModes: ['source-only'],
      reason: 'Deterministic fake specialist engine (no Docker, no provider).',
      checkedAt: new Date().toISOString(),
      ...this.#scenario.availability,
    }
  }

  async run(ctx: SpecialistRunContext): Promise<SpecialistArtifact> {
    if (this.#scenario.delayMs) await abortableDelay(this.#scenario.delayMs, ctx.signal)
    const completion: SpecialistCompletion = this.#scenario.providerUnavailable ? 'provider-unavailable' : (this.#scenario.completion ?? 'completed')
    const vulnerabilities = completion === 'provider-unavailable' ? [] : (this.#scenario.vulnerabilities ?? [])
    const artifact: SpecialistArtifact = {
      schemaVersion: SPECIALIST_ARTIFACT_SCHEMA_VERSION,
      engine: 'strix',
      engineVersion: 'fake-1',
      runId: ctx.executionId,
      mode: ctx.config.mode,
      completion,
      coverageNote: completion === 'completed' ? 'Fake engine completed its scripted scenario.' : `Fake engine ended: ${completion}.`,
      vulnerabilities,
      providerMeta: { model: ctx.config.providerProfileId ? 'fake-model' : null, costUsd: completion === 'provider-unavailable' ? 0 : 0.01, turns: completion === 'provider-unavailable' ? 0 : 3 },
    }
    // Write the structured artifact into the execution-owned workspace, exactly like the real adapter would.
    await writeFile(path.join(ctx.workspaceDir, 'strix-artifact.json'), JSON.stringify(artifact, null, 2), 'utf8').catch(() => undefined)
    return artifact
  }

  async cleanup(): Promise<SpecialistCleanupResult> {
    // The fake engine owns no processes or containers.
    return { removed: [], unownedFound: [] }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')) }, { once: true })
  })
}

/** A convenience builder for a scripted native vulnerability (used by tests/benchmarks). */
export function fakeVuln(over: Partial<SpecialistVulnerability> & { nativeId: string; title: string }): SpecialistVulnerability {
  return {
    nativeSeverity: 'high',
    nativeCategory: 'A01:Broken Access Control',
    engineValidated: true,
    affected: { url: null, sourcePath: null, apiOperation: null, assetHint: null },
    evidence: [],
    description: 'A specialist result (untrusted external-tool output).',
    reproduction: null,
    ...over,
  }
}
