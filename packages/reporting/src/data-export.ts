import { AUDIT_EXPORT_SCHEMA_VERSION, type AuditComparison } from '@audivra/contracts'
import { listAgentRuns } from '@audivra/database'
import type { AuditData } from '@audivra/insights'
import type { Db } from '@audivra/database'

/**
 * The documented JSON export (schema "audivra.audit.v1", see docs/exports.md). Stable field names;
 * binary artifacts are referenced by workspace-relative path, never embedded.
 */
export async function buildAuditExport(db: Db, data: AuditData, comparison: AuditComparison | null) {
  const { row } = data
  const summary = row.summary ?? {}
  const aiRuns = await listAgentRuns(db, row.id)
  return {
    schema: AUDIT_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    audit: {
      id: row.id,
      url: row.normalizedUrl,
      domain: row.domain,
      siteKey: row.siteKey,
      clientName: row.clientName,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      durationMs: row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
      aiEnabled: row.aiEnabled,
      template: row.templateKey ? { key: row.templateKey, version: row.templateVersion } : null,
    },
    coverage: data.coverage,
    business: summary.businessUnderstanding ?? null,
    pageTypes: summary.importantPageTypes ?? [],
    executiveSnapshot: row.reportPlan?.executiveSnapshot ?? null,
    executiveSummary: summary.executiveSummary ?? null,
    baseline: row.baseline ?? null,
    metrics: data.catalog,
    pages: data.pages,
    journeys: data.journeys.map(({ id: _id, auditId: _audit, ...journey }) => journey),
    findings: data.findings.map(({ id: _id, auditId: _audit, ...finding }) => finding),
    evidence: data.evidence.map((e) => ({
      ref: e.ref,
      type: e.type,
      source: e.source,
      title: e.title,
      summary: e.summary,
      url: e.url,
      file: e.artifactPath,
      metadata: e.metadata,
      createdAt: e.createdAt,
    })),
    artifacts: data.artifacts.map(({ id: _id, auditId: _audit, ...artifact }) => artifact),
    technologies: summary.technologies ?? [],
    opportunities: summary.opportunities ?? [],
    actionPlan: row.reportPlan?.actionPlan ?? null,
    limitations: summary.limitations ?? [],
    toolRuns: data.toolRuns.map((t) => ({
      tool: t.tool,
      purpose: t.purpose,
      status: t.status,
      via: t.via,
      url: t.url,
      durationMs: t.durationMs,
      error: t.error,
      files: t.artifactPaths,
    })),
    aiRuns: aiRuns.map((r) => ({
      role: r.role,
      model: r.model,
      promptVersion: r.promptVersion,
      status: r.status,
      turns: r.numTurns,
      durationMs: r.durationMs,
      terminationReason: r.terminationReason,
    })),
    comparison,
  }
}

export type AuditExport = Awaited<ReturnType<typeof buildAuditExport>>
