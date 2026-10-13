import { INFERRED_CONFIDENCE_CAP, SEVERITY_RANK, type ConfidenceFactors, type FindingCategory, type Severity, type SeverityInputs } from '@audivra/contracts'

/*
 * Phase 6A — deterministic severity and evidence-quality confidence. Mirrors the Website Audit philosophy:
 * AUDIVRA computes the severity the evidence supports; the AI may only ever explain within it or LOWER it,
 * never raise it (the reviewer's suggestion is clamped in the engine). Severity is a function of the finding
 * category, the boundaries actually crossed, the sensitivity of the data at stake, how hard the issue is to
 * exploit, the environment and the confidence — never a tool's marketing severity. Confidence is a function
 * of evidence quality: direct observation, independent corroboration, controls, deterministic reproduction,
 * and whether any contradicting evidence or AI inference is in play.
 */

const BY_RANK: Severity[] = ['critical', 'high', 'medium', 'low', 'info']
const clampRank = (rank: number): Severity => BY_RANK[Math.max(0, Math.min(4, rank))]!

/** The severity the evidence supports before any crossing/sensitivity adjustment. */
const BASE_SEVERITY: Record<FindingCategory, Severity> = {
  authentication: 'high',
  authorization: 'high',
  'tenant-isolation': 'high',
  'business-logic': 'medium',
  'session-management': 'medium',
  'api-behavior': 'low',
  configuration: 'low',
  dependency: 'medium',
  'transport-tls': 'medium',
  exposure: 'medium',
  'source-runtime-inconsistency': 'medium',
}

export interface SeverityDecision {
  severity: Severity
  reason: string
}

/** Computes the severity AUDIVRA supports from deterministic inputs. The AI never raises this. */
export function computeSeverity(inputs: SeverityInputs): SeverityDecision {
  const notes: string[] = []
  let rank = SEVERITY_RANK[BASE_SEVERITY[inputs.category]]
  notes.push(`base ${BASE_SEVERITY[inputs.category]} for ${inputs.category}`)

  if (inputs.tenantBoundaryCrossed) {
    rank -= 1
    notes.push('tenant boundary crossed (+)')
  }
  if (inputs.privilegeBoundaryCrossed) {
    rank -= 1
    notes.push('privilege boundary crossed (+)')
  }
  if (inputs.dataSensitivity === 'high') {
    rank -= 1
    notes.push('high-sensitivity data (+)')
  } else if (inputs.dataSensitivity === 'low') {
    rank += 1
    notes.push('low-sensitivity data (-)')
  }
  if (inputs.exploitPrerequisites === 'none') {
    rank -= 1
    notes.push('no exploit prerequisites (+)')
  } else if (inputs.exploitPrerequisites === 'privileged' || inputs.exploitPrerequisites === 'complex') {
    rank += 1
    notes.push(`${inputs.exploitPrerequisites} exploit prerequisites (-)`)
  }

  // Ceilings — a severity cannot exceed what the context supports.
  if (inputs.scopeClass === 'out-of-scope' || inputs.scopeClass === 'third-party') {
    rank = Math.max(rank, SEVERITY_RANK.info)
    notes.push(`${inputs.scopeClass}: clamped to info`)
  }
  if (inputs.confidence < 0.5) {
    rank = Math.max(rank, SEVERITY_RANK.medium)
    notes.push(`confidence ${inputs.confidence.toFixed(2)} < 0.5: capped at medium`)
  } else if (inputs.confidence < 0.7) {
    rank = Math.max(rank, SEVERITY_RANK.high)
    notes.push(`confidence ${inputs.confidence.toFixed(2)} < 0.7: capped at high`)
  }
  if (inputs.environment && inputs.environment !== 'production') {
    rank = Math.max(rank, SEVERITY_RANK.high)
    notes.push(`non-production (${inputs.environment}): capped at high`)
  }

  return { severity: clampRank(rank), reason: notes.join('; ') }
}

/** The lower of two severities never wins over the higher; this returns the MORE severe of two. */
export const moreSevere = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b)
/** The LESS severe (higher rank) of two — used to clamp a reviewer's suggestion downward only. */
export const lessSevere = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b)

/** Evidence-quality confidence. Weak or contradicted evidence can never read as near-certainty. */
export function computeConfidence(factors: ConfidenceFactors): number {
  let c = 0.3
  if (factors.directObservation) c += 0.15
  if (factors.independentCorroboration) c += 0.2
  if (factors.positiveControl) c += 0.1
  if (factors.negativeControl) c += 0.1
  if (factors.deterministicReproduction) c += 0.15
  if (factors.contradictoryEvidence) c -= 0.3
  // A finding that leans on AI inference never carries more than the inferred-fact confidence cap.
  if (factors.aiInferenceDependency && !factors.directObservation) c = Math.min(c, INFERRED_CONFIDENCE_CAP)
  return Math.max(0.05, Math.min(0.95, Number(c.toFixed(2))))
}
