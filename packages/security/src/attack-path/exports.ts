import type { SecurityAttackPath } from '@audivra/contracts'
import type { AttackPathReadService } from './read.ts'

/*
 * Phase 6B exports — generated on demand ENTIRELY from persisted paths; no AI, no re-discovery. JSON carries
 * the verified/partially-verified/open-gap split and a stable schema version; CSV is a flat table. HTML/PDF
 * (the human-readable path) reuse the existing report renderers in a later pass; 6B ships JSON + CSV.
 */

export const ATTACK_PATH_EXPORT_KINDS = ['json', 'csv'] as const
export type AttackPathExportKind = (typeof ATTACK_PATH_EXPORT_KINDS)[number]

export const ATTACK_PATH_EXPORT_SCHEMA_VERSION = 'audivra.security-attack-paths.v1'

export interface GeneratedAttackPathExport {
  kind: AttackPathExportKind
  filename: string
  contentType: string
  body: string
}

const csvCell = (value: unknown): string => {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(',')

export function attackPathsCsv(paths: readonly SecurityAttackPath[]): string {
  const header = ['pathKey', 'title', 'state', 'impactClass', 'impactPriority', 'confidence', 'start', 'end', 'steps', 'findings', 'boundaries', 'missingEvidence', 'dominated']
  const rows = paths.map((p) =>
    csvRow([
      p.pathKey,
      p.title,
      p.state,
      p.impactClass,
      p.impactPriority,
      p.confidence.toFixed(2),
      p.start.label,
      p.end.label,
      p.steps.length,
      p.findingIds.length,
      p.boundariesCrossed.join('; '),
      p.missingEvidence.length,
      p.dominatedBy ? 'yes' : 'no',
    ]),
  )
  return [csvRow(header), ...rows].join('\n')
}

export async function generateAttackPathExport(read: AttackPathReadService, engagementId: string, kind: AttackPathExportKind): Promise<GeneratedAttackPathExport> {
  switch (kind) {
    case 'json': {
      const report = await read.report(engagementId)
      const body = JSON.stringify({ schemaVersion: ATTACK_PATH_EXPORT_SCHEMA_VERSION, ...report }, null, 2)
      return { kind, filename: `security-attack-paths-${engagementId}.json`, contentType: 'application/json', body }
    }
    case 'csv': {
      const paths = await read.listPaths(engagementId, { includeDominated: true })
      return { kind, filename: `security-attack-paths-${engagementId}.csv`, contentType: 'text/csv', body: attackPathsCsv(paths) }
    }
  }
}
