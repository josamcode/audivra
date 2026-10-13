import type { SecurityFinding, SecurityVerificationCandidate } from '@audivra/contracts'
import type { FindingReadService } from './read.ts'

/*
 * Phase 6A exports — generated on demand ENTIRELY from persisted findings/candidates; no AI, no capability,
 * no re-run. The JSON export carries a stable schema version and the same verified/supported/open split as
 * the report; the CSVs are flat tables for a spreadsheet. HTML/PDF/bundle are deliberately out of 6A scope.
 */

export const FINDING_EXPORT_KINDS = ['json', 'csv-findings', 'csv-candidates'] as const
export type FindingExportKind = (typeof FINDING_EXPORT_KINDS)[number]

export const SECURITY_FINDINGS_EXPORT_SCHEMA_VERSION = 'audivra.security-findings.v1'

export interface GeneratedFindingExport {
  kind: FindingExportKind
  filename: string
  contentType: string
  body: string
}

const csvCell = (value: unknown): string => {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(',')

export function findingsCsv(findings: readonly SecurityFinding[]): string {
  const header = ['issueKey', 'title', 'category', 'severity', 'confidence', 'verificationState', 'status', 'affectedEntities', 'evidenceCount', 'contradicting', 'createdAt']
  const rows = findings.map((f) =>
    csvRow([
      f.issueKey,
      f.title,
      f.category,
      f.severity,
      f.confidence.toFixed(2),
      f.verificationState,
      f.status,
      f.affectedEntities.map((e) => e.label).join('; '),
      f.evidenceRefs.length,
      f.contradictingEvidenceRefs.length,
      f.createdAt,
    ]),
  )
  return [csvRow(header), ...rows].join('\n')
}

export function candidatesCsv(candidates: readonly SecurityVerificationCandidate[]): string {
  const header = ['issueKey', 'category', 'origin', 'status', 'statusReason', 'verifierVerdict', 'evidenceCount', 'contradicting', 'findingId']
  const rows = candidates.map((c) =>
    csvRow([c.issueKey, c.category, c.source.origin, c.status, c.statusReason, c.verifier.verdict, c.supportingEvidenceRefs.length, c.contradictingEvidenceRefs.length, c.findingId ?? '']),
  )
  return [csvRow(header), ...rows].join('\n')
}

/** Builds one export for an engagement, strictly from persisted state. */
export async function generateFindingExport(read: FindingReadService, engagementId: string, kind: FindingExportKind): Promise<GeneratedFindingExport> {
  switch (kind) {
    case 'json': {
      const report = await read.report(engagementId)
      const body = JSON.stringify({ schemaVersion: SECURITY_FINDINGS_EXPORT_SCHEMA_VERSION, ...report }, null, 2)
      return { kind, filename: `security-findings-${engagementId}.json`, contentType: 'application/json', body }
    }
    case 'csv-findings': {
      const findings = await read.listFindings(engagementId)
      return { kind, filename: `security-findings-${engagementId}.csv`, contentType: 'text/csv', body: findingsCsv(findings) }
    }
    case 'csv-candidates': {
      const candidates = await read.listCandidates(engagementId)
      return { kind, filename: `security-candidates-${engagementId}.csv`, contentType: 'text/csv', body: candidatesCsv(candidates) }
    }
  }
}
