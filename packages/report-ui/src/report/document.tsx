/** @jsxRuntime automatic @jsxImportSource react */
import type {
  Artifact,
  AuditComparison,
  ClientReport,
  CoverageItem,
  LimitationItem,
  ReportAction,
  ReportFinding,
  ReportOpportunity,
  Severity,
  Technology,
} from '@audivra/contracts'
import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { ArtifactView } from '../artifact-view.tsx'
import { SeverityPill } from '../components/primitives.tsx'
import { StatTile } from '../artifacts/metrics.tsx'
import { ImpactEffortView } from '../artifacts/misc.tsx'
import { capitalize, formatDate, formatDelta, formatDuration, formatValue, shortUrl } from '../format.ts'
import type { AssetResolver } from '../types.ts'

export interface ClientReportDocumentProps {
  report: ClientReport
  resolveAsset: AssetResolver
  /** true: <details> disclosures (HTML export / preview). false: everything expanded (PDF). */
  interactive?: boolean
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

const TYPE_LABEL: Record<string, string> = {
  verified: 'Verified',
  'supported-observation': 'Supported observation',
  inference: 'Inference',
}

const VERIFICATION_LABEL: Record<string, string> = {
  rechecked: 'Rechecked after review',
  'reviewer-approved': 'Reviewed',
  revised: 'Revised after review',
  unreviewed: 'Not reviewed',
}

const LIMITATION_LABEL: Record<LimitationItem['kind'], string> = {
  'could-not-verify': 'Could not verify',
  environment: 'Environment limitations',
  inference: 'Inferences',
  'out-of-scope': 'Out of scope',
}

const COVERAGE_LABEL: Record<CoverageItem['status'], string> = {
  ran: 'Completed',
  partial: 'Partial',
  skipped: 'Skipped',
  failed: 'Failed',
  unavailable: 'Unavailable',
  'not-applicable': 'Not applicable',
}

function Section({
  id,
  title,
  kicker,
  children,
  className,
  pageBreak,
}: {
  id: string
  title: string
  kicker?: string
  children: ReactNode
  className?: string
  pageBreak?: boolean
}) {
  return (
    <section id={id} className={clsx('rp-section', pageBreak && 'rp-page-break', className)}>
      <header className="rp-section-head">
        {kicker ? <p className="rp-kicker">{kicker}</p> : null}
        <h2 className="rp-h2">{title}</h2>
      </header>
      {children}
    </section>
  )
}

function Disclosure({ summary, children, interactive }: { summary: string; children: ReactNode; interactive: boolean }) {
  if (!interactive) {
    return (
      <div className="rp-expanded">
        <h3 className="rp-h4">{summary}</h3>
        {children}
      </div>
    )
  }
  return (
    <details className="rp-details">
      <summary>{summary}</summary>
      <div className="rp-details-body">{children}</div>
    </details>
  )
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p, i) => {
          const lines = p.split('\n').map((l) => l.trim())
          const bullets = lines.every((l) => /^[-*•]\s+/.test(l))
          if (bullets) {
            return (
              <ul key={i} className="rp-list">
                {lines.map((l, j) => (
                  <li key={j} dir="auto">
                    {stripMarkdown(l.replace(/^[-*•]\s+/, ''))}
                  </li>
                ))}
              </ul>
            )
          }
          return (
            <p key={i} className="rp-p" dir="auto">
              {stripMarkdown(lines.join(' '))}
            </p>
          )
        })}
    </>
  )
}

function stripMarkdown(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
}

function SeverityCounts({ counts }: { counts: Record<Severity, number> }) {
  return (
    <ul className="rp-sev-counts">
      {SEVERITY_ORDER.map((severity) => (
        <li key={severity} className={clsx(!counts[severity] && 'rp-zero')}>
          <SeverityPill severity={severity} />
          <span className="rp-num">{counts[severity] ?? 0}</span>
        </li>
      ))}
    </ul>
  )
}

function ProofImage({ image, resolveAsset }: { image: NonNullable<ReportFinding['proof']['image']>; resolveAsset: AssetResolver }) {
  return (
    <figure className="rp-proof-image">
      <img src={resolveAsset(image.path)} alt={image.caption} />
      <figcaption dir="auto">
        {image.caption} <span className="rp-ref">{image.evidenceRef}</span>
      </figcaption>
    </figure>
  )
}

