import type { AttackStep, EndImpact, ImpactClass, MissingEvidenceRequirement, PathOrigin, PathState, Severity, StartCondition, TrustBoundaryKind } from '@audivra/contracts'
import { pathImpactPriority, pathVerdict } from './confidence.ts'
import type { KeyedPath } from './dedupe.ts'
import type { PathValidation } from './validate.ts'

/*
 * Phase 6B — turning a validated candidate into a persisted attack path. The verification state and
 * confidence come from the weakest meaningful edge (never an average); the impact priority is a separate
 * axis; the explanation is either AI-authored (fact-checked against the steps) or a deterministic join of the
 * steps, so a path is never blocked on narrative. Dominance is carried as the dominating path's stable key.
 */

export interface PathSynthesis {
  pathKey: string
  title: string
  purpose: string
  start: StartCondition
  endImpact: EndImpact
  steps: AttackStep[]
  affectedEntityKeys: string[]
  findingIds: string[]
  comparisonIds: string[]
  invariantRefs: string[]
  confidence: number
  state: PathState
  stateReason: string
  missingEvidence: MissingEvidenceRequirement[]
  impactClass: ImpactClass
  impactPriority: Severity
  boundariesCrossed: TrustBoundaryKind[]
  origin: PathOrigin
  providerId: string | null
  explanation: string
  dominatedBy: string | null
}

export interface SynthesisInput {
  path: KeyedPath
  validation: PathValidation
  explanation: { title: string; explanation: string } | null
  providerId: string | null
}

export function synthesizePath(input: SynthesisInput): PathSynthesis {
  const { path, validation, explanation, providerId } = input
  const steps: AttackStep[] = path.steps.map((s, index) => ({ index, ...s }))
  const verdict = pathVerdict(steps)
  const impactPriority = pathImpactPriority(path, verdict)
  const title = (explanation?.title ?? `${path.start.label} → ${path.end.label}`).slice(0, 160)
  return {
    pathKey: path.pathKey,
    title,
    purpose: `Reach ${path.end.label} from ${path.start.label}`,
    start: path.start,
    endImpact: path.end,
    steps,
    affectedEntityKeys: path.affectedEntityKeys,
    findingIds: path.findingIds,
    comparisonIds: path.comparisonIds,
    invariantRefs: path.invariantRefs,
    confidence: verdict.confidence,
    state: verdict.state,
    stateReason: verdict.reason,
    missingEvidence: validation.missingEvidence,
    impactClass: path.impactClass,
    impactPriority,
    boundariesCrossed: path.boundariesCrossed,
    origin: path.origin,
    providerId,
    explanation: explanation?.explanation ?? deterministicExplanation(steps, path.start.label),
    dominatedBy: path.dominatedBy,
  }
}

function deterministicExplanation(steps: readonly AttackStep[], start: string): string {
  const parts = [start, ...steps.map((s) => `${s.relationship} [${s.edgeVerification}]`)]
  return parts.join(' → ')
}
