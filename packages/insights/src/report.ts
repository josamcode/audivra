import {
  REPORT_SCHEMA_VERSION,
  SEVERITIES,
  SEVERITY_RANK,
  type Artifact,
  type AuditComparison,
  type ClientReport,
  type Datum,
  type FindingItem,
  type LimitationItem,
  type ReportAction,
  type ReportFinding,
  type ReportPlan,
  type StoredOpportunity,
} from '@audivra/contracts'
import type { AuditData } from './audit-data.ts'
import { startPagePath } from './catalog.ts'
import { coverageCounts } from './coverage.ts'

const IMAGE_RE = /\.(png|jpe?g|webp)$/i

/** Strips the small Markdown subset models emit, for plain-text contexts. */
export function plainText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .trim()
}

/** Splits prose into sentences without breaking on domains, decimals or abbreviations ("josamcode.com", "1.8 s"). */
export function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+(?=["'([]?[A-Z0-9؀-ۿ])/))
    .map((s) => s.trim())
    .filter(Boolean)
}

/** First sentences of the executive summary, used when no composer snapshot exists. */
export function fallbackSnapshot(executiveSummary: string | undefined, maxLines = 5): string[] {
  if (!executiveSummary) return []
  return splitSentences(plainText(executiveSummary))
    .filter((s) => s.length > 20)
    .slice(0, maxLines)
}

function normalizeLimitations(raw: (string | LimitationItem)[] | undefined): LimitationItem[] {
  return (raw ?? []).map((l) => (typeof l === 'string' ? { kind: 'could-not-verify' as const, text: l } : l))
}

function opportunityWhy(o: StoredOpportunity): string {
  return o.why ?? o.description ?? ''
}

export interface BuildReportOptions {
  comparison: AuditComparison | null
  generatedAt?: Date
}

/** Builds the client report model from persisted data. No AI calls; reproducible at any time. */
export function buildClientReport(data: AuditData, options: BuildReportOptions): ClientReport {
  const { row, findings, artifacts, evidence, pages, coverage, catalog } = data
  const plan: ReportPlan | null = row.reportPlan ?? null
  const summary = row.summary ?? {}
  const evidenceByRef = new Map(evidence.map((e) => [e.ref, e]))
  const artifactByRef = new Map(artifacts.map((a) => [a.ref, a]))
  const findingByRef = new Map(findings.map((f) => [f.ref, f]))
  const images: Record<string, string> = {}
  const usedArtifacts = new Set<string>()

  const imageFor = (ref: string | null | undefined): ReportFinding['proof']['image'] => {
    if (!ref) return null
    const item = evidenceByRef.get(ref)
    if (!item?.artifactPath || !IMAGE_RE.test(item.artifactPath)) return null
    images[item.ref] = item.artifactPath
    return { evidenceRef: item.ref, path: item.artifactPath, caption: item.title }
  }

  const registerArtifactImages = (artifact: Artifact) => {
    const add = (ref: string | undefined, path: string | undefined) => {
      if (ref && path) images[ref] = path
    }
    if (artifact.type === 'annotated_screenshot') add(artifact.data.evidenceId, artifact.data.imagePath)
    if (artifact.type === 'evidence_gallery') for (const i of artifact.data.items) add(i.evidenceId, i.imagePath)
    if (artifact.type === 'before_after') {
      images[`${artifact.data.before.auditId}:${artifact.data.before.evidenceId}`] = artifact.data.before.imagePath
      add(artifact.data.after.evidenceId, artifact.data.after.imagePath)
    }
  }
  const useArtifact = (ref: string | null | undefined): Artifact | null => {
    const artifact = ref ? artifactByRef.get(ref) : undefined
    if (!artifact) return null
    usedArtifacts.add(artifact.ref)
    registerArtifactImages(artifact)
    return artifact
  }

  const proofFor = (finding: FindingItem): ReportFinding['proof'] => {
    const planned = plan?.findingProof.find((p) => p.findingId === finding.ref)
    const artifact = useArtifact(planned?.artifactRef) ?? useArtifact(finding.artifactRefs[0])
    const image = artifact ? null : (imageFor(planned?.evidenceId) ?? imageFor(finding.evidenceRefs.find((ref) => imageFor(ref))))
    return { artifact, image }
  }

  const toReportFinding = (f: FindingItem): ReportFinding => ({
    ref: f.ref,
    title: f.title,
    severity: f.severity,
    category: f.category,
    type: f.type,
    confidence: f.confidence,
    verificationStatus: f.verificationStatus,
    description: f.description,
    observed: f.observed,
    whyItMatters: f.whyItMatters,
    businessImpact: f.businessImpact,
    businessImpactLevel: f.businessImpactLevel,
    recommendation: f.recommendation,
    effort: f.effort,
    affectedUrls: f.affectedUrls,
    evidenceRefs: f.evidenceRefs,
    proof: proofFor(f),
  })

  const ranked = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.rank - b.rank)
  const pick = (refs: string[] | undefined) => (refs ?? []).map((r) => findingByRef.get(r)).filter((f): f is FindingItem => !!f)

  const topRiskFindings = plan?.topRiskFindingIds.length ? pick(plan.topRiskFindingIds) : ranked.filter((f) => f.severity !== 'info').slice(0, 5)
  const majorFindingItems = plan?.majorFindingIds.length
    ? pick(plan.majorFindingIds)
    : ranked.filter((f) => SEVERITY_RANK[f.severity] <= SEVERITY_RANK.medium).slice(0, 10)
  const majorRefs = new Set(majorFindingItems.map((f) => f.ref))

  const featured = (plan?.featuredArtifactRefs.length
    ? plan.featuredArtifactRefs.map(useArtifact)
    : artifacts.filter((a) => a.placement === 'overview').slice(0, 2).map((a) => useArtifact(a.ref))
  ).filter((a): a is Artifact => !!a)

  const majorFindings = majorFindingItems.map(toReportFinding)
  const topRisks = topRiskFindings.map(toReportFinding)
  const otherFindings = ranked.filter((f) => !majorRefs.has(f.ref)).map(toReportFinding)

  const categoryHighlights = (plan?.categoryHighlights ?? []).map((h) => ({
    category: h.category,
    takeaway: h.takeaway,
    artifacts: h.artifactRefs.map(useArtifact).filter((a): a is Artifact => !!a),
    findingRefs: h.findingIds.filter((r) => findingByRef.has(r)),
  }))

  const visuals = artifacts
    .filter((a) => a.placement !== 'appendix' && !usedArtifacts.has(a.ref))
    .sort((a, b) => a.priority - b.priority)
  visuals.forEach((a) => useArtifact(a.ref))
  const appendixArtifacts = artifacts.filter((a) => a.placement === 'appendix' && !usedArtifacts.has(a.ref))
  appendixArtifacts.forEach((a) => useArtifact(a.ref))

  const opportunities = (summary.opportunities ?? []).map((o) => ({
    title: o.title,
    why: opportunityWhy(o),
    scope: o.scope ?? null,
    impact: o.impact,
    effort: o.effort,
    findingRefs: o.relatedFindingIds.filter((r) => findingByRef.has(r)),
  }))
  if (plan?.topOpportunityTitles.length) {
    const order = new Map(plan.topOpportunityTitles.map((t, i) => [t.trim().toLowerCase(), i]))
    opportunities.sort((a, b) => (order.get(a.title.trim().toLowerCase()) ?? 99) - (order.get(b.title.trim().toLowerCase()) ?? 99))
  }

  const toActions = (items: ReportPlan['actionPlan']['doFirst']): ReportAction[] =>
    items.map((a) => ({ title: a.title, why: a.why, findingRefs: a.findingIds.filter((r) => findingByRef.has(r)) })).filter((a) => a.findingRefs.length > 0)
  const actionPlan = plan
    ? { doFirst: toActions(plan.actionPlan.doFirst), then: toActions(plan.actionPlan.then), later: toActions(plan.actionPlan.later) }
    : fallbackActions(ranked)

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<(typeof SEVERITIES)[number], number>
  for (const f of findings) bySeverity[f.severity]++

  const keyMetrics: Datum[] = []
  const metric = (key: string, label: string) => {
    const entry = catalog.find((c) => c.key === key)
    if (entry) keyMetrics.push({ label, value: entry.value, unit: entry.unit, metricKey: entry.key, evidenceId: entry.evidenceId })
  }
  const start = startPagePath(catalog)
  metric(`lighthouse:${start}:mobile:performance`, 'Mobile performance')
  metric(`lighthouse:${start}:mobile:lcp`, 'Largest contentful paint')
  metric(`lighthouse:${start}:mobile:accessibility`, 'Accessibility (Lighthouse)')
  metric('links:broken', 'Broken links / resources')

  const counts = coverageCounts(coverage)
  const stats = row.baseline
  const methodology = [
    `Automated baseline: ${coverage.filter((c) => c.status === 'ran' || c.status === 'partial').map((c) => c.label.toLowerCase()).slice(0, 12).join(', ')}.`,
    row.aiEnabled
      ? 'An AI auditor investigated the site with a real browser, a terminal and audit tools, recording evidence for every claim; a second AI pass reviewed the draft and challenged weak or unsupported findings before finalization.'
      : 'The AI investigation was not enabled for this audit; results are limited to the automated baseline.',
    `${evidence.length} evidence items were recorded across ${stats?.pagesCrawled ?? pages.length} crawled pages (${stats?.pagesInspectedInBrowser ?? 0} inspected in a real browser at desktop and mobile sizes).`,
    `Coverage: ${counts.ran} capabilities ran${counts.partial ? `, ${counts.partial} partially` : ''}${counts.skipped + counts.unavailable ? `, ${counts.skipped + counts.unavailable} skipped or unavailable` : ''}${counts.failed ? `, ${counts.failed} failed` : ''}. Security checks were passive only.`,
    'Performance figures are lab measurements under simulated conditions, not real-user field data.',
  ]

  const failedStage = data.steps.some((s) => s.status === 'failed')
  return {
    schema: REPORT_SCHEMA_VERSION,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    title: `Website audit — ${row.domain}`,
    site: { url: row.normalizedUrl, domain: row.domain, clientName: row.clientName },
    audit: {
      date: (row.startedAt ?? row.createdAt).toISOString(),
      durationMs: row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
      status: row.status,
      complete: row.status === 'completed' && !failedStage && row.aiEnabled,
    },
    snapshot: {
      lines: plan?.executiveSnapshot.length ? plan.executiveSnapshot : fallbackSnapshot(summary.executiveSummary),
      findings: {
        total: findings.length,
        bySeverity,
        verified: findings.filter((f) => f.type === 'verified').length,
        observed: findings.filter((f) => f.type === 'supported-observation').length,
        inferred: findings.filter((f) => f.type === 'inference').length,
      },
      pages: {
        discovered: stats?.pagesDiscovered ?? pages.length,
        crawled: stats?.pagesCrawled ?? pages.length,
        inspected: stats?.pagesInspectedInBrowser ?? 0,
      },
      evidenceCount: evidence.length,
      keyMetrics,
    },
    business: summary.businessUnderstanding ?? null,
    topRisks,
    featuredArtifacts: featured,
    majorFindings,
    categoryHighlights,
    visuals,
    opportunities,
    actionPlan,
    comparison: options.comparison,
    appendix: {
      otherFindings,
      artifacts: appendixArtifacts,
      coverage,
      technologies: summary.technologies ?? [],
      pages: pages.slice(0, 150).map((p) => ({ url: p.url, status: p.status, title: p.title, inspected: p.inspectedInBrowser })),
      limitations: normalizeLimitations(summary.limitations),
      methodology,
      fullAnalysis: summary.executiveSummary ?? null,
    },
    images,
  }
}

