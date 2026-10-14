import type { ScopeManifest, SpecialistArtifact, SpecialistImport, SpecialistRun } from '@audivra/contracts'
import { recordSecurityObservation, type Db } from '@audivra/database'
import { classifyDiscovered, observationDedupeKey } from '../execution/observations.ts'

/*
 * Phase 6D — normalize a specialist artifact into Audivra OBSERVATIONS. A native result becomes an observation
 * (type `web-signal` for a URL, `source-finding` for a code location), recorded as a `tool-heuristic` from
 * tool `strix` — a suspicion to verify, never a verdict. The engine's own severity/category are kept ONLY in
 * the observation value as source metadata; they never become Audivra severity. Out-of-scope results are
 * dropped (a discovered target is never authorized). Nothing here writes a finding or a path: a single-tool
 * specialist observation is not finding-worthy, and corroboration/verification happen downstream in the
 * existing 6A pipeline (two independent tools on the same observation → a candidate → verification).
 */

export interface IngestResult {
  imports: SpecialistImport[]
  counts: SpecialistRun['imported']
  /** Artifact prose is untrusted external-tool output; this never returns it as trusted state. */
}

const STRIX_TOOL = 'strix'

export async function ingestSpecialistArtifact(
  db: Db,
  engagementId: string,
  executionId: string,
  scope: ScopeManifest,
  artifact: SpecialistArtifact,
  evidenceRef: string | null,
): Promise<IngestResult> {
  const imports: SpecialistImport[] = []
  const counts = { vulnerabilities: artifact.vulnerabilities.length, observations: 0, merged: 0, gaps: 0, outOfScope: 0 }
  const now = new Date().toISOString()

  for (const vuln of artifact.vulnerabilities) {
    const url = vuln.affected.url
    const sourcePath = vuln.affected.sourcePath
    // A result with neither a URL nor a source location cannot be attached deterministically → a gap.
    if (!url && !sourcePath) {
      counts.gaps++
      imports.push({ nativeId: vuln.nativeId, title: vuln.title, nativeSeverity: vuln.nativeSeverity, action: 'knowledge-gap', matchedEntityKey: null, observationId: null, candidateIssueKey: null, reason: 'No URL or source location to attach to; recorded as a gap, not a finding.' })
      continue
    }

    // Classify against Audivra scope — a target Strix touched is never authorized by that fact.
    if (url) {
      const scopeClass = classifyDiscovered(scope, url)
      if (scopeClass === 'out-of-scope' || scopeClass === 'third-party') {
        counts.outOfScope++
        imports.push({ nativeId: vuln.nativeId, title: vuln.title, nativeSeverity: vuln.nativeSeverity, action: 'out-of-scope-dropped', matchedEntityKey: null, observationId: null, candidateIssueKey: null, reason: `Dropped: ${scopeClass} per Audivra scope.` })
        continue
      }
      const asset = url
      const subject = `${vuln.nativeCategory}:${vuln.title}`.slice(0, 200)
      const observation = await recordSecurityObservation(db, {
        engagementId,
        dedupeKey: observationDedupeKey('web-signal', asset, subject),
        type: 'web-signal',
        asset,
        subject,
        title: vuln.title.slice(0, 300),
        scopeClass,
        // Native severity/category are SOURCE metadata only — never Audivra severity.
        value: { tool: STRIX_TOOL, nativeSeverity: vuln.nativeSeverity, nativeCategory: vuln.nativeCategory, engineValidated: vuln.engineValidated, nativeId: vuln.nativeId },
        sourceType: 'tool-heuristic',
        contribution: { executionId, capabilityId: 'specialist.strix-research', tool: STRIX_TOOL, toolVersion: artifact.engineVersion, evidenceRef, confidence: 0.5, identityRef: null, sessionRef: null, at: now },
      })
      const merged = new Set(observation.contributions.map((c) => c.tool)).size > 1
      if (merged) counts.merged++
      else counts.observations++
      imports.push({ nativeId: vuln.nativeId, title: vuln.title, nativeSeverity: vuln.nativeSeverity, action: merged ? 'merged-existing' : 'observation-created', matchedEntityKey: asset, observationId: observation.id, candidateIssueKey: null, reason: merged ? 'Corroborated an existing observation (≥2 tools) — eligible for a candidate via 6A.' : 'Recorded as a specialist web-signal (a single-tool signal is not finding-worthy on its own).' })
      continue
    }

    // Source location → a source-finding observation.
    const asset = sourcePath!
    const subject = `${vuln.nativeCategory}:${vuln.title}`.slice(0, 200)
    const observation = await recordSecurityObservation(db, {
      engagementId,
      dedupeKey: observationDedupeKey('source-finding', asset, subject),
      type: 'source-finding',
      asset,
      subject,
      title: vuln.title.slice(0, 300),
      scopeClass: 'in-scope',
      value: { tool: STRIX_TOOL, nativeSeverity: vuln.nativeSeverity, nativeCategory: vuln.nativeCategory, engineValidated: vuln.engineValidated, nativeId: vuln.nativeId },
      sourceType: 'tool-heuristic',
      contribution: { executionId, capabilityId: 'specialist.strix-research', tool: STRIX_TOOL, toolVersion: artifact.engineVersion, evidenceRef, confidence: 0.5, identityRef: null, sessionRef: null, at: now },
    })
    const merged = new Set(observation.contributions.map((c) => c.tool)).size > 1
    if (merged) counts.merged++
    else counts.observations++
    imports.push({ nativeId: vuln.nativeId, title: vuln.title, nativeSeverity: vuln.nativeSeverity, action: merged ? 'merged-existing' : 'observation-created', matchedEntityKey: asset, observationId: observation.id, candidateIssueKey: null, reason: merged ? 'Corroborated an existing source finding (≥2 tools).' : 'Recorded as a specialist source-finding.' })
  }

  return { imports, counts }
}
