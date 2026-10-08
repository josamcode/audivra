import { z } from 'zod'
import type { CapabilityBroker } from './broker.ts'
import { deepFreeze } from './freeze.ts'
import { untrustedBlock, type UntrustedBlock } from './trust.ts'

/*
 * The seam between AI agents and security execution. A future security MCP tool must call
 * `AgentCapabilityGateway.request` — never an executor, `runProcess`, Bash or the browser directly.
 *
 * - The engagement and agent run are bound by the platform when the agent starts (`AgentBinding`);
 *   they are never read from model output.
 * - Model arguments may contain only `capabilityId`, `input` and an optional `rationale`. Any other
 *   field (engagementId, scope, environment, authorized, policy, …) rejects the whole request, and the
 *   rejection is recorded in the security audit trail.
 * - Results go back to the model as untrusted data.
 */

export const AgentCapabilityRequest = z.strictObject({
  capabilityId: z.string().min(1).max(120),
  input: z.unknown(),
  /** Why the agent wants this (recorded, never used for decisions). */
  rationale: z.string().max(1000).optional(),
})

export interface AgentBinding {
  engagementId: string
  agentRunId: string
}

export interface AgentCapabilityResponse {
  status: 'rejected' | 'denied' | 'completed' | 'failed' | 'cancelled'
  executionId: string
  rule: string
  reason: string
  /** Capability output, wrapped as untrusted target data. */
  output: UntrustedBlock | null
  evidenceRefs: string[]
}

export class AgentCapabilityGateway {
  readonly #binding: Readonly<AgentBinding>

  constructor(
    private readonly broker: CapabilityBroker,
    binding: AgentBinding,
  ) {
    this.#binding = deepFreeze({ ...binding })
  }

  /** Capabilities the agent may request, described from registry metadata. */
  capabilities() {
    return this.broker.registry.describeForAgents()
  }

  async request(args: unknown, signal?: AbortSignal): Promise<AgentCapabilityResponse> {
    const actor = { kind: 'agent' as const, id: null, agentRunId: this.#binding.agentRunId }
    const parsed = AgentCapabilityRequest.safeParse(args)
    if (!parsed.success) {
      const reason = `Rejected agent request: ${parsed.error.issues.map((i) => (i.code === 'unrecognized_keys' ? `fields ${i.keys.join(', ')} are not allowed` : `${i.path.join('.') || 'request'} ${i.message}`)).join('; ')}`
      const decision = await this.broker.reject(this.#binding.engagementId, actor, 'agent.request-invalid', reason)
      return { status: 'rejected', executionId: decision.executionId, rule: decision.rule, reason, output: null, evidenceRefs: [] }
    }
    const outcome = await this.broker.execute(
      { engagementId: this.#binding.engagementId, capabilityId: parsed.data.capabilityId, input: parsed.data.input, actor },
      { signal },
    )
    return {
      status: outcome.status,
      executionId: outcome.executionId,
      rule: outcome.decision.rule,
      reason: outcome.status === 'completed' ? (outcome.summary ?? outcome.decision.reason) : (outcome.error ?? outcome.decision.reason),
      output: outcome.status === 'completed' ? untrustedBlock('capability-output', outcome.output, parsed.data.capabilityId) : null,
      evidenceRefs: outcome.evidence.map((e) => e.ref),
    }
  }
}
