import {
  SEVERITY_RANK,
  type AuditComparison,
  type EvidenceItem,
  type FindingBrief,
  type FindingChangeStatus,
  type FindingItem,
  type FindingTimeline,
  type JourneyChange,
  type JourneyDimension,
  type JourneyHealthStatus,
  type JourneyItem,
  type MetricChange,
} from '@audivra/contracts'
import { evidenceKind, pagePath } from './catalog.ts'
import { matchFindings } from './compare.ts'

/*
 * Deterministic change facts beyond findings and metrics: journeys, tracking tools and the history
 * of each issue across a site's audits. Change Intelligence explains these facts; it never alters them.
 */

/** Tracking tools observed on page load (baseline tracking evidence), by name. */
export function trackingTools(evidence: EvidenceItem[]): string[] {
  const names = new Set<string>()
  for (const item of evidence) {
    if (evidenceKind(item) !== 'tracking') continue
    const detected = Array.isArray(item.metadata.detected) ? (item.metadata.detected as { name?: unknown }[]) : []
    for (const d of detected) if (typeof d.name === 'string' && d.name.trim()) names.add(d.name.trim())
  }
  return [...names].sort()
}

export function compareNames(current: string[], previous: string[]): { added: string[]; removed: string[]; unchanged: string[] } {
  const norm = (s: string) => s.trim().toLowerCase()
  const prev = new Set(previous.map(norm))
  const cur = new Set(current.map(norm))
  return {
    added: current.filter((n) => !prev.has(norm(n))),
    removed: previous.filter((n) => !cur.has(norm(n))),
    unchanged: current.filter((n) => prev.has(norm(n))),
  }
}

/** A step's identity across audits: its page path when it is on the site, else its label. */
function stepKey(step: JourneyItem['steps'][number]): string {
  return step.url ? `url:${pagePath(step.url)}` : `label:${step.label.trim().toLowerCase()}`
}

function pathSimilarity(a: JourneyItem, b: JourneyItem): number {
  const sa = new Set(a.steps.map(stepKey))
  const sb = new Set(b.steps.map(stepKey))
  let inter = 0
  for (const k of sa) if (sb.has(k)) inter++
  return sa.size + sb.size - inter === 0 ? 0 : inter / (sa.size + sb.size - inter)
}

function healthMap(journey: JourneyItem): Map<JourneyDimension, JourneyHealthStatus> {
  return new Map(journey.health.map((h) => [h.dimension, h.status]))
}

/**
 * Journeys compared across two audits: matched by journey key first, then (same type) by the overlap
 * of their step paths. Health changes list only dimensions whose status differs.
 */
