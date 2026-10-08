import {
  SEVERITY_RANK,
  type AuditComparison,
  type CoverageItem,
  type EvidenceItem,
  type FindingBrief,
  type FindingChange,
  type MetricChange,
  type ScreenshotPair,
  type ValueUnit,
} from '@audivra/contracts'
import { pagePath } from './catalog.ts'
import { IN_PROGRESS } from './coverage.ts'

const STOPWORDS = new Set(
  'the and for with from that this are was were has have not but its into over under than then them they their there these those which while what when where who whom why how all any can could should would may might must only also very more most less least such each other both few many much some same own just about above below between through during before after again further once here off out per via on in at to of by is be as or an a no nor too does did doing done'.split(' '),
)

/** Meaningful lower-cased title tokens (numbers and stopwords dropped, plural "s" trimmed). */
export function titleTokens(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t))
  return new Set(tokens)
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** Similarity of two findings from different audits of the same site (0..1). */
export function findingSimilarity(a: FindingBrief, b: FindingBrief): number {
  let score = a.category === b.category ? 0.3 : 0
  score += 0.5 * jaccard(titleTokens(a.title), titleTokens(b.title))
  const pa = new Set(a.affectedUrls.map(pagePath))
  const pb = new Set(b.affectedUrls.map(pagePath))
  if (pa.size && pb.size) score += 0.2 * jaccard(pa, pb)
  return Math.round(score * 1000) / 1000
}

export const SIMILARITY_THRESHOLD = 0.55

/**
 * Matches findings across audits: exact issueKey first, then greedy best-similarity pairs above the
 * threshold. Unmatched current findings are new; unmatched previous findings are resolved.
 */
export function matchFindings(current: FindingBrief[], previous: FindingBrief[]): FindingChange[] {
  const changes: FindingChange[] = []
  const usedPrev = new Set<string>()
  const usedCur = new Set<string>()

  const classify = (cur: FindingBrief, prev: FindingBrief): FindingChange['status'] => {
    const delta = SEVERITY_RANK[cur.severity] - SEVERITY_RANK[prev.severity]
    return delta === 0 ? 'unchanged' : delta > 0 ? 'improved' : 'regressed'
  }

  for (const cur of current) {
    if (!cur.issueKey) continue
    const prev = previous.find((p) => p.issueKey === cur.issueKey && !usedPrev.has(p.ref))
    if (!prev) continue
    usedPrev.add(prev.ref)
    usedCur.add(cur.ref)
    changes.push({ status: classify(cur, prev), current: cur, previous: prev, matchedBy: 'issue-key', matchScore: 1 })
  }

  const pairs: { cur: FindingBrief; prev: FindingBrief; score: number }[] = []
  for (const cur of current) {
    if (usedCur.has(cur.ref)) continue
    for (const prev of previous) {
      if (usedPrev.has(prev.ref)) continue
      // Two keyed findings with different keys are different issues by definition.
      if (cur.issueKey && prev.issueKey && cur.issueKey !== prev.issueKey) continue
      const score = findingSimilarity(cur, prev)
      if (score >= SIMILARITY_THRESHOLD) pairs.push({ cur, prev, score })
    }
  }
  pairs.sort((a, b) => b.score - a.score)
  for (const { cur, prev, score } of pairs) {
    if (usedCur.has(cur.ref) || usedPrev.has(prev.ref)) continue
    usedCur.add(cur.ref)
    usedPrev.add(prev.ref)
    changes.push({ status: classify(cur, prev), current: cur, previous: prev, matchedBy: 'similarity', matchScore: score })
  }

  for (const cur of current) if (!usedCur.has(cur.ref)) changes.push({ status: 'new', current: cur, previous: null, matchedBy: null, matchScore: null })
  for (const prev of previous) if (!usedPrev.has(prev.ref)) changes.push({ status: 'resolved', current: null, previous: prev, matchedBy: null, matchScore: null })

  const order = { regressed: 0, new: 1, improved: 2, resolved: 3, unchanged: 4 }
  return changes.sort((a, b) => order[a.status] - order[b.status])
}

export interface MetricSnapshot {
  key: string
  label: string
  unit: ValueUnit
  lowerIsBetter: boolean
  /** Changes smaller than this (absolute) are lab noise and count as unchanged. */
  noise: number
  value: number | null
}