/** Action plan derived directly from ranked findings when no composer plan exists. */
function fallbackActions(ranked: FindingItem[]): ClientReport['actionPlan'] {
  const actionable = ranked.filter((f) => f.severity !== 'info')
  const toAction = (f: FindingItem): ReportAction => ({
    title: f.title,
    why: plainText(f.recommendation).split(/(?<=[.!?])\s/)[0]?.slice(0, 220) ?? '',
    findingRefs: [f.ref],
  })
  return {
    doFirst: actionable.filter((f) => SEVERITY_RANK[f.severity] <= SEVERITY_RANK.high).slice(0, 4).map(toAction),
    then: actionable.filter((f) => f.severity === 'medium').slice(0, 5).map(toAction),
    later: actionable.filter((f) => f.severity === 'low').slice(0, 5).map(toAction),
  }
}

export interface PlanRefs {
  findings: Set<string>
  artifacts: Set<string>
  /** Evidence refs that have an image file (usable as proof). */
  images: Set<string>
  opportunityTitles: string[]
}

const findingRef = (ref: string) => {
  const match = ref.trim().match(/^f-?(\d+)$/i)
  return match ? `F${Number(match[1])}` : ref.trim()
}
const artifactRef = (ref: string) => {
  const match = ref.trim().match(/^a-?(\d+)$/i)
  return match ? `A${Number(match[1])}` : ref.trim()
}
const evidenceRef = (ref: string) => {
  const match = ref.trim().match(/^ev-?(\d+)$/i)
  return match ? `EV-${Number(match[1])}` : ref.trim()
}

