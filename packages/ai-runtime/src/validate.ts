import {
  AuditDraft,
  FinalAudit,
  ReviewResult,
  SEVERITY_RANK,
  type DraftFinding,
  type FinalFinding,
  type FindingBrief,
  type FindingType,
  type Severity,
} from '@audivra/contracts'
import { findingSimilarity, SIMILARITY_THRESHOLD, titleTokens } from '@audivra/insights'

export interface ValidationIssue {
  scope: string
  message: string
}

export class OutputValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message)
    this.name = 'OutputValidationError'
  }
}

/** Normalizes model-written evidence references ("ev-12", " EV-12 ", "EV12") to the canonical "EV-12". */
export function normalizeRef(ref: string): string {
  const match = ref.trim().match(/^ev-?(\d+)$/i)
  return match ? `EV-${Number(match[1])}` : ref.trim()
}

function filterRefs(
  refs: string[],
  existing: Set<string>,
  scope: string,
  issues: ValidationIssue[],
): string[] {
  const kept: string[] = []
  for (const raw of refs) {
    const ref = normalizeRef(raw)
    if (existing.has(ref)) {
      if (!kept.includes(ref)) kept.push(ref)
    } else issues.push({ scope, message: `Rejected nonexistent evidence reference "${raw}"` })
  }
  return kept
}

const DOWNGRADE: Record<FindingType, FindingType> = {
  verified: 'supported-observation',
  'supported-observation': 'inference',
  inference: 'inference',
}

function parseOrThrow<T>(
  schema: {
    safeParse(
      v: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }
  },
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new OutputValidationError(`${label} output failed schema validation`, issues)
  }
  return parsed.data
}

/**
 * Validates an auditor draft: schema, unique IDs and evidence references. Findings that lose all
 * their evidence are downgraded rather than silently presented as verified.
 */
export function validateDraft(
  value: unknown,
  existingRefs: Set<string>,
): { draft: AuditDraft; issues: ValidationIssue[] } {
  const draft = parseOrThrow(AuditDraft, value, 'Auditor')
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()
  const findings: DraftFinding[] = draft.findings.map((finding, index) => {
    let id = finding.id.trim() || `D${index + 1}`
    if (seen.has(id)) {
      issues.push({ scope: id, message: `Duplicate finding ID renamed to ${id}-${index + 1}` })
      id = `${id}-${index + 1}`
    }
    seen.add(id)
    const evidenceIds = filterRefs(finding.evidenceIds, existingRefs, id, issues)
    let { type, confidence } = finding
    if (evidenceIds.length === 0 && type !== 'inference') {
      issues.push({ scope: id, message: `No valid evidence: type downgraded from ${type} to inference` })
      type = 'inference'
      confidence = Math.min(confidence, 0.5)
    }
    return { ...finding, id, evidenceIds, type, confidence }
  })
  return {
    draft: {
      ...draft,
      businessUnderstanding: {
        ...draft.businessUnderstanding,
        evidenceIds: filterRefs(
          draft.businessUnderstanding.evidenceIds,
          existingRefs,
          'businessUnderstanding',
          issues,
        ),
      },
      technologies: draft.technologies.map((t) => ({
        ...t,
        evidenceIds: filterRefs(t.evidenceIds, existingRefs, `technology:${t.name}`, issues),
      })),
      findings,
    },
    issues,
  }
}

export function validateReview(
  value: unknown,
  draft: AuditDraft,
): { review: ReviewResult; issues: ValidationIssue[] } {
  const review = parseOrThrow(ReviewResult, value, 'Reviewer')
  const issues: ValidationIssue[] = []
  const ids = new Set(draft.findings.map((f) => f.id))
  const check = (id: string, scope: string) => {
    if (!ids.has(id)) issues.push({ scope, message: `Reviewer referenced unknown finding "${id}"` })
    return ids.has(id)
  }
  return {
    review: {
      ...review,
      approvedFindings: review.approvedFindings.filter((f) => check(f.findingId, 'approved')),
      rejectedFindings: review.rejectedFindings.filter((f) => check(f.findingId, 'rejected')),
      findingsNeedingVerification: review.findingsNeedingVerification.filter((f) =>
        check(f.findingId, 'verification'),
      ),
      severityAdjustments: review.severityAdjustments.filter((f) => check(f.findingId, 'severity')),
      duplicates: review.duplicates
        .map((d) => ({ ...d, findingIds: d.findingIds.filter((id) => check(id, 'duplicates')) }))
        .filter((d) => d.findingIds.length > 1),
    },
    issues,
  }
}

const mostSevere = (severities: Severity[]): Severity =>
  severities.reduce((a, b) => (SEVERITY_RANK[b] < SEVERITY_RANK[a] ? b : a), 'info' as Severity)

