import type { AuditComparison, ClientReport } from '@audivra/contracts'
import { getChangeReport, type Db } from '@audivra/database'
import { buildComparison, loadAuditData, type AuditData } from './audit-data.ts'
import { buildClientReport } from './report.ts'

/**
 * The client report of an audit with everything it draws on: the deterministic comparison with the
 * previous audit and the stored Change Intelligence. Client View, PDF and HTML all use this.
 */
export async function loadClientReport(
  db: Db,
  auditId: string,
): Promise<{ report: ClientReport; data: AuditData; comparison: AuditComparison | null } | undefined> {
  const data = await loadAuditData(db, auditId)
  if (!data) return undefined
  const comparison = await buildComparison(db, auditId)
  const changes = comparison ? await getChangeReport(db, auditId, comparison.previous.id) : null
  return { data, comparison, report: buildClientReport(data, { comparison, changes }) }
}
