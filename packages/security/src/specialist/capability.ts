import { z } from 'zod'
import { SpecialistMode, type SpecialistPlannerMetadata } from '@audivra/contracts'
import type { SecurityCapability } from '../capabilities/types.ts'

/*
 * Phase 6D — the reviewed Audivra capability that represents specialist research. It exists so the specialist
 * run is AUTHORIZED through Audivra's own broker (scope + authorization + policy + environment) exactly like
 * any other capability, and so the Phase 4/5 planner can propose it as ONE typed capability. It exposes NO
 * raw CLI, flags, prompt or instruction to a model: the only input is the Audivra-constructed in-scope target
 * set and the chosen mode. The capability is never executed directly — the SpecialistRunService drives the
 * engine — so `execute` refuses; its role is the deterministic authority decision (`broker.preflight`).
 */

const Input = z.strictObject({
  /** The Audivra-constructed in-scope target URLs (never model/user raw args). */
  targets: z.array(z.string().trim().min(1).max(2048)).max(64).default([]),
  mode: SpecialistMode.default('source-only'),
})
type Input = z.infer<typeof Input>

export const SPECIALIST_CAPABILITY_ID = 'specialist.strix-research'

export const strixResearchCapability: SecurityCapability<Input, { refused: true }> = {
  metadata: {
    id: SPECIALIST_CAPABILITY_ID,
    version: 1,
    family: 'specialist',
    name: 'Specialist research (Strix)',
    description: 'Authorizes an optional external specialist research engine (Strix) over an Audivra-constructed, in-scope target set. The engine produces structured artifacts that Audivra normalizes into observations and verifies; it never decides scope, findings or paths.',
    // Strix runs a full offensive sandbox — treat it as high impact; production is disabled by policy/service.
    riskClass: 'high-impact',
    sideEffect: 'transient-state',
    supportedEnvironments: ['staging', 'isolated-lab'],
    requiresAuthorization: true,
    requiresIdentity: false,
    // The broker still name-scopes every target Audivra passes (an out-of-scope target is denied). Source-only
    // contacts nothing; live-target network CONTAINMENT is a separate, fail-closed gate (an operator-proven
    // sandbox-network spike), not the broker's DNS check — so this stays false until that gate is in place.
    requiresNetwork: false,
    requiresExternalIntegration: false,
    supportsCancellation: true,
    rateLimitClass: 'heavy',
    resourceProfile: { disk: 'large', containerImage: null, spawnsProcesses: true },
    timeoutProfile: { defaultSeconds: 1500, maxSeconds: 3600 },
    evidenceTypes: ['tool-result'],
    implementation: 'builtin/specialist-strix@1',
  },
  implementation: {
    id: 'builtin/specialist-strix@1',
    input: Input,
    targets: (input) => input.targets,
    // Never run through the generic executor: the SpecialistRunService owns the engine lifecycle. The broker
    // uses this capability only for its authority decision (preflight); execution here is refused.
    async execute() {
      throw new Error('specialist.strix-research is driven by the SpecialistRunService, not the generic executor')
    },
  },
}

export const strixPlannerMetadata: SpecialistPlannerMetadata = {
  engine: 'strix',
  capabilityId: SPECIALIST_CAPABILITY_ID,
  costClass: 'very-high',
  typicalDurationSeconds: 1200,
  supportedTargetKinds: ['staged-source', 'url', 'repository', 'api-spec'],
  requiredEnvironments: ['staging', 'isolated-lab'],
  expectedInformationGain: 'Broad autonomous specialist research when cheaper focused capabilities cannot resolve the uncertainty; never the default action.',
}
