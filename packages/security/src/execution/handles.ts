import type { SecurityExecutionSnapshot } from '@audivra/contracts'
import type { CapabilityHandles, ObservationRecorder } from '../capabilities/types.ts'
import type { Resolver } from '../dns.ts'
import { ScopedHttpClient } from '../http-client.ts'
import type { SecurityStore } from '../store.ts'
import { ArtifactRegistrar } from './artifacts.ts'
import { observationDedupeKey, normalizeAsset, normalizeSubject } from './observations.ts'
import { ExecutionProcesses } from './processes.ts'
import type { ExecutionWorkspace } from './workspace.ts'

export interface ExecutionHandles {
  handles: CapabilityHandles
  registrar: ArtifactRegistrar
  processes: ExecutionProcesses
  http: ScopedHttpClient
}

/**
 * The handles an executor receives, built from the trusted snapshot only: the scoped HTTP client gets
 * the snapshot's scope and limits, the evidence recorder fills in provenance from the snapshot, and
 * processes are owned by the execution. Every handle observes the execution's stop signal.
 */
export function createExecutionHandles(
  snapshot: SecurityExecutionSnapshot,
  options: {
    workspace: ExecutionWorkspace
    signal: AbortSignal
    resolver: Resolver
    store: Pick<SecurityStore, 'recordEvidence' | 'recordObservation'>
    sensor?: { tool: string; toolVersion: string } | null
    /** Identity-aware auth material injected by the trusted runtime (Phase 5 Step 3); never from input. */
    auth?: { headers: Record<string, string>; origin: string } | null
  },
): ExecutionHandles {
  const { workspace, signal } = options
  const s = snapshot
  const identity = s.identity ?? null
  const registrar = new ArtifactRegistrar({
    workspace,
    maxBytes: s.runtime.maxArtifactBytes,
    allowedTypes: s.capability.evidenceTypes,
    persist: ({ sensitivity, ...content }) =>
      options.store.recordEvidence({
        ...content,
        engagementId: s.engagement.id,
        source: 'system',
        provenance: {
          engagementId: s.engagement.id,
          executionId: s.executionId,
          correlationId: s.correlationId,
          capabilityId: s.capability.id,
          capabilityVersion: s.capability.version,
          implementation: s.capability.implementation,
          decisionEventId: s.decision.eventId,
          environment: s.environment,
          scopeVersion: s.scope.version,
          scopeHash: s.scope.hash,
          configVersion: s.engagement.configVersion,
          policyProfile: { key: s.policy.profileKey, version: s.policy.profileVersion },
          authorizationIds: s.authorization.authorizationIds,
          identityRef: identity?.identityRef ?? null,
          sessionRef: identity?.sessionRef ?? null,
          sensitivity,
        },
      }),
  })
  const sensor = options.sensor ?? null
  const observations: ObservationRecorder = {
    record: async (input) => {
      if (!sensor) throw new Error('Observations can only be recorded by a sensor capability')
      const asset = normalizeAsset(input.asset)
      const subject = normalizeSubject(input.subject)
      return options.store.recordObservation({
        engagementId: s.engagement.id,
        dedupeKey: input.dedupeKey ?? observationDedupeKey(input.type, asset, subject),
        type: input.type,
        asset,
        subject,
        title: input.title,
        scopeClass: input.scopeClass ?? null,
        value: input.value ?? {},
        sourceType: input.sourceType ?? 'tool-reported',
        contribution: {
          executionId: s.executionId,
          capabilityId: s.capability.id,
          tool: sensor.tool,
          toolVersion: sensor.toolVersion,
          evidenceRef: input.evidenceRef ?? null,
          confidence: input.confidence ?? 1,
          identityRef: identity?.identityRef ?? null,
          sessionRef: identity?.sessionRef ?? null,
          at: new Date().toISOString(),
        },
      })
    },
  }
  const processes = new ExecutionProcesses({ executionId: s.executionId, tool: s.capability.id, workspace, maxProcesses: s.runtime.maxProcesses, signal })
  const http = new ScopedHttpClient({ manifest: s.scope.manifest, limits: s.limits, mutation: s.capability.sideEffect, resolver: options.resolver, signal, auth: options.auth ?? null })
  const handles: CapabilityHandles = {
    http,
    signal,
    workspace: {
      root: workspace.root,
      dir: workspace.dir,
      inputs: workspace.area('inputs'),
      outputs: workspace.area('outputs'),
      artifacts: workspace.area('artifacts'),
      tmp: workspace.area('tmp'),
      relative: (absolute) => workspace.relative(absolute) ?? '',
    },
    evidence: { record: (item) => registrar.register(item) },
    observations,
    processes,
    processOwner: { tool: s.capability.id, securityExecutionId: s.executionId },
  }
  return { handles, registrar, processes, http }
}
