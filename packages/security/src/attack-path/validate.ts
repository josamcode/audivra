import type { MissingEvidenceRequirement } from '@audivra/contracts'
import { FINDING_WORTHY_STATES } from '@audivra/contracts'
import type { AttackPathView, CandidatePath } from './discover.ts'

/*
 * Phase 6B — independent validation of a candidate path (deterministic or AI-proposed). Path generation is
 * never trusted on its own: a path is only persisted after every referenced entity is confirmed to exist,
 * every step is confirmed to connect to the previous one, and every finding reference is confirmed to be a
 * real finding-worthy finding. A structurally invalid path (an invented id, a broken join, a contradicted
 * step treated as proof) is REJECTED; a path that merely lacks some evidence keeps that gap explicit as a
 * MissingEvidenceRequirement and is downgraded later, never dropped silently.
 */

export interface PathValidation {
  ok: boolean
  rejectionReason: string | null
  missingEvidence: MissingEvidenceRequirement[]
}

export function validatePath(path: CandidatePath, view: AttackPathView): PathValidation {
  const missing: MissingEvidenceRequirement[] = []
  const findingById = new Map(view.findings.map((f) => [f.id, f]))

  // Ordering: each step must start from the previous step's end (or the path start for step 0).
  let expectedFrom = path.start.label
  for (let i = 0; i < path.steps.length; i++) {
    const step = path.steps[i]!
    if (step.fromCondition !== expectedFrom) {
      return { ok: false, rejectionReason: `step ${i} does not connect (expected "${expectedFrom}", got "${step.fromCondition}")`, missingEvidence: missing }
    }
    expectedFrom = step.toCondition

    // A finding step must reference a real, finding-worthy finding — never an invented id.
    if (step.findingId) {
      const finding = findingById.get(step.findingId)
      if (!finding) return { ok: false, rejectionReason: `step ${i} references unknown finding ${step.findingId}`, missingEvidence: missing }
      if (!FINDING_WORTHY_STATES.includes(finding.verificationState)) {
        // A non-worthy finding cannot back a verified step; the step's evidence is treated as missing.
        if (finding.verificationState === 'rejected') missing.push({ kind: 'contradicted-step', detail: `step ${i} relies on a rejected finding`, stepIndex: i })
        else missing.push({ kind: 'unsupported-impact-edge', detail: `step ${i} relies on a ${finding.verificationState} finding`, stepIndex: i })
      }
    }

    // Every typed reference must resolve to real stored state.
    for (const ref of step.references) {
      if (ref.kind === 'finding') {
        if (!findingById.has(ref.ref)) return { ok: false, rejectionReason: `step ${i} cites unknown finding ${ref.ref}`, missingEvidence: missing }
      } else if (ref.kind === 'graph-edge') {
        if (!view.edges.some((e) => e.key === ref.ref)) {
          // A claimed connecting edge that does not exist is a real evidence gap (not an invented pass).
          missing.push({ kind: 'unverified-reachability', detail: `step ${i} claims a graph edge (${ref.ref}) that is not in the graph`, stepIndex: i })
        }
      } else if (ref.kind === 'identity' || ref.kind === 'resource' || ref.kind === 'graph-node' || ref.kind === 'business-action') {
        if (!view.nodesByKey.has(ref.ref)) missing.push({ kind: 'unknown-identity-relationship', detail: `step ${i} references entity ${ref.ref} absent from the graph`, stepIndex: i })
      }
    }

    // An edge the generator already marked missing/contradicted keeps that gap explicit.
    if (step.edgeVerification === 'missing') missing.push({ kind: 'unverified-reachability', detail: `step ${i} (${step.relationship}) has no verifying evidence`, stepIndex: i })
    if (step.edgeVerification === 'contradicted') missing.push({ kind: 'contradicted-step', detail: `step ${i} (${step.relationship}) is contradicted by stored evidence`, stepIndex: i })
  }

  if (!path.steps.length) return { ok: false, rejectionReason: 'a path needs at least one step', missingEvidence: missing }
  return { ok: true, rejectionReason: null, missingEvidence: dedupeMissing(missing) }
}

function dedupeMissing(items: MissingEvidenceRequirement[]): MissingEvidenceRequirement[] {
  const seen = new Set<string>()
  const out: MissingEvidenceRequirement[] = []
  for (const m of items) {
    const key = `${m.kind}|${m.stepIndex}|${m.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}
