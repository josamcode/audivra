import type { ProviderCapabilities, ProviderHealth, ProviderHealthState } from '@audivra/contracts'
import type { AgentProvider, AgentRunRequest, AgentRunResult, ProviderAvailability } from '../provider.ts'

/*
 * A deterministic, in-process provider for tests and for proving provider independence. It implements the
 * exact same `AgentProvider` contract as the real adapter, with no network, no process and no Claude
 * specifics. A test scripts its health, capabilities and per-call results, so the router's selection,
 * fallback and refusal behaviour can be exercised exactly.
 */

export interface FakeProviderOptions {
  id: string
  adapterVersion?: string
  capabilities?: Partial<ProviderCapabilities>
  /** Health returned by `health()`; a function is re-evaluated each call (to simulate recovery). */
  health?: ProviderHealthState | (() => ProviderHealthState)
  /** The result for each `run()` call (callIndex starts at 0); defaults are filled in. */
  onRun: (request: AgentRunRequest, callIndex: number) => { status: AgentRunResult['status']; terminationReason: string; output?: unknown; error?: string | null }
}

export class FakeProvider implements AgentProvider {
  readonly id: string
  readonly adapterVersion: string
  #calls = 0
  readonly runRequests: AgentRunRequest[] = []
  readonly #caps: ProviderCapabilities
  readonly #health: () => ProviderHealthState
  readonly #onRun: FakeProviderOptions['onRun']

  constructor(options: FakeProviderOptions) {
    this.id = options.id
    this.adapterVersion = options.adapterVersion ?? 'fake-1'
    this.#onRun = options.onRun
    const h = options.health ?? 'ready'
    this.#health = typeof h === 'function' ? h : () => h
    this.#caps = {
      providerId: this.id,
      structuredOutput: true,
      toolUse: true,
      sessionResume: true,
      browserTools: false,
      maxContextTokens: 100_000,
      effortLevels: ['low', 'standard', 'high'],
      taskTypes: ['security-understand', 'security-plan', 'security-analyze-observations', 'security-verify-claim', 'security-summarize', 'website-audit'],
      ...options.capabilities,
    }
  }

  async isAvailable(): Promise<ProviderAvailability> {
    const state = this.#health()
    return { available: state === 'ready', version: this.adapterVersion, reason: state === 'ready' ? null : state }
  }

  async health(): Promise<ProviderHealth> {
    return { providerId: this.id, state: this.#health(), version: this.adapterVersion, detail: null, checkedAt: new Date().toISOString() }
  }

  capabilities(): ProviderCapabilities {
    return this.#caps
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.runRequests.push(request)
    const scripted = this.#onRun(request, this.#calls++)
    return {
      status: scripted.status,
      output: scripted.output ?? null,
      sessionId: `fake-session-${this.id}`,
      model: `${this.id}-model`,
      numTurns: 1,
      costUsd: null,
      durationMs: 1,
      error: scripted.error ?? (scripted.status === 'completed' ? null : scripted.terminationReason),
      permissionDenials: [],
      usage: null,
      terminationReason: scripted.terminationReason,
      toolCalls: {},
    }
  }
}