/**
 * Validates the finalizer output against the draft it was derived from. The finalizer may merge,
 * remove and reword — but it cannot invent findings, cite evidence its sources did not cite, or
 * escalate severity beyond what the draft or reviewer supported.
 */
export function validateFinal(
  value: unknown,
  draft: AuditDraft,
  review: ReviewResult | null,
  existingRefs: Set<string>,
): { final: FinalAudit; issues: ValidationIssue[] } {
  const final = parseOrThrow(FinalAudit, normalizeIssueKeys(value), 'Finalizer')
  const issues: ValidationIssue[] = []
  const draftById = new Map(draft.findings.map((f) => [f.id, f]))
  const adjustments = new Map((review?.severityAdjustments ?? []).map((a) => [a.findingId, a.to]))
  const usedIds = new Set<string>()
  const usedKeys = new Set<string>()
  const findings: FinalFinding[] = []

  for (const finding of final.findings) {
    const sources = finding.sourceFindingIds.filter((id) => draftById.has(id))
    if (sources.length === 0) {
      issues.push({
        scope: finding.id,
        message: `Rejected: no valid source draft finding (${finding.sourceFindingIds.join(', ') || 'none'})`,
      })
      continue
    }
    const sourceFindings = sources.map((id) => draftById.get(id)!)
    const allowedEvidence = new Set(sourceFindings.flatMap((f) => f.evidenceIds))
    let evidenceIds = filterRefs(finding.evidenceIds, existingRefs, finding.id, issues).filter((ref) => {
      if (allowedEvidence.has(ref)) return true
      issues.push({ scope: finding.id, message: `Removed evidence ${ref} not cited by its source findings` })
      return false
    })
    if (evidenceIds.length === 0 && allowedEvidence.size > 0) evidenceIds = [...allowedEvidence]

    const ceiling = mostSevere([
      ...sourceFindings.map((f) => f.severity),
      ...sources.map((id) => adjustments.get(id)).filter((s): s is Severity => !!s),
    ])
    let severity = finding.severity
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[ceiling]) {
      issues.push({
        scope: finding.id,
        message: `Severity ${severity} exceeds what sources support; clamped to ${ceiling}`,
      })
      severity = ceiling
    }
    let type = finding.type
    if (evidenceIds.length === 0 && type !== 'inference') type = 'inference'

    let id = finding.id.trim() || `F${findings.length + 1}`
    if (usedIds.has(id)) id = `F${findings.length + 1}`
    usedIds.add(id)
    const issueKey = uniqueKey(finding.issueKey, usedKeys)
    if (issueKey !== finding.issueKey) issues.push({ scope: id, message: `Issue key ${finding.issueKey} was not unique; using ${issueKey}` })
    findings.push({ ...finding, id, issueKey, sourceFindingIds: sources, evidenceIds, severity, type })
  }

  const finalIds = new Set(findings.map((f) => f.id))
  return {
    final: {
      ...final,
      businessUnderstanding: {
        ...final.businessUnderstanding,
        evidenceIds: filterRefs(
          final.businessUnderstanding.evidenceIds,
          existingRefs,
          'businessUnderstanding',
          issues,
        ),
      },
      technologies: final.technologies.map((t) => ({
        ...t,
        evidenceIds: filterRefs(t.evidenceIds, existingRefs, `technology:${t.name}`, issues),
      })),
      findings,
      opportunities: final.opportunities.map((o) => ({
        ...o,
        relatedFindingIds: o.relatedFindingIds.filter((id) => finalIds.has(id)),
      })),
    },
    issues,
  }
}

/**
 * Deterministic fallback when the finalizer is unavailable: applies the reviewer's decisions
 * mechanically to the draft. Clearly labelled in the summary; never adds content.
 */