/**
 * Keeps only references that exist (findings, artifacts, image evidence, opportunity titles) so the
 * composer can never point the report at something that is not there. Returns null if nothing usable remains.
 */
export function sanitizeReportPlan(plan: ReportPlan, refs: PlanRefs): { plan: ReportPlan | null; issues: string[] } {
  const issues: string[] = []
  const known = (list: string[], normalize: (r: string) => string, valid: Set<string>, where: string) => {
    const out: string[] = []
    for (const raw of list) {
      const ref = normalize(raw)
      if (!valid.has(ref)) issues.push(`${where}: unknown reference ${raw}`)
      else if (!out.includes(ref)) out.push(ref)
    }
    return out
  }
  const titles = new Map(refs.opportunityTitles.map((t) => [t.trim().toLowerCase(), t]))
  const actions = (items: ReportPlan['actionPlan']['doFirst'], where: string) =>
    items
      .map((a) => ({ ...a, findingIds: known(a.findingIds, findingRef, refs.findings, `${where} "${a.title}"`) }))
      .filter((a) => a.findingIds.length > 0)

  const topRiskFindingIds = known(plan.topRiskFindingIds, findingRef, refs.findings, 'topRisks').slice(0, 5)
  if (topRiskFindingIds.length === 0) {
    issues.push('No valid top-risk findings; the default report layout is used')
    return { plan: null, issues }
  }
  const sanitized: ReportPlan = {
    executiveSnapshot: plan.executiveSnapshot.map((l) => l.trim()).filter(Boolean).slice(0, 8),
    topRiskFindingIds,
    topOpportunityTitles: plan.topOpportunityTitles
      .map((t) => {
        const canonical = titles.get(t.trim().toLowerCase())
        if (!canonical) issues.push(`topOpportunities: unknown opportunity "${t}"`)
        return canonical
      })
      .filter((t): t is string => !!t)
      .slice(0, 5),
    featuredArtifactRefs: known(plan.featuredArtifactRefs, artifactRef, refs.artifacts, 'featured').slice(0, 2),
    majorFindingIds: known(plan.majorFindingIds, findingRef, refs.findings, 'majorFindings').slice(0, 10),
    findingProof: plan.findingProof
      .map((p) => {
        const finding = findingRef(p.findingId)
        if (!refs.findings.has(finding)) return null
        const artifact = p.artifactRef ? artifactRef(p.artifactRef) : null
        const evidence = p.evidenceId ? evidenceRef(p.evidenceId) : null
        if (artifact && !refs.artifacts.has(artifact)) issues.push(`proof for ${finding}: unknown artifact ${p.artifactRef}`)
        if (evidence && !refs.images.has(evidence)) issues.push(`proof for ${finding}: ${p.evidenceId} is not an image`)
        return {
          findingId: finding,
          artifactRef: artifact && refs.artifacts.has(artifact) ? artifact : null,
          evidenceId: evidence && refs.images.has(evidence) ? evidence : null,
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null),
    categoryHighlights: plan.categoryHighlights.slice(0, 6).map((h) => ({
      ...h,
      artifactRefs: known(h.artifactRefs, artifactRef, refs.artifacts, `highlight ${h.category}`).slice(0, 2),
      findingIds: known(h.findingIds, findingRef, refs.findings, `highlight ${h.category}`).slice(0, 6),
    })),
    actionPlan: {
      doFirst: actions(plan.actionPlan.doFirst, 'doFirst').slice(0, 5),
      then: actions(plan.actionPlan.then, 'then').slice(0, 6),
      later: actions(plan.actionPlan.later, 'later').slice(0, 6),
    },
  }
  if (sanitized.executiveSnapshot.length < 3) {
    issues.push('Executive snapshot too short; the summary-derived snapshot is used')
    return { plan: null, issues }
  }
  return { plan: sanitized, issues }
}
