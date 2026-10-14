import { AUDIVRA_VERSION } from '@audivra/config'
import { findPolicyProfile, redact, type SecurityReportBundle, type SecurityReportVersions, type ToolVersionStatus } from '@audivra/contracts'
import { getEngagementRow, type Db } from '@audivra/database'
import { comparisonCoverage } from '../comparison/coverage.ts'
import { coverageSnapshot, residualUncertainty } from '../research/coverage.ts'
import { AttackPathReadService } from '../attack-path/read.ts'
import { FindingReadService } from '../verification/read.ts'
import { HistoryReadService } from '../history/read.ts'
import { SecurityRequestError } from '../service.ts'

/*
 * Phase 6F — assemble ONE client-facing Security Assessment report by composing the per-area reports that
 * already exist (findings, attack paths, history) plus coverage and residual uncertainty. It is built purely
 * from persisted state — no AI re-run — and records the exact versions that produced it. It never claims a
 * complete penetration test, and the bundle is passed through redaction before it leaves this service.
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/

export interface SecurityReportService {
  build(engagementId: string, options?: BuildOptions): Promise<SecurityReportBundle>
}

export interface BuildOptions {
  previousEngagementId?: string | null
  /** Prompt versions (injected by the caller from @audivra/ai-runtime to avoid a dependency here). */
  promptVersions?: Record<string, string>
  /** Installed-vs-approved tool rows (injected from diagnostics). */
  tools?: ToolVersionStatus[]
  now?: () => Date
}

export function createSecurityReportService(db: Db): SecurityReportService {
  const findings = new FindingReadService({ db })
  const paths = new AttackPathReadService({ db })
  const history = new HistoryReadService({ db })

  return {
    async build(engagementId, options = {}) {
      const engagement = ENGAGEMENT_ID.test(engagementId) ? await getEngagementRow(db, engagementId) : undefined
      if (!engagement) throw new SecurityRequestError(404, 'Engagement not found')
      const now = (options.now ?? (() => new Date()))()
      const profile = findPolicyProfile(engagement.policyProfileKey, engagement.policyProfileVersion)

      const [findingReport, pathReport, comparison, snapshot] = await Promise.all([
        findings.report(engagementId),
        paths.report(engagementId),
        comparisonCoverage(db, engagementId),
        coverageSnapshot(db, engagementId),
      ])
      const residual = await residualUncertainty(db, engagementId, snapshot)
      const historyReport = options.previousEngagementId ? await history.report(options.previousEngagementId, engagementId).catch(() => null) : null

      const versions: SecurityReportVersions = {
        audivra: AUDIVRA_VERSION,
        policyProfile: { key: engagement.policyProfileKey, version: engagement.policyProfileVersion },
        promptVersions: options.promptVersions ?? {},
        tools: options.tools ?? [],
      }

      const v = findingReport.verifiedFindings.length
      const s = findingReport.supportedSignals.length
      const paths_ = pathReport.verifiedPaths.length + pathReport.partiallyVerifiedPaths.length
      const executiveSummary = [
        `This authorized security assessment of ${engagement.targetUrl} produced ${v} verified finding${v === 1 ? '' : 's'} and ${s} supported signal${s === 1 ? '' : 's'}`,
        paths_ ? `, with ${paths_} evidence-backed attack path${paths_ === 1 ? '' : 's'}` : '',
        `. Coverage is representative, not exhaustive — see Residual Risk. ${residual.notTested.length ? `Untested areas: ${residual.notTested.join('; ')}.` : ''}`,
      ].join('')
      const methodology =
        'Audivra tested only authorized, in-scope targets under the engagement policy, through its deterministic Capability Broker and controlled, isolated runtimes. Findings were independently verified; attack paths were validated against stored evidence; nothing was asserted beyond the evidence. This report is generated from stored state with no AI re-run.'

      const bundle: SecurityReportBundle = {
        meta: {
          engagementId,
          name: engagement.name,
          targetUrl: engagement.targetUrl,
          environment: engagement.environment,
          policyProfile: { key: engagement.policyProfileKey, version: engagement.policyProfileVersion, name: profile?.name ?? engagement.policyProfileKey },
          generatedAt: now.toISOString(),
          versions,
        },
        executiveSummary,
        methodology,
        findings: findingReport,
        attackPaths: pathReport,
        history: historyReport,
        comparisonCoverage: comparison,
        residual,
      }
      // Defense in depth: the bundle is built from already-safe state, and redaction scrubs anything unexpected.
      return redact(bundle)
    },
  }
}