export function fallbackFinal(
  draft: AuditDraft,
  review: ReviewResult | null,
  previous: FindingBrief[] = [],
): FinalAudit {
  const rejected = new Set(review?.rejectedFindings.map((r) => r.findingId) ?? [])
  const approved = new Set(review?.approvedFindings.map((a) => a.findingId) ?? [])
  const needsCheck = new Set(review?.findingsNeedingVerification.map((v) => v.findingId) ?? [])
  const adjustments = new Map((review?.severityAdjustments ?? []).map((a) => [a.findingId, a.to]))
  const mergedInto = new Map<string, string>()
  for (const group of review?.duplicates ?? []) {
    const [keep, ...rest] = group.findingIds
    if (keep) rest.forEach((id) => mergedInto.set(id, keep))
  }

  const byId = new Map<string, DraftFinding & { sources: string[] }>()
  for (const finding of draft.findings) {
    if (rejected.has(finding.id)) continue
    const target = mergedInto.get(finding.id)
    if (target && byId.has(target)) {
      const host = byId.get(target)!
      host.affectedUrls = [...new Set([...host.affectedUrls, ...finding.affectedUrls])]
      host.evidenceIds = [...new Set([...host.evidenceIds, ...finding.evidenceIds])]
      host.sources.push(finding.id)
      continue
    }
    byId.set(finding.id, { ...finding, sources: [finding.id] })
  }

  const ordered = [...byId.values()]
    .map((f) => {
      const severity = adjustments.get(f.id) ?? f.severity
      const unverified = needsCheck.has(f.id)
      return {
        ...f,
        severity,
        type: unverified ? DOWNGRADE[f.type] : f.type,
        confidence: unverified ? Math.round(f.confidence * 0.8 * 100) / 100 : f.confidence,
        verificationStatus: approved.has(f.id)
          ? ('reviewer-approved' as const)
          : adjustments.has(f.id)
            ? ('revised' as const)
            : ('unreviewed' as const),
      }
    })
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.confidence - a.confidence)

  const usedKeys = new Set<string>()
  const findings: FinalFinding[] = ordered.map((f, index) => {
    const { sources, id: _draftId, ...rest } = f
    const issueKey = uniqueKey(stableIssueKey(f, previous), usedKeys)
    return { ...rest, id: `F${index + 1}`, issueKey, sourceFindingIds: sources }
  })
  const counts = findings.reduce<Record<string, number>>(
    (acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }),
    {},
  )
  return {
    executiveSummary: [
      draft.businessUnderstanding.summary,
      `This audit identified ${findings.length} findings (${
        ['critical', 'high', 'medium', 'low', 'info']
          .filter((s) => counts[s])
          .map((s) => `${counts[s]} ${s}`)
          .join(', ') || 'none'
      }).`,
      'Note: the AI finalization step did not complete, so this summary and ordering were assembled automatically from the reviewed draft. Review the findings for wording before sharing.',
    ].join('\n\n'),
    businessUnderstanding: draft.businessUnderstanding,
    importantPageTypes: draft.importantPageTypes,
    technologies: draft.technologies,
    findings,
    opportunities: findings
      .filter((f) => f.opportunity)
      .map((f) => ({
        title: f.opportunity!.title,
        why: f.whyItMatters,
        scope: f.opportunity!.description,
        impact: f.opportunity!.impact,
        effort: f.opportunity!.effort,
        relatedFindingIds: [f.id],
      }))
      .sort(
        (a, b) => ['high', 'medium', 'low'].indexOf(a.impact) - ['high', 'medium', 'low'].indexOf(b.impact),
      ),
    limitations: [
      ...draft.limitations.map((text) => ({ kind: 'could-not-verify' as const, text })),
      { kind: 'environment' as const, text: 'AI finalization did not complete; findings reflect the reviewed draft.' },
    ],
    pagesInspected: draft.pagesInspected,
  }
}

/** Kebab-case issue key from category + the most informative title words (deterministic). */
export function deriveIssueKey(category: string, title: string): string {
  const words = [...titleTokens(title)].filter((w) => /^[a-z0-9]+$/.test(w)).slice(0, 5)
  const base = [category.toLowerCase().replace(/[^a-z0-9]+/g, '-'), ...words].join('-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const parts = base.split('-').filter(Boolean).slice(0, 8)
  return parts.length ? parts.join('-') : 'finding'
}

/** Reuses the previous audit's key for the same issue (by similarity), otherwise derives a new one. */
export function stableIssueKey(finding: Pick<DraftFinding, 'title' | 'category' | 'severity' | 'affectedUrls'>, previous: FindingBrief[]): string {
  const brief: FindingBrief = { ref: '', title: finding.title, severity: finding.severity, category: finding.category, issueKey: null, affectedUrls: finding.affectedUrls }
  let best: { key: string; score: number } | null = null
  for (const prev of previous) {
    if (!prev.issueKey) continue
    const score = findingSimilarity(brief, prev)
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) best = { key: prev.issueKey, score }
  }
  return best?.key ?? deriveIssueKey(finding.category, finding.title)
}

/** Coerces model-written issue keys into the kebab-case format before schema validation. */
function normalizeIssueKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { findings?: unknown }).findings)) return value
  const record = value as { findings: unknown[] }
  return {
    ...record,
    findings: record.findings.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw
      const f = raw as Record<string, unknown>
      const cleaned =
        typeof f.issueKey === 'string'
          ? f.issueKey
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .split('-')
              .filter(Boolean)
              .slice(0, 8)
              .join('-')
          : ''
      return {
        ...f,
        issueKey: cleaned || deriveIssueKey(typeof f.category === 'string' ? f.category : 'finding', typeof f.title === 'string' ? f.title : ''),
      }
    }),
  }
}

function uniqueKey(key: string, used: Set<string>): string {
  let candidate = key
  for (let n = 2; used.has(candidate); n++) candidate = `${key.split('-').slice(0, 7).join('-')}-${n}`
  used.add(candidate)
  return candidate
}
