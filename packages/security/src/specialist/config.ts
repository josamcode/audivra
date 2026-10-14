import type { SpecialistBudget, SpecialistMode, SpecialistVersionPin } from '@audivra/contracts'

/*
 * Phase 6D — the trusted, AI-invisible specialist configuration. Everything here is resolved OUTSIDE
 * AI-visible state and NEVER placed into events, artifacts, the graph or a model prompt. Secrets (the LLM
 * provider key) are read from the environment only when launching the engine subprocess; only a profile id
 * and a model label are ever persisted. Audivra does not auto-upgrade: the engine version is pinned at setup
 * and a mismatch requires explicit review.
 */

export const SPECIALIST_ADAPTER_VERSION = 'audivra.strix-adapter.v1'

/** Whether the specialist engine is enabled at all (off by default — a missing integration degrades gracefully). */
export function specialistEnabled(): boolean {
  return (process.env.STRIX_ENABLED ?? '').toLowerCase() === 'true' || process.env.STRIX_ENABLED === '1'
}

/** The reviewed, pinned version. `cliVersion`/`sandboxImage` are set at setup time; unset means "needs setup". */
export function strixVersionPin(): SpecialistVersionPin {
  return {
    engine: 'strix',
    cliVersion: process.env.STRIX_PINNED_CLI_VERSION ?? '',
    sandboxImage: process.env.STRIX_PINNED_SANDBOX_IMAGE ?? null,
    adapterVersion: SPECIALIST_ADAPTER_VERSION,
  }
}

/** The trusted provider profile — a profile id + model label only. The key is read at launch, never returned. */
export interface ProviderProfile {
  id: string | null
  model: string | null
  configured: boolean
}
export function strixProviderProfile(): ProviderProfile {
  const model = process.env.STRIX_LLM ?? null
  const hasKey = !!process.env.STRIX_LLM_API_KEY || !!process.env.LLM_API_KEY
  return { id: model ? 'strix-default' : null, model, configured: !!model && hasKey }
}

/** Resolve the actual launch env for the engine subprocess (secrets included) — NEVER logged or persisted. */
export function strixLaunchEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  if (process.env.STRIX_LLM) env.STRIX_LLM = process.env.STRIX_LLM
  const key = process.env.STRIX_LLM_API_KEY ?? process.env.LLM_API_KEY
  if (key) env.LLM_API_KEY = key
  if (process.env.STRIX_LLM_API_BASE) env.LLM_API_BASE = process.env.STRIX_LLM_API_BASE
  // Privacy: keep optional external integrations/telemetry off by default (§44/§45).
  env.STRIX_DISABLE_TELEMETRY = '1'
  env.STRIX_CLOUD = '0'
  return env
}

/** Whether live-target containment has been PROVEN (by an operator-run spike) — false fails closed. */
export function liveContainmentProven(): boolean {
  return process.env.STRIX_LIVE_CONTAINMENT_PROVEN === '1'
}

/** Audivra-derived budget for a mode (deterministic from policy; never a model/user-supplied raw flag). */
export function budgetFor(mode: SpecialistMode, environment: string | null): SpecialistBudget {
  const deep = environment === 'isolated-lab'
  return {
    wallClockMs: (mode === 'source-only' ? 15 : deep ? 45 : 25) * 60_000,
    maxTurns: mode === 'source-only' ? 40 : 80,
    maxCostUsd: mode === 'source-only' ? 5 : 15,
    maxArtifactBytes: 32 * 1_048_576,
    scanMode: mode === 'source-only' ? 'standard' : deep ? 'deep' : 'quick',
  }
}
