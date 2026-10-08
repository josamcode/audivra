import {
  ChangeAnalysis,
  ClientBriefContent,
  JourneyAnalysis,
  type ChangeInsight,
  type ChangeKind,
  type FindingChangeStatus,
} from '@audivra/contracts'
import type { ChangeFactIndex } from '@audivra/insights'
import {
  checkJourneys,
  cleanJourneyKey,
  filterJourneyIds,
  normalizeJourneyId,
  normalizeJourneyKeys,
  normalizeRef,
  OutputValidationError,
  type ValidationIssue,
} from './validate.ts'

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown, label: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new OutputValidationError(
      `${label} output failed schema validation`,
      parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
    )
  }
  return parsed.data
}

export function normalizeFindingId(id: string): string {
  const match = id.trim().match(/^f-?(\d+)$/i)
  return match ? `F${Number(match[1])}` : id.trim()
}

function keepKnown(ids: string[], normalize: (id: string) => string, known: Set<string>, scope: string, issues: ValidationIssue[]): string[] {
  const out: string[] = []
  for (const raw of ids) {
    const id = normalize(raw)
    if (!known.has(id)) issues.push({ scope, message: `Removed unknown reference "${raw}"` })
    else if (!out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Journey analysis of an existing audit: the same journey rules as during an audit (evidence must
 * exist; problems need evidence; one primary), plus finding links to findings that exist.
 */
export function validateJourneyAnalysis(
  value: unknown,
  existingEvidence: Set<string>,
  findingRefs: Set<string>,
): { analysis: JourneyAnalysis; issues: ValidationIssue[] } {
  const analysis = parse(JourneyAnalysis, normalizeJourneyKeys(value), 'Journey analysis')
  const issues: ValidationIssue[] = []
  const usedKeys = new Set<string>()
  const keyed = analysis.journeys.map((j) => {
    let key = cleanJourneyKey(j.journeyKey, j.type, j.name)
    for (let n = 2; usedKeys.has(key); n++) key = `${cleanJourneyKey(j.journeyKey, j.type, j.name).split('-').slice(0, 7).join('-')}-${n}`
    usedKeys.add(key)
    return { ...j, journeyKey: key }
  })
  const journeys = checkJourneys(keyed, existingEvidence, findingRefs, issues)
    // Primary first, then renumbered so refs are dense (J1, J2, …).
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
  const renumber = new Map(journeys.map((j, i) => [j.id, `J${i + 1}`]))
  const known = new Set(journeys.map((j) => j.id))
  const findingLinks = analysis.findingLinks
    .map((link) => ({ findingId: normalizeFindingId(link.findingId), journeyIds: filterJourneyIds(link.journeyIds, known, link.findingId, issues) }))
    .filter((link) => {
      if (!findingRefs.has(link.findingId)) {
        issues.push({ scope: 'findingLinks', message: `Removed link for unknown finding "${link.findingId}"` })
        return false
      }
      return link.journeyIds.length > 0
    })
    .map((link) => ({ ...link, journeyIds: link.journeyIds.map((id) => renumber.get(id)!) }))
  return {
    analysis: { ...analysis, journeys: journeys.map((j) => ({ ...j, id: renumber.get(j.id)! })), findingLinks },
    issues,
  }
}

const IMPROVING: FindingChangeStatus[] = ['improved', 'resolved']

/** Whether the deterministic facts support an insight of this kind with these references. */
function supported(kind: ChangeKind, insight: ChangeInsight, facts: ChangeFactIndex): boolean {
  const current = insight.currentFindingIds.map((id) => facts.currentFindings.get(id))
  const previous = insight.previousFindingIds.map((id) => facts.previousFindings.get(id))
  const metrics = insight.metricKeys.map((key) => facts.metrics.get(key))
  const journeys = insight.journeyKeys.map((key) => facts.journeys.get(key))
  switch (kind) {
    case 'regression':
      return (
        current.some((s) => s === 'regressed' || s === 'new') ||
        metrics.includes('regressed') ||
        journeys.some((s) => s === 'changed' || s === 'not-found-again') ||
        (facts.trackingChanged && insight.journeyKeys.length + insight.currentFindingIds.length > 0)
      )
    case 'improvement':
      return current.includes('improved') || previous.some((s) => s && IMPROVING.includes(s)) || metrics.includes('improved') || journeys.includes('changed')
    case 'new-issue':
      return current.includes('new')
    case 'not-found-again':
      return previous.includes('resolved')
    case 'persistent':
      return current.some((s) => s === 'unchanged' || s === 'improved' || s === 'regressed')
    case 'journey':
      return journeys.some((s) => s && s !== 'unchanged')
    case 'tracking':
      return facts.trackingChanged || current.length > 0 || previous.length > 0
    case 'metric':
      return metrics.some((d) => d === 'improved' || d === 'regressed')
    case 'technology':
      return facts.technologyChanged
    case 'coverage':
      return facts.coverageChanged
  }
}

/**
 * Change Intelligence must agree with the deterministic comparison: references must exist, and an
 * insight must be backed by facts of its kind (a "regression" needs a regressed/new finding, a
 * regressed metric or a changed journey; "not found again" needs a finding that was not found again).
 * "Not found again" is never presented as a verified fix.
 */
export function validateChangeAnalysis(
  value: unknown,
  facts: ChangeFactIndex,
  previousTitles: Map<string, string>,
): { analysis: ChangeAnalysis; issues: ValidationIssue[] } {
  const analysis = parse(ChangeAnalysis, value, 'Change intelligence')
  const issues: ValidationIssue[] = []
  const insights: ChangeInsight[] = []
  for (const [index, raw] of analysis.insights.entries()) {
    const scope = `insight ${index + 1} (${raw.kind})`
    const insight: ChangeInsight = {
      ...raw,
      currentFindingIds: keepKnown(raw.currentFindingIds, normalizeFindingId, new Set(facts.currentFindings.keys()), scope, issues),
      previousFindingIds: keepKnown(raw.previousFindingIds, normalizeFindingId, new Set(facts.previousFindings.keys()), scope, issues),
      journeyKeys: keepKnown(raw.journeyKeys, (k) => k.trim(), new Set(facts.journeys.keys()), scope, issues),
      metricKeys: keepKnown(raw.metricKeys, (k) => k.trim(), new Set(facts.metrics.keys()), scope, issues),
      evidenceIds: keepKnown(raw.evidenceIds, normalizeRef, facts.currentEvidence, scope, issues),
    }
    if (!supported(insight.kind, insight, facts)) {
      issues.push({ scope, message: `Dropped "${raw.title}": the comparison does not show a ${raw.kind} for the cited items` })
      continue
    }
    if (insight.kind === 'not-found-again') {
      // Absence in one audit is not proof of a fix.
      if (insight.basis === 'verified') insight.basis = 'observed'
      if (/\b(fixed|resolved|solved)\b/i.test(insight.title) && !/not found again/i.test(insight.title)) {
        const subject = insight.previousFindingIds.map((id) => previousTitles.get(id)).find(Boolean)
        issues.push({ scope, message: `Title claimed a fix ("${insight.title}"); reworded as not found again` })
        insight.title = subject ? `Not found again: ${subject}`.slice(0, 120) : 'Issue not found again'
      }
    }
    insights.push(insight)
  }
  return { analysis: { ...analysis, insights }, issues }
}

/** Client Brief references must exist: findings, journeys and evidence of this audit only. */
export function validateClientBrief(
  value: unknown,
  refs: { findings: Set<string>; journeys: Set<string>; evidence: Set<string> },
): { brief: ClientBriefContent; issues: ValidationIssue[] } {
  const brief = parse(ClientBriefContent, value, 'Client brief')
  const issues: ValidationIssue[] = []
  const finding = (id: string | null, scope: string): string | null => {
    if (!id) return null
    const normalized = normalizeFindingId(id)
    if (refs.findings.has(normalized)) return normalized
    issues.push({ scope, message: `Removed unknown finding "${id}"` })
    return null
  }
  const evidence = (id: string | null, scope: string): string | null => {
    if (!id) return null
    const normalized = normalizeRef(id)
    if (refs.evidence.has(normalized)) return normalized
    issues.push({ scope, message: `Removed unknown evidence "${id}"` })
    return null
  }
  const journey = (id: string, scope: string): string | null => {
    const normalized = normalizeJourneyId(id)
    if (refs.journeys.has(normalized)) return normalized
    issues.push({ scope, message: `Removed unknown journey "${id}"` })
    return null
  }
  const issuesOf = (list: ClientBriefContent['quick']['topIssues'], scope: string) =>
    list.flatMap((item) => {
      const id = finding(item.findingId, scope)
      return id ? [{ ...item, findingId: id }] : []
    })
  const proofs = (list: ClientBriefContent['quick']['proofPoints'], scope: string) =>
    list.map((p) => ({ ...p, findingId: finding(p.findingId, scope), evidenceId: evidence(p.evidenceId, scope) }))

  const topIssues = issuesOf(brief.quick.topIssues, 'quick.topIssues')
  if (topIssues.length === 0) {
    throw new OutputValidationError('Client brief cites no existing findings', ['quick.topIssues: no valid finding IDs'])
  }
  const primaryJourney = brief.primaryJourney ? journey(brief.primaryJourney.journeyId, 'primaryJourney') : null
  return {
    brief: {
      ...brief,
      primaryJourney: brief.primaryJourney && primaryJourney ? { ...brief.primaryJourney, journeyId: primaryJourney } : null,
      quick: {
        ...brief.quick,
        topIssues,
        bestOpportunity: brief.quick.bestOpportunity
          ? {
              ...brief.quick.bestOpportunity,
              findingIds: brief.quick.bestOpportunity.findingIds.map((id) => finding(id, 'bestOpportunity')).filter((id): id is string => !!id),
            }
          : null,
        proofPoints: proofs(brief.quick.proofPoints, 'quick.proofPoints'),
      },
      meeting: {
        ...brief.meeting,
        journeys: brief.meeting.journeys.flatMap((j) => {
          const id = journey(j.journeyId, 'meeting.journeys')
          return id ? [{ ...j, journeyId: id }] : []
        }),
        topIssues: issuesOf(brief.meeting.topIssues, 'meeting.topIssues'),
        proofToShow: proofs(brief.meeting.proofToShow, 'meeting.proofToShow'),
      },
      technical: {
        items: brief.technical.items.flatMap((item) => {
          const id = finding(item.findingId, 'technical')
          return id ? [{ ...item, findingId: id }] : []
        }),
      },
    },
    issues,
  }
}
