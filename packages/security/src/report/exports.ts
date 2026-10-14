import { SECURITY_REPORT_EXPORT_KINDS, type SecurityReportAudience, type SecurityReportExportKind } from '@audivra/contracts'
import type { BuildOptions, SecurityReportService } from './assemble.ts'
import { renderSecurityReportHtml } from './html.ts'

/*
 * Phase 6F — the combined client-report export. Like every security export, it is produced from stored state
 * with no AI re-run; the body is a string (JSON or self-contained HTML). The secret-safety canary test spans
 * this export alongside the per-area ones.
 */

export const SECURITY_REPORT_EXPORT_SCHEMA_VERSION = 'audivra.security-report.v1'

export interface GeneratedSecurityReportExport {
  kind: SecurityReportExportKind
  filename: string
  contentType: string
  body: string
}

export async function generateSecurityReportExport(
  service: SecurityReportService,
  engagementId: string,
  kind: SecurityReportExportKind,
  options: BuildOptions & { audience?: SecurityReportAudience } = {},
): Promise<GeneratedSecurityReportExport> {
  const bundle = await service.build(engagementId, options)
  switch (kind) {
    case 'json':
      return { kind, filename: `security-assessment-${engagementId}.json`, contentType: 'application/json', body: JSON.stringify({ schemaVersion: SECURITY_REPORT_EXPORT_SCHEMA_VERSION, ...bundle }, null, 2) }
    case 'html':
      return { kind, filename: `security-assessment-${engagementId}.html`, contentType: 'text/html; charset=utf-8', body: renderSecurityReportHtml(bundle, { audience: options.audience }) }
  }
}

export { SECURITY_REPORT_EXPORT_KINDS }
