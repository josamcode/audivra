import { RISK_CLASS_INFO, MUTATION_CLASS_INFO, type SecurityEngagementDetail } from '@audivra/contracts'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, Info, XCircle } from 'lucide-react'
import { ENVIRONMENT_LABEL, ReasoningRunStatusBadge, STOP_REASON_LABEL } from '@/components/badges'
import { DefinitionList, Panel, PanelBody, PanelHeader } from '@/components/panel'
import { Notice } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { formatDateTime, pluralize } from '@/lib/format'
import { reasoningCoverageQuery, securityCapabilitiesQuery } from '@/lib/queries'

/** What Audivra knows and still does not know about the target (reasoning coverage — never a score). */
function KnowledgePanel({ engagementId }: { engagementId: string }) {
  const coverage = useQuery(reasoningCoverageQuery(engagementId))
  const c = coverage.data
  if (!c) return null
  return (
    <Panel>
      <PanelHeader title="Knowledge" description="Security graph and reasoning coverage." />
      <PanelBody>
        <DefinitionList
          items={[
            { label: 'Graph entities', value: c.graph.entities },
            { label: 'Relationships', value: c.graph.relationships },
            { label: 'Open unknowns', value: `${c.gaps.open} (${c.gaps.resolved} answered)` },
            {
              label: 'Hypotheses',
              value: `${c.hypotheses.total} · ${c.hypotheses.investigated} investigated`,
            },
            { label: 'Blocked · exhausted', value: `${c.hypotheses.blocked} · ${c.hypotheses.exhausted}` },
            {
              label: 'Latest reasoning',
              value: c.latestRun ? (
                <span className="inline-flex flex-col items-end gap-0.5">
                  <ReasoningRunStatusBadge status={c.latestRun.status} />
                  {c.latestRun.stopReason ? (
                    <span className="text-2xs text-muted">{STOP_REASON_LABEL[c.latestRun.stopReason]}</span>
                  ) : null}
                </span>
              ) : (
                'None'
              ),
            },
          ]}
        />
      </PanelBody>
    </Panel>
  )
}

export function ReadinessPanel({ engagement }: { engagement: SecurityEngagementDetail }) {
  const { readiness } = engagement
  return (
    <Panel>
      <PanelHeader
        title="Readiness"
        description={
          readiness.ready
            ? 'Every requirement holds. Future security runs may start from here.'
            : 'Computed from requirements, not from the status label.'
        }
      />
      <ul className="divide-y divide-border">
        {readiness.checks.map((check) => (
          <li key={check.key} className="flex items-start gap-3 px-4 py-2.5">
            {check.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Satisfied" />
            ) : (
              <XCircle className="mt-0.5 size-4 shrink-0 text-critical" aria-label="Blocking" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{check.label}</p>
              <p className="text-xs text-muted text-break">{check.reason}</p>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

export function OverviewTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const capabilities = useQuery(securityCapabilitiesQuery())
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
      <div className="flex min-w-0 flex-col gap-4">
        <Notice tone="neutral" icon={Info} title="Configuration and readiness only">
          This version of Audivra checks whether an engagement is authorized, scoped and within policy. It
          does not run security tests against the target.
        </Notice>
        <ReadinessPanel engagement={engagement} />
        <Panel>
          <PanelHeader
            title="Registered capabilities"
            description="What Audivra can do, independent of how. Every request goes through the capability broker."
          />
          {capabilities.data ? (
            <ul className="divide-y divide-border">
              {capabilities.data.map((capability) => (
                <li key={capability.id} className="flex flex-col gap-1 px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{capability.name}</span>
                    <span className="font-mono text-2xs text-subtle">
                      {capability.id} v{capability.version}
                    </span>
                    <Badge>{RISK_CLASS_INFO[capability.riskClass].label}</Badge>
                    <Badge>{MUTATION_CLASS_INFO[capability.sideEffect].label}</Badge>
                    {capability.requiresAuthorization ? (
                      <Badge tone="info">Requires authorization</Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted">{capability.description}</p>
                </li>
              ))}
            </ul>
          ) : (
            <PanelBody className="text-xs text-muted">
              {capabilities.isError ? 'Could not load the capability catalog.' : 'Loading…'}
            </PanelBody>
          )}
        </Panel>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Panel>
          <PanelHeader title="Engagement" />
          <PanelBody>
            <DefinitionList
              layout="stacked"
              items={[
                { label: 'Target', value: <span className="font-mono text-xs">{engagement.targetUrl}</span> },
                {
                  label: 'Environment',
                  value: engagement.environment ? ENVIRONMENT_LABEL[engagement.environment] : 'Not set',
                },
                {
                  label: 'Policy profile',
                  value: `${engagement.policy.profile.name} v${engagement.policy.profile.version}`,
                },
                {
                  label: 'Scope',
                  value: (
                    <span>
                      Version {engagement.scopeVersion}{' '}
                      <span className="font-mono text-2xs text-subtle">
                        {engagement.scopeHash.slice(0, 12)}
                      </span>
                    </span>
                  ),
                },
                {
                  label: 'Authorizations',
                  value: pluralize(
                    engagement.authorizations.filter((a) => a.effectiveStatus === 'verified').length,
                    'verified record',
                  ),
                },
                {
                  label: 'Website Audits of this site',
                  value: engagement.siteAudits.latestAuditId ? (
                    <Link
                      to="/audits/$auditId"
                      params={{ auditId: engagement.siteAudits.latestAuditId }}
                      className="text-link hover:underline"
                    >
                      {pluralize(engagement.siteAudits.count, 'audit')} · latest
                    </Link>
                  ) : (
                    'None'
                  ),
                },
                {
                  label: 'Created',
                  value: `${formatDateTime(engagement.createdAt)} by ${engagement.createdBy}`,
                },
                ...(engagement.description
                  ? [
                      {
                        label: 'Notes',
                        value: <span className="whitespace-pre-line">{engagement.description}</span>,
                      },
                    ]
                  : []),
              ]}
            />
          </PanelBody>
        </Panel>
        <KnowledgePanel engagementId={engagement.id} />
      </div>
    </div>
  )
}