export function compareJourneys(current: JourneyItem[], previous: JourneyItem[]): JourneyChange[] {
  const usedPrev = new Set<string>()
  const pairs: { cur: JourneyItem; prev: JourneyItem | null }[] = []
  for (const cur of current) {
    const byKey = previous.find((p) => p.journeyKey === cur.journeyKey && !usedPrev.has(p.ref))
    if (byKey) {
      usedPrev.add(byKey.ref)
      pairs.push({ cur, prev: byKey })
    } else pairs.push({ cur, prev: null })
  }
  for (const pair of pairs) {
    if (pair.prev) continue
    let best: { prev: JourneyItem; score: number } | null = null
    for (const prev of previous) {
      if (usedPrev.has(prev.ref) || prev.type !== pair.cur.type) continue
      const score = pathSimilarity(pair.cur, prev)
      if (score >= 0.5 && (!best || score > best.score)) best = { prev, score }
    }
    if (best) {
      usedPrev.add(best.prev.ref)
      pair.prev = best.prev
    }
  }

  const changes: JourneyChange[] = pairs.map(({ cur, prev }) => {
    if (!prev) {
      return {
        journeyKey: cur.journeyKey,
        name: cur.name,
        type: cur.type,
        status: 'new',
        currentRef: cur.ref,
        previousRef: null,
        primaryBefore: null,
        primaryAfter: cur.isPrimary,
        pathBefore: null,
        pathAfter: cur.steps.map((s) => s.label),
        pathChanged: false,
        health: [],
        steps: [],
      }
    }
    const pathChanged = prev.steps.map(stepKey).join('>') !== cur.steps.map(stepKey).join('>')
    const before = healthMap(prev)
    const after = healthMap(cur)
    const dimensions = new Set([...before.keys(), ...after.keys()])
    const health = [...dimensions]
      .map((dimension) => ({ dimension, before: before.get(dimension) ?? 'not-assessed', after: after.get(dimension) ?? 'not-assessed' }))
      .filter((h) => h.before !== h.after)
    const prevSteps = new Map(prev.steps.map((s) => [stepKey(s), s]))
    const steps = cur.steps
      .map((s) => ({ label: s.label, before: prevSteps.get(stepKey(s))?.status ?? null, after: s.status }))
      .filter((s) => s.before !== null && s.before !== s.after)
    const changed = pathChanged || health.length > 0 || steps.length > 0 || prev.isPrimary !== cur.isPrimary
    return {
      journeyKey: cur.journeyKey,
      name: cur.name,
      type: cur.type,
      status: changed ? 'changed' : 'unchanged',
      currentRef: cur.ref,
      previousRef: prev.ref,
      primaryBefore: prev.isPrimary,
      primaryAfter: cur.isPrimary,
      pathBefore: prev.steps.map((s) => s.label),
      pathAfter: cur.steps.map((s) => s.label),
      pathChanged,
      health,
      steps,
    }
  })
  for (const prev of previous) {
    if (usedPrev.has(prev.ref)) continue
    changes.push({
      journeyKey: prev.journeyKey,
      name: prev.name,
      type: prev.type,
      status: 'not-found-again',
      currentRef: null,
      previousRef: prev.ref,
      primaryBefore: prev.isPrimary,
      primaryAfter: null,
      pathBefore: prev.steps.map((s) => s.label),
      pathAfter: null,
      pathChanged: false,
      health: [],
      steps: [],
    })
  }
  return changes
}

export interface TimelineAudit {
  id: string
  date: string
  findings: FindingBrief[]
}

/**
 * The history of each issue across a site's finished audits (oldest first): consecutive audits are
 * matched with the same rules as comparisons (issue key, then similarity). An issue that disappears
 * is "not found" — never "fixed" — and one that returns is "detected again". Info notes are left out.
 */
export function buildFindingTimelines(audits: TimelineAudit[], limit = 60): FindingTimeline[] {
  interface Chain {
    id: string
    last: FindingBrief
    timeline: FindingTimeline
  }
  const chains: Chain[] = []
  audits.forEach((audit, index) => {
    const current = audit.findings.filter((f) => f.severity !== 'info')
    // Compare against each chain's most recent detection, keyed by chain so refs never collide.
    const candidates = chains.map((c) => ({ ...c.last, ref: c.id }))
    const matches = matchFindings(current, candidates)
    const matchedChains = new Set<string>()
    for (const change of matches) {
      if (change.current && change.previous) {
        const chain = chains.find((c) => c.id === change.previous!.ref)!
        matchedChains.add(chain.id)
        const lastEntry = chain.timeline.entries.at(-1)
        chain.timeline.entries.push({
          auditId: audit.id,
          date: audit.date,
          status: lastEntry?.status === 'not-found' ? 'detected-again' : 'detected',
          ref: change.current.ref,
          severity: change.current.severity,
        })
        chain.last = change.current
        chain.timeline.title = change.current.title
        chain.timeline.category = change.current.category
        chain.timeline.key = change.current.issueKey ?? chain.timeline.key
      } else if (change.current) {
        const id = `chain-${chains.length + 1}`
        matchedChains.add(id)
        chains.push({
          id,
          last: change.current,
          timeline: {
            key: change.current.issueKey ?? id,
            title: change.current.title,
            category: change.current.category,
            currentRef: null,
            entries: [{ auditId: audit.id, date: audit.date, status: 'detected', ref: change.current.ref, severity: change.current.severity }],
          },
        })
      }
    }
    for (const chain of chains) {
      if (matchedChains.has(chain.id)) continue
      chain.timeline.entries.push({ auditId: audit.id, date: audit.date, status: 'not-found', ref: null, severity: null })
    }
    if (index === audits.length - 1) {
      for (const chain of chains) chain.timeline.currentRef = chain.timeline.entries.at(-1)?.ref ?? null
    }
  })
  const rank = (t: FindingTimeline) => {
    const last = t.entries.at(-1)!
    const severity = t.entries.reduce((best, e) => (e.severity && SEVERITY_RANK[e.severity] < best ? SEVERITY_RANK[e.severity] : best), 9)
    return (last.status === 'not-found' ? 10 : 0) + severity
  }
  return chains
    .map((c) => c.timeline)
    .sort((a, b) => rank(a) - rank(b) || b.entries.filter((e) => e.status !== 'not-found').length - a.entries.filter((e) => e.status !== 'not-found').length)
    .slice(0, limit)
}

