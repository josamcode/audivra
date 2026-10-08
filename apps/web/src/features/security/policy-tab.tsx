import {
  EXECUTION_LIMIT_KEYS,
  MUTATION_CLASS_INFO,
  POLICY_PERMISSION_INFO,
  RISK_CLASS_INFO,
  SECURITY_ENVIRONMENT_INFO,
  SECURITY_ENVIRONMENTS,
  SECURITY_POLICY_PROFILES,
  type EffectivePermission,
  type PolicyProfileKey,
  type SecurityEngagementDetail,
  type SecurityEnvironment,
} from '@audivra/contracts'
import { TriangleAlert } from 'lucide-react'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { Notice } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { ChoiceList } from '@/components/ui/choice-list'
import { Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { formatNumber, humanizeKey } from '@/lib/format'
import { useEngagementMutation } from './use-engagement-mutation'

const EFFECTIVE: Record<EffectivePermission, { label: string; tone: BadgeTone }> = {
  allowed: { label: 'Allowed', tone: 'success' },
  bounded: { label: 'Bounded', tone: 'medium' },
  denied: { label: 'Denied', tone: 'neutral' },
}

function PermissionTable({ title, rows }: { title: string; rows: { value: string; label: string; profile: keyof typeof POLICY_PERMISSION_INFO; effective: EffectivePermission; reason: string }[] }) {
  return (
    <Panel>
      <PanelHeader title={title} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-120 border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              {['Class', 'Profile', 'Effective', 'Why'].map((h) => (
                <th key={h} scope="col" className="h-8 bg-surface-muted px-3 text-left text-xs font-medium text-muted first:pl-4 last:pr-4">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.value} className="border-b border-border last:border-b-0">
                <td className="h-10 px-3 pl-4 font-medium whitespace-nowrap text-foreground">{row.label}</td>
                <td className="px-3 whitespace-nowrap text-muted" title={POLICY_PERMISSION_INFO[row.profile].description}>
                  {POLICY_PERMISSION_INFO[row.profile].label}
                </td>
                <td className="px-3">
                  <Badge tone={EFFECTIVE[row.effective].tone} dot>
                    {EFFECTIVE[row.effective].label}
                  </Badge>
                </td>
                <td className="px-3 pr-4 text-xs text-muted">{row.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

export function PolicyTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const { policy } = engagement
  const closed = engagement.status === 'completed' || engagement.status === 'cancelled'
  const update = useEngagementMutation(engagement.id, (input: { environment?: SecurityEnvironment; policyProfile?: PolicyProfileKey }) => api.updateEngagement(engagement.id, input), {
    success: 'Policy input updated',
    error: 'Could not update the policy input',
  })
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader title="Environment and profile" description="The two policy inputs. Changing either is recorded and re-evaluates readiness." />
        <PanelBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Environment</Label>
            <ChoiceList
              label="Environment"
              value={engagement.environment}
              onValueChange={(environment) => !closed && environment !== engagement.environment && update.mutate({ environment })}
              options={SECURITY_ENVIRONMENTS.map((env) => ({ value: env, label: SECURITY_ENVIRONMENT_INFO[env].label, description: SECURITY_ENVIRONMENT_INFO[env].description }))}
            />
            {!engagement.environment ? <p className="text-xs text-muted">Until one is chosen, the policy below is evaluated as production.</p> : null}
          </div>
          <div className="flex max-w-md flex-col gap-1.5">
            <Label>Policy profile</Label>
            <Select<PolicyProfileKey>
              label="Policy profile"
              hideLabel
              value={policy.profile.key as PolicyProfileKey}
              onValueChange={(policyProfile) => !closed && update.mutate({ policyProfile })}
              options={SECURITY_POLICY_PROFILES.filter((p) => !p.retired).map((p) => ({ value: p.key, label: `${p.name} (v${p.version})`, description: p.description }))}
              className="w-full"
            />
          </div>
        </PanelBody>
      </Panel>

      {policy.issues.length ? (
        <Notice tone="critical" icon={TriangleAlert} title="Policy incomplete">
          <ul className="list-inside list-disc">
            {policy.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
        <PermissionTable title="Risk classes" rows={policy.risk.map((r) => ({ ...r, label: RISK_CLASS_INFO[r.value].label }))} />
        <PermissionTable title="Mutation classes" rows={policy.mutation.map((m) => ({ ...m, label: MUTATION_CLASS_INFO[m.value].label }))} />
      </div>

      <Panel>
        <PanelHeader
          title="Execution limits"
          description={`Every execution runs under these limits (${SECURITY_ENVIRONMENT_INFO[policy.evaluatedEnvironment].label.toLowerCase()} ceilings; bounded classes use the stricter column).`}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-120 border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                {['Limit', 'Effective', 'Ceiling', 'Bounded'].map((h, i) => (
                  <th key={h} scope="col" className={`h-8 bg-surface-muted px-3 text-xs font-medium text-muted first:pl-4 last:pr-4 ${i ? 'text-right' : 'text-left'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EXECUTION_LIMIT_KEYS.map((key) => (
                <tr key={key} className="border-b border-border last:border-b-0">
                  <td className="h-9 px-3 pl-4 text-foreground">{humanizeKey(key)}</td>
                  <td className="px-3 text-right font-mono text-xs text-foreground tabular-nums">{formatNumber(policy.limits.effective[key])}</td>
                  <td className="px-3 text-right font-mono text-xs text-muted tabular-nums">{formatNumber(policy.limits.ceilings[key])}</td>
                  <td className="px-3 pr-4 text-right font-mono text-xs text-muted tabular-nums">{formatNumber(policy.limits.bounded[key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {policy.limits.clamped.length ? <PanelBody className="border-t border-border text-xs text-muted">Reduced to ceilings: {policy.limits.clamped.join('; ')}</PanelBody> : null}
        <PanelBody className="border-t border-border text-xs text-muted">
          External integrations: {POLICY_PERMISSION_INFO[policy.externalIntegrations.profile].label.toLowerCase()} by the profile, {policy.externalIntegrations.selected === 'allow' ? 'allowed' : 'not allowed'} by
          this engagement → <span className="font-medium text-foreground">{EFFECTIVE[policy.externalIntegrations.effective].label.toLowerCase()}</span>.
        </PanelBody>
      </Panel>
    </div>
  )
}