export function compareMetrics(current: MetricSnapshot[], previous: MetricSnapshot[]): MetricChange[] {
  const prevByKey = new Map(previous.map((m) => [m.key, m]))
  const changes: MetricChange[] = []
  for (const cur of current) {
    const prev = prevByKey.get(cur.key)
    const before = prev?.value ?? null
    const after = cur.value
    if (before === null && after === null) continue
    let direction: MetricChange['direction']
    let delta: number | null = null
    if (before === null) direction = 'new'
    else if (after === null) direction = 'missing'
    else {
      delta = Math.round((after - before) * 1000) / 1000
      if (Math.abs(delta) <= cur.noise) direction = 'unchanged'
      else direction = (delta < 0) === cur.lowerIsBetter ? 'improved' : 'regressed'
    }
    changes.push({ key: cur.key, label: cur.label, unit: cur.unit, lowerIsBetter: cur.lowerIsBetter, before, after, delta, direction })
  }
  return changes
}

function viewportOf(e: EvidenceItem): 'desktop' | 'mobile' | null {
  const text = `${String(e.metadata.viewport ?? '')} ${e.title}`
  if (/390|mobile/i.test(text)) return 'mobile'
  if (/1440|desktop/i.test(text)) return 'desktop'
  return null
}

/** Pairs comparable screenshots (same page path + viewport) across two audits. Baseline captures preferred. */
export function pairScreenshots(
  current: { auditId: string; date: string; evidence: EvidenceItem[] },
  previous: { auditId: string; date: string; evidence: EvidenceItem[] },
  limit = 6,
): ScreenshotPair[] {
  const index = (items: EvidenceItem[]) => {
    const map = new Map<string, EvidenceItem>()
    const shots = items
      .filter((e) => e.type === 'screenshot' && e.artifactPath && e.url && /\.(png|jpe?g|webp)$/i.test(e.artifactPath))
      .sort((a, b) => (a.source === 'baseline' ? 0 : 1) - (b.source === 'baseline' ? 0 : 1))
    for (const shot of shots) {
      const viewport = viewportOf(shot)
      if (!viewport) continue
      const key = `${pagePath(shot.url)}|${viewport}`
      if (!map.has(key)) map.set(key, shot)
    }
    return map
  }
  const cur = index(current.evidence)
  const prev = index(previous.evidence)
  const pairs: ScreenshotPair[] = []
  for (const [key, after] of cur) {
    const before = prev.get(key)
    if (!before) continue
    const [url, viewport] = key.split('|') as [string, string]
    pairs.push({
      url,
      viewport,
      before: { auditId: previous.auditId, evidenceRef: before.ref, artifactPath: before.artifactPath!, date: previous.date },
      after: { auditId: current.auditId, evidenceRef: after.ref, artifactPath: after.artifactPath!, date: current.date },
    })
    if (pairs.length >= limit) break
  }
  // Desktop/mobile home first, then others.
  return pairs.sort((a, b) => (a.url === '/' ? -1 : 0) - (b.url === '/' ? -1 : 0))
}

export function compareTechnologies(current: string[], previous: string[]): AuditComparison['technologies'] {
  // "Next.js (App Router, RSC)" and "Next.js (App Router, Turbopack build)" are the same technology.
  const norm = (s: string) =>
    s
      .replace(/\s*\([^)]*\)/g, '')
      .trim()
      .toLowerCase()
  const cur = new Map(current.map((t) => [norm(t), t]))
  const prev = new Map(previous.map((t) => [norm(t), t]))
  return {
    added: [...cur.entries()].filter(([k]) => !prev.has(k)).map(([, v]) => v),
    removed: [...prev.entries()].filter(([k]) => !cur.has(k)).map(([, v]) => v),
    unchanged: [...cur.entries()].filter(([k]) => prev.has(k)).map(([, v]) => v),
  }
}

/** Coverage per capability; a capability still in progress (the stage running the comparison) is left out. */
export function compareCoverage(current: CoverageItem[], previous: CoverageItem[]): AuditComparison['coverage'] {
  const prev = new Map(previous.map((c) => [c.capability, c]))
  return current
    .filter((c) => !(c.status === 'partial' && c.reason === IN_PROGRESS))
    .map((c) => ({ capability: c.capability, label: c.label, before: prev.get(c.capability)?.status ?? null, after: c.status }))
}

export function summarize(changes: FindingChange[]): AuditComparison['summary'] {
  const summary = { new: 0, resolved: 0, improved: 0, regressed: 0, unchanged: 0 }
  for (const change of changes) summary[change.status]++
  return summary
}