/** What the deterministic comparison established, indexed for validating the AI's interpretation. */
export interface ChangeFactIndex {
  currentFindings: Map<string, FindingChangeStatus>
  previousFindings: Map<string, FindingChangeStatus>
  metrics: Map<string, MetricChange['direction']>
  journeys: Map<string, JourneyChange['status']>
  trackingChanged: boolean
  technologyChanged: boolean
  coverageChanged: boolean
  currentEvidence: Set<string>
}

export function changeFactIndex(comparison: AuditComparison, currentEvidence: string[]): ChangeFactIndex {
  const currentFindings = new Map<string, FindingChangeStatus>()
  const previousFindings = new Map<string, FindingChangeStatus>()
  for (const change of comparison.findings) {
    if (change.current) currentFindings.set(change.current.ref, change.status)
    if (change.previous) previousFindings.set(change.previous.ref, change.status)
  }
  return {
    currentFindings,
    previousFindings,
    metrics: new Map(comparison.metrics.map((m) => [m.key, m.direction])),
    journeys: new Map(comparison.journeys.map((j) => [j.journeyKey, j.status])),
    trackingChanged: comparison.tracking.added.length + comparison.tracking.removed.length > 0,
    technologyChanged: comparison.technologies.added.length + comparison.technologies.removed.length > 0,
    coverageChanged: comparison.coverage.some((c) => c.before !== c.after),
    currentEvidence: new Set(currentEvidence),
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The deterministic facts as compact text for the Change Intelligence interpreter. */
export function changeFactsText(input: {
  comparison: AuditComparison
  currentFindings: FindingItem[]
  previousFindings: FindingItem[]
  currentJourneys: JourneyItem[]
  currentEvidence: EvidenceItem[]
}): string {
  const { comparison: c } = input
  const cur = new Map(input.currentFindings.map((f) => [f.ref, f]))
  const prev = new Map(input.previousFindings.map((f) => [f.ref, f]))
  const findingLine = (status: string, change: AuditComparison['findings'][number]) => {
    const after = change.current ? cur.get(change.current.ref) : undefined
    const before = change.previous ? prev.get(change.previous.ref) : undefined
    const subject = after ?? before
    if (!subject) return null
    const severity =
      change.previous && change.current && change.previous.severity !== change.current.severity
        ? `${change.previous.severity} → ${change.current.severity}`
        : subject.severity
    const refs = [change.current ? `current ${change.current.ref}` : null, change.previous ? `previous ${change.previous.ref}` : null].filter(Boolean).join(', ')
    const evidence = after?.evidenceRefs.length ? ` · evidence ${after.evidenceRefs.slice(0, 4).join(', ')}` : ''
    return `- [${status}] ${subject.title} (${severity} · ${subject.category}${subject.issueKey ? ` · key ${subject.issueKey}` : ''}) — ${refs}${evidence}\n  Observed now: ${after ? clip(oneLine(after.observed), 240) : '(not reported)'}${before ? `\n  Observed before: ${clip(oneLine(before.observed), 200)}` : ''}`
  }
  const groups: [string, FindingChangeStatus][] = [
    ['regressed', 'regressed'],
    ['new', 'new'],
    ['improved', 'improved'],
    ['not found again', 'resolved'],
    ['still present', 'unchanged'],
  ]
  const findingText = groups
    .map(([label, status]) => {
      const lines = c.findings.filter((f) => f.status === status).map((f) => findingLine(label, f)).filter(Boolean)
      return lines.length ? `### Findings ${label} (${lines.length})\n${lines.join('\n')}` : null
    })
    .filter(Boolean)
    .join('\n\n')
  const metrics = c.metrics
    .filter((m) => m.direction !== 'unchanged')
    .map((m) => `- ${m.key} — ${m.label}: ${m.before ?? 'n/a'} → ${m.after ?? 'n/a'} ${m.unit === 'none' ? '' : m.unit} (${m.direction})`)
  const journeys = c.journeys.map((j) => {
    const parts = [`- ${j.journeyKey} — ${j.name} (${j.type}): ${j.status}`]
    if (j.primaryBefore !== j.primaryAfter && j.primaryBefore !== null && j.primaryAfter !== null) parts.push(`  primary: ${j.primaryBefore} → ${j.primaryAfter}`)
    if (j.pathChanged) parts.push(`  path before: ${j.pathBefore?.join(' → ')}\n  path now: ${j.pathAfter?.join(' → ')}`)
    else if (j.pathAfter) parts.push(`  path: ${j.pathAfter.join(' → ')}`)
    for (const h of j.health) parts.push(`  ${h.dimension}: ${h.before} → ${h.after}`)
    for (const s of j.steps) parts.push(`  step "${s.label}": ${s.before} → ${s.after}`)
    return parts.join('\n')
  })
  const coverage = c.coverage.filter((x) => x.before !== x.after).map((x) => `- ${x.label}: ${x.before ?? 'not recorded'} → ${x.after ?? 'not recorded'}`)
  const evidenceRefs = new Set(input.currentFindings.flatMap((f) => f.evidenceRefs))
  const evidence = input.currentEvidence
    .filter((e) => evidenceRefs.has(e.ref))
    .slice(0, 60)
    .map((e) => `- ${e.ref}: ${clip(oneLine(e.title), 140)}`)
  const journeysNow = input.currentJourneys.map(
    (j) => `- ${j.journeyKey}${j.isPrimary ? ' (primary)' : ''}: ${j.steps.map((s) => `${s.label}[${s.status}]`).join(' → ')}`,
  )
  return [
    `Previous audit: ${c.previous.createdAt.slice(0, 10)} (${c.previous.findingCount} findings). Current audit: ${c.current.createdAt.slice(0, 10)} (${c.current.findingCount} findings).`,
    `Summary: ${c.summary.new} new, ${c.summary.regressed} regressed, ${c.summary.improved} improved, ${c.summary.unchanged} still present, ${c.summary.resolved} not found again.`,
    findingText || '### Findings\n(no finding changes)',
    `### Measurements beyond lab noise\n${metrics.join('\n') || '(none)'}`,
    `### Journeys\n${journeys.join('\n') || '(no journeys recorded in one or both audits)'}`,
    `### Journeys in the current audit\n${journeysNow.join('\n') || '(none)'}`,
    `### Tracking tools on page load\nadded: ${c.tracking.added.join(', ') || 'none'} · removed: ${c.tracking.removed.join(', ') || 'none'} · unchanged: ${c.tracking.unchanged.join(', ') || 'none'}`,
    `### Technologies\nadded: ${c.technologies.added.join(', ') || 'none'} · removed: ${c.technologies.removed.join(', ') || 'none'}`,
    `### Coverage differences (checks that ran differently)\n${coverage.join('\n') || '(none)'}`,
    `### Current evidence cited by findings\n${evidence.join('\n') || '(none)'}`,
  ].join('\n\n')
}
