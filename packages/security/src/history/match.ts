import type { FindingMatch, SecurityFinding } from '@audivra/contracts'

/*
 * Phase 6C — historical matching with an explicit basis. Exact stable issue keys (from 6A) always win; only
 * when they do not match does a cautious similarity layer apply, and it NEVER merges across categories or
 * without a shared affected entity. A manual analyst link overrides both. Every match records its basis,
 * confidence and reason, so a history row is explainable.
 */

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  )

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size && !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export interface ManualLink {
  previousIssueKey: string
  currentIssueKey: string
}

/**
 * Pair the findings of two assessments. Returns one match per previous finding (matched or unmatched) plus
 * one "new" match per current finding that matched no previous one.
 */
export function matchFindings(previous: readonly SecurityFinding[], current: readonly SecurityFinding[], manualLinks: readonly ManualLink[] = []): FindingMatch[] {
  const matches: FindingMatch[] = []
  const currentByKey = new Map(current.map((f) => [f.issueKey, f]))
  const usedCurrent = new Set<string>()
  const manual = new Map(manualLinks.map((l) => [l.previousIssueKey, l.currentIssueKey]))

  for (const prev of previous) {
    // 1. Exact issue-key match.
    const exact = currentByKey.get(prev.issueKey)
    if (exact && !usedCurrent.has(exact.id)) {
      usedCurrent.add(exact.id)
      matches.push({ basis: 'exact-issue-key', confidence: 1, previousFindingId: prev.id, currentFindingId: exact.id, previousIssueKey: prev.issueKey, currentIssueKey: exact.issueKey, reason: 'Identical stable issue key' })
      continue
    }
    // 2. Manual analyst link.
    const linkedKey = manual.get(prev.issueKey)
    const linked = linkedKey ? current.find((f) => f.issueKey === linkedKey && !usedCurrent.has(f.id)) : undefined
    if (linked) {
      usedCurrent.add(linked.id)
      matches.push({ basis: 'manual-link', confidence: 1, previousFindingId: prev.id, currentFindingId: linked.id, previousIssueKey: prev.issueKey, currentIssueKey: linked.issueKey, reason: 'Linked by an analyst decision' })
      continue
    }
    // 3. Cautious semantic match — same category AND a shared affected entity, never a blind title match.
    const prevKeys = new Set(prev.affectedEntities.map((e) => e.key))
    const prevTitle = tokens(prev.title)
    let best: { finding: SecurityFinding; score: number } | null = null
    for (const cur of current) {
      if (usedCurrent.has(cur.id) || cur.category !== prev.category) continue
      const curKeys = new Set(cur.affectedEntities.map((e) => e.key))
      const entityOverlap = jaccard(prevKeys, curKeys)
      const sharesEntity = [...prevKeys].some((k) => curKeys.has(k))
      if (!sharesEntity) continue
      const score = 0.6 * entityOverlap + 0.4 * jaccard(prevTitle, tokens(cur.title))
      if (!best || score > best.score) best = { finding: cur, score }
    }
    if (best && best.score >= 0.3) {
      usedCurrent.add(best.finding.id)
      matches.push({
        basis: 'semantic-match',
        confidence: Math.min(0.85, 0.45 + best.score * 0.4),
        previousFindingId: prev.id,
        currentFindingId: best.finding.id,
        previousIssueKey: prev.issueKey,
        currentIssueKey: best.finding.issueKey,
        reason: `Same category and a shared affected entity (similarity ${best.score.toFixed(2)})`,
      })
      continue
    }
    // 4. No current match.
    matches.push({ basis: 'unmatched', confidence: 0, previousFindingId: prev.id, currentFindingId: null, previousIssueKey: prev.issueKey, currentIssueKey: null, reason: 'No matching current finding' })
  }

  // Current findings that matched nothing are new.
  for (const cur of current) {
    if (usedCurrent.has(cur.id)) continue
    matches.push({ basis: 'unmatched', confidence: 0, previousFindingId: null, currentFindingId: cur.id, previousIssueKey: null, currentIssueKey: cur.issueKey, reason: 'No matching previous finding' })
  }
  return matches
}
