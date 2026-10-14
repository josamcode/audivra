import type {
  AssessmentComparisonSummary,
  FindingComparisonClass,
  FindingComparisonEntry,
  FindingMatch,
  FindingSideRef,
  RetestResult,
  SecurityFinding,
  SecurityFindingChange,
} from '@audivra/contracts'
import { SEVERITY_RANK } from '@audivra/contracts'

/*
 * Phase 6C — classify each matched finding across two assessments: new / still-present / fixed / changed /
 * regressed / cannot-reproduce / not-tested / unmatched-historical.
 *
 * The central safety rule: a previous finding that is simply ABSENT from the current assessment is NOT a fix.
 * It is `fixed` only when a retest result for its issue proves it, `cannot-reproduce` when a retest says so,
 * and otherwise `not-tested`. "Not observed again" never collapses into "fixed".
 */

const sideRef = (f: SecurityFinding): FindingSideRef => ({ findingId: f.id, issueKey: f.issueKey, title: f.title, category: f.category, severity: f.severity, verificationState: f.verificationState })

/** Attribute differences between a matched previous and current finding. */
function diffFindings(prev: SecurityFinding, cur: SecurityFinding): SecurityFindingChange[] {
  const changes: SecurityFindingChange[] = []
  const prevKeys = prev.affectedEntities.map((e) => e.key).sort().join(',')
  const curKeys = cur.affectedEntities.map((e) => e.key).sort().join(',')
  if (prevKeys !== curKeys) {
    const prevRes = prev.affectedEntities.filter((e) => e.kind === 'resource').map((e) => e.label).join(', ')
    const curRes = cur.affectedEntities.filter((e) => e.kind === 'resource').map((e) => e.label).join(', ')
    if (prevRes !== curRes) changes.push({ aspect: 'resource', from: prevRes || '—', to: curRes || '—', detail: 'Affected resource(s) differ' })
    const prevRoles = prev.affectedEntities.filter((e) => e.kind === 'role' || e.kind === 'identity').map((e) => e.label).join(', ')
    const curRoles = cur.affectedEntities.filter((e) => e.kind === 'role' || e.kind === 'identity').map((e) => e.label).join(', ')
    if (prevRoles !== curRoles) changes.push({ aspect: 'role', from: prevRoles || '—', to: curRoles || '—', detail: 'Affected identity/role differ' })
    if (!changes.length) changes.push({ aspect: 'scope', from: prevKeys, to: curKeys, detail: 'Affected entities differ' })
  }
  if (prev.severity !== cur.severity) changes.push({ aspect: 'severity', from: prev.severity, to: cur.severity, detail: SEVERITY_RANK[cur.severity] < SEVERITY_RANK[prev.severity] ? 'Severity increased' : 'Severity decreased' })
  if (prev.verificationState !== cur.verificationState) changes.push({ aspect: 'verification', from: prev.verificationState, to: cur.verificationState, detail: 'Verification state changed' })
  return changes
}

export interface ClassifyOptions {
  /** Retest results concerning these issues (any assessment), newest-last; used for fixed/regressed decisions. */
  retestsByIssueKey: Map<string, RetestResult[]>
  /** True when the current assessment measured strictly less than the previous (tempers absent→not-tested). */
  coverageRegressed: boolean
}

/** A prior retest proved the issue fixed before now → a present issue has regressed. */
function wasFixedBefore(results: RetestResult[] | undefined): boolean {
  return !!results?.some((r) => r.state === 'fixed')
}

export function classifyFindings(previous: readonly SecurityFinding[], current: readonly SecurityFinding[], matches: readonly FindingMatch[], options: ClassifyOptions): FindingComparisonEntry[] {
  const prevById = new Map(previous.map((f) => [f.id, f]))
  const curById = new Map(current.map((f) => [f.id, f]))
  const entries: FindingComparisonEntry[] = []

  for (const match of matches) {
    const prev = match.previousFindingId ? prevById.get(match.previousFindingId) : undefined
    const cur = match.currentFindingId ? curById.get(match.currentFindingId) : undefined
    const retests = prev || cur ? options.retestsByIssueKey.get((prev ?? cur)!.issueKey) : undefined
    const latestRetest = retests?.[retests.length - 1] ?? null

    let cls: FindingComparisonClass
    let reason: string
    let changes: SecurityFindingChange[] = []

    if (!prev && cur) {
      cls = 'new'
      reason = 'No matching previous finding — new in this assessment'
    } else if (prev && cur) {
      changes = diffFindings(prev, cur)
      if (wasFixedBefore(retests)) {
        cls = 'regressed'
        reason = 'The issue was previously proven fixed and is present again'
      } else if (match.basis === 'semantic-match' || changes.some((c) => c.aspect === 'resource' || c.aspect === 'role' || c.aspect === 'scope')) {
        cls = 'changed'
        reason = 'The same underlying issue persists with changed scope/surface'
      } else {
        cls = 'still-present'
        reason = 'Present in both assessments'
      }
    } else if (prev && !cur) {
      // Absent from the current assessment: only a retest can say what happened.
      if (latestRetest?.state === 'fixed') {
        cls = 'fixed'
        reason = latestRetest.reason
      } else if (latestRetest?.state === 'regressed') {
        cls = 'regressed'
        reason = latestRetest.reason
      } else if (latestRetest?.state === 'still-present') {
        cls = 'still-present'
        reason = 'A retest reproduced the issue even though no current finding was synthesized'
      } else if (latestRetest?.state === 'cannot-reproduce' || latestRetest?.state === 'inconclusive') {
        cls = 'cannot-reproduce'
        reason = latestRetest.reason
      } else {
        cls = 'not-tested'
        reason = latestRetest ? `Retest was ${latestRetest.state}; not proven fixed` : options.coverageRegressed ? 'Not retested in this assessment (coverage decreased) — not proven fixed' : 'Not retested in this assessment — absence is not proof of a fix'
      }
    } else {
      cls = 'unmatched-historical'
      reason = 'Unmatched historical finding'
    }

    entries.push({ class: cls, match, previous: prev ? sideRef(prev) : null, current: cur ? sideRef(cur) : null, retestResultId: latestRetest?.id ?? null, retestState: latestRetest?.state ?? null, changes, reason })
  }
  return entries
}

export function summarizeFindingChanges(entries: readonly FindingComparisonEntry[]): AssessmentComparisonSummary {
  const count = (c: FindingComparisonClass) => entries.filter((e) => e.class === c).length
  return {
    new: count('new'),
    stillPresent: count('still-present'),
    fixed: count('fixed'),
    changed: count('changed'),
    regressed: count('regressed'),
    cannotReproduce: count('cannot-reproduce'),
    notTested: count('not-tested'),
    unmatchedHistorical: count('unmatched-historical'),
  }
}