function FindingCard({
  finding,
  resolveAsset,
  compact = false,
}: {
  finding: ReportFinding
  resolveAsset: AssetResolver
  compact?: boolean
}) {
  return (
    <article className={clsx('rp-finding', compact && 'rp-finding-compact')} id={`finding-${finding.ref}`}>
      <header className="rp-finding-head">
        <div className="rp-finding-meta">
          <SeverityPill severity={finding.severity} />
          <span className="rp-meta-text">{finding.category}</span>
          <span className="rp-meta-text">· {TYPE_LABEL[finding.type] ?? finding.type}</span>
          <span className="rp-meta-text">· {Math.round(finding.confidence * 100)}% confidence</span>
          <span className="rp-ref">{finding.ref}</span>
        </div>
        <h3 className="rp-h3" dir="auto">
          {finding.title}
        </h3>
      </header>
      <div className="rp-finding-grid">
        <div className="rp-finding-text">
          <h4 className="rp-h4">Problem</h4>
          <p className="rp-p" dir="auto">
            {finding.description}
          </p>
          <h4 className="rp-h4">What we observed</h4>
          <p className="rp-p" dir="auto">
            {finding.observed}
          </p>
          {compact ? null : (
            <>
              <h4 className="rp-h4">Why it matters</h4>
              <p className="rp-p" dir="auto">
                {finding.whyItMatters}
              </p>
              <h4 className="rp-h4">Business impact</h4>
              <p className="rp-p" dir="auto">
                {finding.businessImpact}
              </p>
            </>
          )}
          <div className="rp-fix">
            <h4 className="rp-h4">Recommended fix · {capitalize(finding.effort)} effort</h4>
            <p className="rp-p" dir="auto">
              {finding.recommendation}
            </p>
          </div>
          {finding.affectedUrls.length ? (
            <p className="rp-affected">
              <span className="rp-meta-text">Affected:</span>{' '}
              {finding.affectedUrls.slice(0, 6).map((url) => (
                <span key={url} className="rp-url">
                  {shortUrl(url, 70)}
                </span>
              ))}
              {finding.affectedUrls.length > 6 ? <span className="rp-meta-text"> +{finding.affectedUrls.length - 6} more</span> : null}
            </p>
          ) : null}
        </div>
      </div>
      {compact ? null : finding.proof.artifact ? (
        <div className="rp-proof">
          <ArtifactView artifact={finding.proof.artifact} resolveAsset={resolveAsset} mode="report" />
        </div>
      ) : finding.proof.image ? (
        <div className="rp-proof">
          <ProofImage image={finding.proof.image} resolveAsset={resolveAsset} />
        </div>
      ) : null}
      <p className="rp-finding-foot">
        {VERIFICATION_LABEL[finding.verificationStatus] ?? finding.verificationStatus}
        {finding.evidenceRefs.length ? ` · Sources: ${finding.evidenceRefs.join(', ')}` : ''}
      </p>
    </article>
  )
}

function RiskRow({ finding }: { finding: ReportFinding }) {
  return (
    <li className="rp-risk">
      <SeverityPill severity={finding.severity} />
      <div className="rp-risk-main">
        <a className="rp-risk-title" href={`#finding-${finding.ref}`} dir="auto">
          {finding.title}
        </a>
        <p className="rp-risk-why" dir="auto">
          {firstSentence(finding.businessImpact || finding.whyItMatters)}
        </p>
      </div>
      <span className="rp-meta-text rp-risk-cat">{finding.category}</span>
    </li>
  )
}

function firstSentence(text: string): string {
  const match = text.match(/^(.+?[.!?])(\s|$)/)
  const sentence = match?.[1] ?? text
  return sentence.length > 240 ? `${sentence.slice(0, 237)}…` : sentence
}

function OpportunityCard({ opportunity }: { opportunity: ReportOpportunity }) {
  return (
    <article className="rp-opp">
      <header className="rp-opp-head">
        <h3 className="rp-h3 rp-h3-sm" dir="auto">
          {opportunity.title}
        </h3>
        <span className="rp-opp-levels">
          <span className={clsx('rp-level', opportunity.impact === 'high' && 'rp-level-strong')}>{capitalize(opportunity.impact)} impact</span>
          <span className={clsx('rp-level', opportunity.effort === 'low' && 'rp-level-strong')}>{capitalize(opportunity.effort)} effort</span>
        </span>
      </header>
      <p className="rp-p" dir="auto">
        {opportunity.why}
      </p>
      {opportunity.scope ? (
        <p className="rp-p rp-scope" dir="auto">
          <span className="rp-meta-text">Suggested scope: </span>
          {opportunity.scope}
        </p>
      ) : null}
      {opportunity.findingRefs.length ? <p className="rp-meta-text">Addresses {opportunity.findingRefs.join(', ')}</p> : null}
    </article>
  )
}

