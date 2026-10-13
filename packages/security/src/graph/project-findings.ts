import { findingKey } from './identity.ts'
import type { Builder } from './project.ts'

/*
 * Phase 6A — projecting VERIFIED/SUPPORTED findings into the Security Graph. A finding node records the
 * settled verdict; a FINDING_AFFECTS edge ties it to each entity it concerns, and a CONTRADICTS edge ties it
 * to an invariant it violates. Provenance is `derivation` (or `comparison-derivation` when a comparison
 * produced it) with the matching trust — never `ai-inference`: a finding is an Audivra decision over
 * evidence, not a model opinion. An edge to a node that does not exist is skipped (UNKNOWN != FALSE).
 */

export interface FindingProjection {
  issueKey: string
  title: string
  category: string
  severity: string
  verificationState: string
  status: string
  confidence: number
  /** True when a differential comparison produced the finding (sets provenance source/trust). */
  fromComparison: boolean
  /** Graph node keys of the affected entities. */
  affectedEntityKeys: string[]
  /** Graph node keys of invariants the finding contradicts. */
  invariantKeys: string[]
  evidenceRefs: string[]
  executionIds: string[]
  at: string
}

export function projectFindingsInto(b: Builder, findings: readonly FindingProjection[]): void {
  for (const f of findings) {
    const key = b.node('finding', findingKey(f.issueKey), f.title, null)
    b.attr(key, 'category', f.category)
    b.attr(key, 'severity', f.severity)
    b.attr(key, 'verificationState', f.verificationState)
    b.attr(key, 'status', f.status)
    b.attr(key, 'confidence', f.confidence)
    const source = f.fromComparison ? 'comparison-derivation' : 'derivation'
    const trust = f.fromComparison ? 'differential-comparison' : 'deterministic-derivation'
    b.declare('node', key, {
      sourceRef: f.issueKey,
      source,
      trust,
      confidence: f.confidence,
      rationale: `Verified security finding: ${f.title}`,
      at: f.at,
      evidenceRefs: f.evidenceRefs,
      executionIds: f.executionIds,
    })
    for (const target of f.affectedEntityKeys) {
      if (!b.nodes.has(target)) continue
      const edge = b.edge('FINDING_AFFECTS', key, target)
      b.declare('edge', edge, { sourceRef: f.issueKey, source, trust, confidence: f.confidence, rationale: null, at: f.at })
    }
    for (const inv of f.invariantKeys) {
      if (!b.nodes.has(inv)) continue
      const edge = b.edge('CONTRADICTS', key, inv)
      b.declare('edge', edge, { sourceRef: f.issueKey, source, trust, confidence: f.confidence, rationale: `${f.title} contradicts this invariant`, at: f.at })
    }
  }
}
