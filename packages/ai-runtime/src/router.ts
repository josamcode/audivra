import type { AiRunProvenance, AiTaskOutcome, AiTaskSpec, ProviderCapabilities, ProviderConsideration, ProviderRequirements, ProviderSelection } from '@audivra/contracts'
import { classifyOutcome, isRefusal, isRetryableOutcome } from './outcomes.ts'
import type { AgentProvider, AgentRunResult } from './provider.ts'
import type { ProviderRegistry } from './registry.ts'

/*
 * Deterministic provider selection and bounded resilience. The security/audit domain hands the router a
 * task spec and an executor that knows how to run a provider; the router decides WHICH provider (by
 * configured preference, capability match and live health), records the decision and reason, and manages
 * retry/fallback.
 *
 * The one rule that is not a tuning knob: a policy refusal (`provider-refused`) stops immediately and is
 * never rerouted to another provider to evade the refusal. Only transient outcomes may fall back to the
 * next eligible provider, bounded by `maxAttempts`.
 */

export interface RouterEvent {
  type: 'ai.task-created' | 'ai.provider-selected' | 'ai.started' | 'ai.completed' | 'ai.refused' | 'ai.unavailable' | 'ai.failed' | 'ai.cancelled'
  message: string
  data?: Record<string, unknown>
}

/** Runs one provider for the task; the caller builds the provider-specific request from the spec. */
export type RouterExecutor = (provider: AgentProvider) => Promise<AgentRunResult>

export interface RouteOptions {
  promptVersion?: string | null
  onEvent?: (event: RouterEvent) => void
  /** Max provider attempts (bounded transient fallback). Default 2. */
  maxAttempts?: number
}

function meetsRequirements(caps: ProviderCapabilities, reqs: ProviderRequirements, taskType: AiTaskSpec['taskType']): { ok: boolean; reason: string } {
  if (!caps.taskTypes.includes(taskType)) return { ok: false, reason: `not eligible for ${taskType}` }
  if (reqs.structuredOutput && !caps.structuredOutput) return { ok: false, reason: 'no structured output' }
  if (reqs.toolUse && !caps.toolUse) return { ok: false, reason: 'no tool use' }
  if (reqs.sessionResume && !caps.sessionResume) return { ok: false, reason: 'no session resume' }
  if (reqs.minContextTokens && caps.maxContextTokens !== null && caps.maxContextTokens < reqs.minContextTokens) return { ok: false, reason: 'context window too small' }
  return { ok: true, reason: 'capability match' }
}

export class ProviderRouter {
  readonly #registry: ProviderRegistry
  readonly #preferred: string | null
  readonly #now: () => Date

  constructor(options: { registry: ProviderRegistry; preferredProviderId?: string | null; now?: () => Date }) {
    this.#registry = options.registry
    this.#preferred = options.preferredProviderId ?? null
    this.#now = options.now ?? (() => new Date())
  }