function ActionList({ title, items, start }: { title: string; items: ReportAction[]; start: number }) {
  if (!items.length) return null
  return (
    <div className="rp-actions-group">
      <h3 className="rp-h4">{title}</h3>
      <ol className="rp-actions" start={start}>
        {items.map((item, index) => (
          <li key={`${item.title}-${index}`}>
            <span className="rp-action-title" dir="auto">
              {item.title}
            </span>
            <span className="rp-action-why" dir="auto">
              {item.why}
              {item.findingRefs.length ? <span className="rp-ref"> {item.findingRefs.join(', ')}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function ComparisonSection({ comparison }: { comparison: AuditComparison }) {
  const s = comparison.summary
  const groups: { key: 'resolved' | 'new' | 'improved' | 'regressed'; label: string }[] = [
    { key: 'resolved', label: 'Resolved' },
    { key: 'new', label: 'New' },
    { key: 'improved', label: 'Improved' },
    { key: 'regressed', label: 'Regressed' },
  ]
  const metrics = comparison.metrics.filter((m) => m.direction === 'improved' || m.direction === 'regressed').slice(0, 10)
  return (
    <>
      <p className="rp-p rp-muted">
        Compared with the audit of {formatDate(comparison.previous.finishedAt ?? comparison.previous.createdAt)}.
      </p>
      <ul className="rp-change-summary">
        {[
          ['Resolved', s.resolved],
          ['New', s.new],
          ['Improved', s.improved],
          ['Regressed', s.regressed],
          ['Unchanged', s.unchanged],
        ].map(([label, value]) => (
          <li key={label as string}>
            <span className="rp-num rp-big-num">{value}</span>
            <span className="rp-meta-text">{label}</span>
          </li>
        ))}
      </ul>
      <div className="rp-change-lists">
        {groups.map((group) => {
          const items = comparison.findings.filter((f) => f.status === group.key)
          if (!items.length) return null
          return (
            <div key={group.key} className="rp-change-group">
              <h3 className="rp-h4">{group.label}</h3>
              <ul className="rp-list">
                {items.slice(0, 8).map((change, index) => {
                  const f = change.current ?? change.previous
                  return f ? (
                    <li key={`${f.ref}-${index}`} dir="auto">
                      {f.title}
                      {change.previous && change.current && change.previous.severity !== change.current.severity ? (
                        <span className="rp-meta-text">
                          {' '}
                          ({change.previous.severity} → {change.current.severity})
                        </span>
                      ) : null}
                    </li>
                  ) : null
                })}
              </ul>
            </div>
          )
        })}
      </div>
      {metrics.length ? (
        <table className="rp-table">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col" className="rp-right">
                Before
              </th>
              <th scope="col" className="rp-right">
                After
              </th>
              <th scope="col" className="rp-right">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.key}>
                <td>{m.label}</td>
                <td className="rp-right rp-num">{m.before == null ? '–' : formatValue(m.before, m.unit)}</td>
                <td className="rp-right rp-num">{m.after == null ? '–' : formatValue(m.after, m.unit)}</td>
                <td className={clsx('rp-right rp-num', m.direction === 'improved' ? 'av-tone-good' : 'av-tone-bad')}>
                  {m.delta == null ? '–' : formatDelta(m.delta, m.unit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  )
}

function groupTechnologies(technologies: Technology[]): [string, Technology[]][] {
  const groups = new Map<string, Technology[]>()
  for (const tech of technologies) groups.set(tech.category, [...(groups.get(tech.category) ?? []), tech])
  return [...groups.entries()]
}

function Visuals({ artifacts, resolveAsset }: { artifacts: Artifact[]; resolveAsset: AssetResolver }) {
  return (
    <div className="rp-visuals">
      {artifacts.map((artifact) => (
        <div key={artifact.id} className={clsx('rp-visual', wideTypes.has(artifact.type) && 'rp-visual-wide')}>
          <ArtifactView artifact={artifact} resolveAsset={resolveAsset} mode="report" />
        </div>
      ))}
    </div>
  )
}

const wideTypes = new Set<Artifact['type']>([
  'page_performance',
  'tracking_coverage',
  'site_graph',
  'annotated_screenshot',
  'before_after',
  'evidence_gallery',
  'journey',
  'matrix',
  'heatmap',
  'comparison_table',
  'line_chart',
  'impact_effort',
])

/** The client-facing report. Same component for preview, standalone HTML and PDF. */
export function ClientReportDocument({ report, resolveAsset, interactive = true }: ClientReportDocumentProps) {
  const { snapshot, appendix } = report
  const limitationsByKind = new Map<LimitationItem['kind'], string[]>()
  for (const item of appendix.limitations) {
    limitationsByKind.set(item.kind, [...(limitationsByKind.get(item.kind) ?? []), item.text])
  }
  // A visual that proves a major finding is shown with that finding (problem → proof → fix), not
  // repeated in the general "Visual evidence" section.
  const seen = new Set<string>(report.majorFindings.flatMap((f) => (f.proof.artifact ? [f.proof.artifact.id] : [])))
  const unique = (artifacts: Artifact[]) =>
    artifacts.filter((artifact) => {
      if (seen.has(artifact.id)) return false
      seen.add(artifact.id)
      return true
    })
  const featured = unique(report.featuredArtifacts)
  const visuals = unique(report.visuals)
  const ran = appendix.coverage.filter((c) => c.status === 'ran').length
  const opportunityMatrix =
    report.opportunities.length >= 2
      ? {
          items: report.opportunities.slice(0, 12).map((o) => ({
            label: o.title,
            impact: o.impact,
            effort: o.effort,
            findingIds: o.findingRefs,
          })),
        }
      : null
  const hasActions = report.actionPlan.doFirst.length + report.actionPlan.then.length + report.actionPlan.later.length > 0

  return (
    <article className="rp-document" lang="en">
      <header className="rp-cover">
        <p className="rp-brand">Audivra · Website audit</p>
        <h1 className="rp-h1">{report.site.domain}</h1>
        <p className="rp-cover-url">{report.site.url}</p>
        <dl className="rp-cover-meta">
          {report.site.clientName ? (
            <div>
              <dt>Prepared for</dt>
              <dd dir="auto">{report.site.clientName}</dd>
            </div>
          ) : null}
          <div>
            <dt>Audit date</dt>
            <dd>{formatDate(report.audit.date)}</dd>
          </div>
          <div>
            <dt>Findings</dt>
            <dd>{snapshot.findings.total}</dd>
          </div>
          <div>
            <dt>Pages reviewed</dt>
            <dd>
              {snapshot.pages.crawled} crawled · {snapshot.pages.inspected} inspected in a browser
            </dd>
          </div>
        </dl>
        {!report.audit.complete ? (
          <p className="rp-notice">
            Some audit stages did not complete. Findings below reflect what could be verified; see Methodology & limitations.
          </p>
        ) : null}
      </header>

      <Section id="snapshot" title="Executive snapshot" kicker="At a glance">
        {snapshot.lines.length ? (
          <ul className="rp-snapshot">
            {snapshot.lines.map((line, index) => (
              <li key={index} dir="auto">
                {stripMarkdown(line)}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="rp-snapshot-grid">
          <div className="rp-snapshot-block">
            <h3 className="rp-h4">Findings by severity</h3>
            <SeverityCounts counts={snapshot.findings.bySeverity} />
            <p className="rp-meta-text">
              {snapshot.findings.verified} verified · {snapshot.findings.observed} supported observations · {snapshot.findings.inferred} inferences
            </p>
          </div>
          <div className="rp-snapshot-block">
            <h3 className="rp-h4">Scope</h3>
            <p className="rp-meta-text">
              {snapshot.pages.discovered} pages discovered · {snapshot.pages.crawled} crawled · {snapshot.pages.inspected} inspected in a real browser ·{' '}
              {snapshot.evidenceCount} pieces of evidence
            </p>
            {report.audit.durationMs ? <p className="rp-meta-text">Audit duration {formatDuration(report.audit.durationMs)}</p> : null}
          </div>
        </div>
        {snapshot.keyMetrics.length ? (
          <div className="av-stat-grid rp-key-metrics">
            {snapshot.keyMetrics.map((datum, index) => (
              <StatTile key={`${datum.label}-${index}`} datum={datum} />
            ))}
          </div>
        ) : null}
      </Section>

      {report.topRisks.length ? (
        <Section id="risks" title="What matters most" kicker="Top risks">
          <ol className="rp-risks">
            {report.topRisks.map((finding) => (
              <RiskRow key={finding.ref} finding={finding} />
            ))}
          </ol>
        </Section>
      ) : null}

      {featured.length || visuals.length ? (
        <Section id="visuals" title="Visual evidence" kicker="What we measured and saw" pageBreak>
          <Visuals artifacts={[...featured, ...visuals]} resolveAsset={resolveAsset} />
        </Section>
      ) : null}

      {report.majorFindings.length ? (
        <Section id="findings" title="Major findings" kicker="Problems, proof and fixes" pageBreak>
          {report.majorFindings.map((finding) => (
            <FindingCard key={finding.ref} finding={finding} resolveAsset={resolveAsset} />
          ))}
        </Section>
      ) : null}

      {report.categoryHighlights.length ? (
        <Section id="categories" title="Category highlights">
          <div className="rp-categories">
            {report.categoryHighlights.map((highlight) => (
              <div key={highlight.category} className="rp-category">
                <h3 className="rp-h3 rp-h3-sm">{highlight.category}</h3>
                <p className="rp-p" dir="auto">
                  {highlight.takeaway}
                </p>
                {highlight.findingRefs.length ? <p className="rp-meta-text">Related: {highlight.findingRefs.join(', ')}</p> : null}
                {highlight.artifacts.map((artifact) => (
                  <div key={artifact.id} className="rp-category-visual">
                    <ArtifactView artifact={artifact} resolveAsset={resolveAsset} mode="report" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {report.opportunities.length ? (
        <Section id="opportunities" title="Opportunities" kicker="Work worth doing">
          {opportunityMatrix ? (
            <div className="rp-opp-matrix">
              <ImpactEffortView data={opportunityMatrix} ctx={{ mode: 'report', resolveAsset }} />
            </div>
          ) : null}
          <div className="rp-opps">
            {report.opportunities.map((opportunity, index) => (
              <OpportunityCard key={`${opportunity.title}-${index}`} opportunity={opportunity} />
            ))}
          </div>
        </Section>
      ) : null}

      {hasActions ? (
        <Section id="plan" title="Recommended action plan">
          <div className="rp-plan">
            <ActionList title="Do first" items={report.actionPlan.doFirst} start={1} />
            <ActionList title="Then" items={report.actionPlan.then} start={report.actionPlan.doFirst.length + 1} />
            <ActionList
              title="Later"
              items={report.actionPlan.later}
              start={report.actionPlan.doFirst.length + report.actionPlan.then.length + 1}
            />
          </div>
        </Section>
      ) : null}

      {report.comparison ? (
        <Section id="comparison" title="Since the previous audit">
          <ComparisonSection comparison={report.comparison} />
        </Section>
      ) : null}

      <Section id="appendix" title="Technical appendix" pageBreak>
        {appendix.otherFindings.length ? (
          <div className="rp-appendix-block">
            <h3 className="rp-h3 rp-h3-sm">Other findings</h3>
            {appendix.otherFindings.map((finding) =>
              interactive ? (
                <details key={finding.ref} className="rp-details rp-finding-details" id={`finding-${finding.ref}`}>
                  <summary>
                    <SeverityPill severity={finding.severity} /> <span dir="auto">{finding.title}</span>
                    <span className="rp-ref">{finding.ref}</span>
                  </summary>
                  <div className="rp-details-body">
                    <FindingCard finding={finding} resolveAsset={resolveAsset} compact />
                  </div>
                </details>
              ) : (
                <FindingCard key={finding.ref} finding={finding} resolveAsset={resolveAsset} compact />
              ),
            )}
          </div>
        ) : null}

        {appendix.artifacts.length ? (
          <div className="rp-appendix-block">
            <h3 className="rp-h3 rp-h3-sm">Supporting visuals</h3>
            <Visuals artifacts={appendix.artifacts} resolveAsset={resolveAsset} />
          </div>
        ) : null}

        {report.business ? (
          <div className="rp-appendix-block">
            <h3 className="rp-h3 rp-h3-sm">Business understanding</h3>
            <dl className="rp-facts">
              <div>
                <dt>Business type</dt>
                <dd dir="auto">{report.business.businessType}</dd>
              </div>
              {report.business.businessModel ? (
                <div>
                  <dt>Business model</dt>
                  <dd dir="auto">{report.business.businessModel}</dd>
                </div>
              ) : null}
              <div>
                <dt>Likely customers</dt>
                <dd dir="auto">{report.business.likelyCustomers}</dd>
              </div>
              <div>
                <dt>Primary conversion</dt>
                <dd dir="auto">{report.business.primaryConversion}</dd>
              </div>
              {report.business.secondaryConversions.length ? (
                <div>
                  <dt>Secondary conversions</dt>
                  <dd dir="auto">{report.business.secondaryConversions.join(' · ')}</dd>
                </div>
              ) : null}
              {report.business.acquisitionSignals?.length ? (
                <div>
                  <dt>Acquisition signals</dt>
                  <dd dir="auto">{report.business.acquisitionSignals.join(' · ')}</dd>
                </div>
              ) : null}
              <div>
                <dt>Confidence</dt>
                <dd>{Math.round(report.business.confidence * 100)}% (inferred from the public website)</dd>
              </div>
            </dl>
            {report.business.assumptions.length ? (
              <Disclosure summary="Assumptions" interactive={interactive}>
                <ul className="rp-list">
                  {report.business.assumptions.map((a, i) => (
                    <li key={i} dir="auto">
                      {a}
                    </li>
                  ))}
                </ul>
              </Disclosure>
            ) : null}
          </div>
        ) : null}

        <div className="rp-appendix-block">
          <h3 className="rp-h3 rp-h3-sm">Audit coverage</h3>
          <p className="rp-meta-text">
            {ran} of {appendix.coverage.length} capabilities completed
          </p>
          <table className="rp-table">
            <thead>
              <tr>
                <th scope="col">Capability</th>
                <th scope="col">Status</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {appendix.coverage.map((item) => (
                <tr key={item.capability}>
                  <td>{item.label}</td>
                  <td className={clsx('rp-cov', `rp-cov-${item.status}`)}>{COVERAGE_LABEL[item.status]}</td>
                  <td className="rp-muted">{item.reason ?? item.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {appendix.technologies.length ? (
          <div className="rp-appendix-block">
            <h3 className="rp-h3 rp-h3-sm">Technologies detected</h3>
            <dl className="rp-facts">
              {groupTechnologies(appendix.technologies).map(([category, techs]) => (
                <div key={category}>
                  <dt>{category}</dt>
                  <dd>{techs.map((t) => t.name).join(' · ')}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        {appendix.pages.length ? (
          <div className="rp-appendix-block">
            <h3 className="rp-h3 rp-h3-sm">Pages reviewed</h3>
            <table className="rp-table rp-table-compact">
              <thead>
                <tr>
                  <th scope="col">URL</th>
                  <th scope="col">Status</th>
                  <th scope="col">Title</th>
                  <th scope="col">Browser</th>
                </tr>
              </thead>
              <tbody>
                {appendix.pages.map((page) => (
                  <tr key={page.url}>
                    <td className="rp-url-cell">{shortUrl(page.url, 80)}</td>
                    <td className="rp-num">{page.status ?? '–'}</td>
                    <td dir="auto">{page.title ?? ''}</td>
                    <td>{page.inspected ? 'Yes' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="rp-appendix-block">
          <h3 className="rp-h3 rp-h3-sm">Methodology & limitations</h3>
          {appendix.methodology.length ? (
            <ul className="rp-list">
              {appendix.methodology.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          ) : null}
          {[...limitationsByKind.entries()].map(([kind, items]) => (
            <div key={kind} className="rp-limits">
              <h4 className="rp-h4">{LIMITATION_LABEL[kind]}</h4>
              <ul className="rp-list">
                {items.map((text, i) => (
                  <li key={i} dir="auto">
                    {text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {appendix.fullAnalysis ? (
          <div className="rp-appendix-block">
            <Disclosure summary="Full analysis" interactive={interactive}>
              <Paragraphs text={appendix.fullAnalysis} />
            </Disclosure>
          </div>
        ) : null}
      </Section>

      <footer className="rp-footer">
        <span>Generated by Audivra on {formatDate(report.generatedAt)}</span>
        <span>{report.site.domain}</span>
      </footer>
    </article>
  )
}
