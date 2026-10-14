import type { FindingComparisonEntry, RetestResult } from '@audivra/contracts'
import type { HistoryReadService } from './read.ts'

/*
 * Phase 6C — historical / retest exports, built strictly from persisted state (no retest, AI or capability is
 * ever re-run during an export). JSON carries the full assessment comparison with a stable schema version;
 * CSV flattens the finding changes and retest results for a spreadsheet.
 */

export const HISTORY_EXPORT_KINDS = ['json', 'csv-changes', 'csv-retests'] as const
export type HistoryExportKind = (typeof HISTORY_EXPORT_KINDS)[number]

export const SECURITY_HISTORY_EXPORT_SCHEMA_VERSION = 'audivra.security-history.v1'

export interface GeneratedHistoryExport {
  kind: HistoryExportKind
  filename: string
  contentType: string
  body: string
}

const csvCell = (value: unknown): string => {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(',')

export function findingChangesCsv(changes: readonly FindingComparisonEntry[]): string {
  const header = ['class', 'matchBasis', 'confidence', 'previousIssueKey', 'currentIssueKey', 'previousSeverity', 'currentSeverity', 'retestState', 'changes', 'reason']
  const rows = changes.map((c) =>
    csvRow([
      c.class,
      c.match.basis,
      c.match.confidence.toFixed(2),
      c.match.previousIssueKey ?? '',
      c.match.currentIssueKey ?? '',
      c.previous?.severity ?? '',
      c.current?.severity ?? '',
      c.retestState ?? '',
      c.changes.map((ch) => `${ch.aspect}:${ch.from}→${ch.to}`).join('; '),
      c.reason,
    ]),
  )
  return [csvRow(header), ...rows].join('\n')
}

export function retestResultsCsv(results: readonly RetestResult[]): string {
  const header = ['issueKey', 'state', 'controlValid', 'freshResult', 'sourceEngagementId', 'engagementId', 'adaptation', 'reason', 'createdAt']
  const rows = results.map((r) => csvRow([r.issueKey, r.state, r.controlValid ? 'yes' : 'no', r.freshResult ?? '', r.sourceEngagementId, r.engagementId, r.adaptation ? r.adaptation.kind : '', r.reason, r.createdAt]))
  return [csvRow(header), ...rows].join('\n')
}

/** Build one historical export for a (previous → current) assessment pair, from persisted state only. */
export async function generateHistoryExport(read: HistoryReadService, previousEngagementId: string, currentEngagementId: string, kind: HistoryExportKind): Promise<GeneratedHistoryExport> {
  const name = `security-history-${previousEngagementId}-${currentEngagementId}`
  switch (kind) {
    case 'json': {
      const report = await read.report(previousEngagementId, currentEngagementId)
      const comparison = await read.assessmentComparison(previousEngagementId, currentEngagementId)
      const body = JSON.stringify({ schemaVersion: SECURITY_HISTORY_EXPORT_SCHEMA_VERSION, report, comparison }, null, 2)
      return { kind, filename: `${name}.json`, contentType: 'application/json', body }
    }
    case 'csv-changes': {
      const comparison = await read.assessmentComparison(previousEngagementId, currentEngagementId)
      return { kind, filename: `${name}-changes.csv`, contentType: 'text/csv', body: findingChangesCsv(comparison.findingChanges) }
    }
    case 'csv-retests': {
      const results = await read.listRetestResults(currentEngagementId)
      return { kind, filename: `security-retests-${currentEngagementId}.csv`, contentType: 'text/csv', body: retestResultsCsv(results) }
    }
  }
}