  /** Providers in preference order: the configured preferred id first, then registration order. */
  #ordered(): AgentProvider[] {
    const all = this.#registry.list()
    if (!this.#preferred) return all
    const preferred = all.filter((p) => p.id === this.#preferred)
    return [...preferred, ...all.filter((p) => p.id !== this.#preferred)]
  }

  /**
   * Resolve which healthy, capable providers can serve the task, in order. Returns the ordered runnable
   * providers and the full `considered` list (every provider with eligibility + health reason) for audit.
   */
  async select(spec: AiTaskSpec): Promise<{ selection: ProviderSelection; runnable: AgentProvider[] }> {
    const considered: ProviderConsideration[] = []
    const runnable: AgentProvider[] = []
    for (const provider of this.#ordered()) {
      const match = meetsRequirements(provider.capabilities(), spec.requirements, spec.taskType)
      if (!match.ok) {
        considered.push({ providerId: provider.id, eligible: false, reason: match.reason })
        continue
      }
      const health = await provider.health()
      if (health.state === 'ready') {
        considered.push({ providerId: provider.id, eligible: true, reason: 'ready' })
        runnable.push(provider)
      } else {
        considered.push({ providerId: provider.id, eligible: true, reason: `capable but ${health.state}${health.detail ? `: ${health.detail}` : ''}` })
      }
    }
    const chosen = runnable[0] ?? null
    const selection: ProviderSelection = {
      taskType: spec.taskType,
      providerId: chosen?.id ?? null,
      model: null,
      reason: chosen ? `selected ${chosen.id} (preferred/first ready and capable)` : 'no capable, ready provider is available',
      considered,
      at: this.#now().toISOString(),
    }
    return { selection, runnable }
  }

  async run(spec: AiTaskSpec, exec: RouterExecutor, options: RouteOptions = {}): Promise<AiTaskOutcome> {
    const emit = options.onEvent ?? (() => undefined)
    const maxAttempts = Math.max(1, options.maxAttempts ?? 2)
    emit({ type: 'ai.task-created', message: `AI task ${spec.taskType} (${spec.role}) created`, data: { taskType: spec.taskType, role: spec.role } })

    const { selection, runnable } = await this.select(spec)
    emit({ type: 'ai.provider-selected', message: selection.reason, data: { providerId: selection.providerId, considered: selection.considered } })

    if (runnable.length === 0) {
      // Case D: no eligible, healthy provider. The task is unresolved — recorded, never "secure".
      emit({ type: 'ai.unavailable', message: 'No eligible AI provider is available; the task was not run', data: { taskType: spec.taskType } })
      return { outcome: 'provider-unavailable', output: null, selection, provenance: [], attempts: 0, refused: false }
    }

    const provenance: AiRunProvenance[] = []
    let attempts = 0
    let lastOutcome: AiTaskOutcome['outcome'] = 'provider-unavailable'
    for (const provider of runnable.slice(0, maxAttempts)) {
      attempts++
      const startedAt = this.#now().toISOString()
      emit({ type: 'ai.started', message: `Running ${spec.role} on ${provider.id}`, data: { providerId: provider.id, attempt: attempts } })
      const result = await exec(provider)
      const outcome = classifyOutcome(result)
      lastOutcome = outcome
      provenance.push({
        taskType: spec.taskType,
        role: spec.role,
        providerId: provider.id,
        model: result.model,
        adapterVersion: provider.adapterVersion,
        promptVersion: options.promptVersion ?? null,
        startedAt,
        finishedAt: this.#now().toISOString(),
        terminationReason: result.terminationReason,
        outcome,
        toolCalls: result.toolCalls ?? {},
        costUsd: result.costUsd,
        tokens: null,
        outputStatus: outcome === 'succeeded' && result.output != null ? 'valid' : 'none',
      })

      if (outcome === 'succeeded') {
        emit({ type: 'ai.completed', message: `${spec.role} completed on ${provider.id}`, data: { providerId: provider.id } })
        return { outcome, output: result.output, selection, provenance, attempts, refused: false }
      }
      if (isRefusal(outcome)) {
        // The provider declined under its own policy. Stop here — never reroute to evade the refusal.
        emit({ type: 'ai.refused', message: `${provider.id} declined ${spec.role} under its own policy`, data: { providerId: provider.id } })
        return { outcome, output: null, selection, provenance, attempts, refused: true }
      }
      if (!isRetryableOutcome(outcome)) {
        // A permanent, non-transient failure (auth, context limit, invalid output, cancelled, internal).
        emit({ type: outcome === 'cancelled' ? 'ai.cancelled' : 'ai.failed', message: `${spec.role} ${outcome} on ${provider.id}`, data: { providerId: provider.id, outcome } })
        return { outcome, output: null, selection, provenance, attempts, refused: false }
      }
      // Transient: fall back to the next eligible, ready provider (bounded by maxAttempts).
      emit({ type: 'ai.failed', message: `${provider.id} ${outcome}; trying the next eligible provider if any`, data: { providerId: provider.id, outcome } })
    }

    emit({ type: 'ai.unavailable', message: `All ${attempts} eligible provider attempt(s) failed transiently (${lastOutcome})`, data: { outcome: lastOutcome } })
    return { outcome: lastOutcome, output: null, selection, provenance, attempts, refused: false }
  }
}
