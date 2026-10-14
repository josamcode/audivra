import type { ActionUsefulness, ComparisonPlanInput, RequestSpecialistRunInput, SecurityActor } from '@audivra/contracts'
import type { Db } from '@audivra/database'
import type { CapabilityBroker } from '../broker.ts'
import type { ComparisonEngine } from '../comparison/engine.ts'
import type { VerificationService } from '../verification/service.ts'
import type { AttackPathService } from '../attack-path/service.ts'
import type { RetestService } from '../retest/service.ts'
import type { SpecialistRunService } from '../specialist/service.ts'
import type { CandidateAction } from './assess.ts'

/*
 * Phase 6E — the EXECUTE stage. Each action kind maps to an EXISTING Audivra service; there is no second
 * execution path and no new domain logic. The orchestrator never spawns a subprocess, touches Docker, makes
 * an arbitrary HTTP request, or runs an arbitrary CLI — only registered capabilities and reviewed services.
 */

export interface ExecuteDeps {
  db: Db
  broker: CapabilityBroker
  comparisonEngine: ComparisonEngine
  verification: VerificationService
  attackPath: AttackPathService
  retest: RetestService
  specialist: SpecialistRunService
}

export interface ActionOutcome {
  producedRefs: string[]
  usefulness: ActionUsefulness
  outcome: string
}

export async function executeAction(deps: ExecuteDeps, engagementId: string, candidate: CandidateAction, actor: SecurityActor, signal: AbortSignal): Promise<ActionOutcome> {
  switch (candidate.kind) {
    case 'comparison': {
      const comparison = await deps.comparisonEngine.planAndRun(engagementId, candidate.inputRef as unknown as ComparisonPlanInput, actor)
      const usefulness: ActionUsefulness =
        comparison.status === 'blocked' ? 'blocked' : comparison.result === 'inconsistent' ? 'high-information-gain' : comparison.result === 'consistent' ? 'useful' : comparison.result === 'inconclusive' ? 'low-value' : 'no-new-information'
      return { producedRefs: [comparison.id], usefulness, outcome: `${comparison.result}: ${comparison.resultReason}`.slice(0, 400) }
    }
    case 'verify': {
      const result = await deps.verification.drive(engagementId, { signal })
      const created = result.findingsCreated + result.findingsUpdated
      const usefulness: ActionUsefulness = result.findingsCreated > 0 ? 'high-information-gain' : result.verified + result.supported > 0 ? 'useful' : 'no-new-information'
      return { producedRefs: [], usefulness, outcome: `verified ${result.verified}, supported ${result.supported}, findings ${created}, blocked ${result.blocked}` }
    }
    case 'attack-path': {
      const result = await deps.attackPath.drive(engagementId, { signal })
      const usefulness: ActionUsefulness = result.pathsCreated > 0 ? 'useful' : result.pathsUpdated > 0 ? 'low-value' : 'no-new-information'
      return { producedRefs: [], usefulness, outcome: `paths created ${result.pathsCreated}, updated ${result.pathsUpdated}` }
    }
    case 'retest': {
      const caseId = typeof candidate.inputRef.retestCaseId === 'string' ? candidate.inputRef.retestCaseId : null
      if (!caseId) return { producedRefs: [], usefulness: 'failed', outcome: 'no retest case id' }
      const result = await deps.retest.runRetest(caseId, engagementId, { actor, signal })
      const usefulness: ActionUsefulness =
        result.state === 'still-present' || result.state === 'fixed' || result.state === 'regressed' || result.state === 'changed' ? 'useful' : result.state === 'blocked' ? 'blocked' : result.state === 'cannot-reproduce' ? 'low-value' : 'no-new-information'
      return { producedRefs: [result.id], usefulness, outcome: `retest → ${result.state}` }
    }
    case 'specialist': {
      const input: RequestSpecialistRunInput = { engine: 'strix', mode: (candidate.inputRef.mode as RequestSpecialistRunInput['mode']) ?? 'source-only', findingIds: [], resourceRefs: typeof candidate.inputRef.resourceRef === 'string' ? [candidate.inputRef.resourceRef] : [], stagedSourceRef: null, focus: 'broad' }
      const requested = await deps.specialist.request(engagementId, input, actor)
      const run = await deps.specialist.drive(requested.id, { actor, signal })
      const signals = run.imported.observations + run.imported.merged
      const usefulness: ActionUsefulness = run.state === 'unavailable' ? 'blocked' : signals > 0 ? 'useful' : 'no-new-information'
      return { producedRefs: [run.id], usefulness, outcome: `specialist ${run.state}: ${signals} signal(s)` }
    }
    case 'observe': {
      const url = typeof candidate.inputRef.url === 'string' ? candidate.inputRef.url : null
      if (!url) return { producedRefs: [], usefulness: 'failed', outcome: 'no url' }
      const result = await deps.broker.execute({ engagementId, capabilityId: 'discovery.http-observe', input: { url }, actor }, { signal })
      const usefulness: ActionUsefulness = result.status === 'denied' ? 'blocked' : result.status === 'completed' ? 'useful' : 'low-value'
      return { producedRefs: [result.executionId], usefulness, outcome: `observe ${result.status}` }
    }
  }
}
