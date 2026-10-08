import {
  EXECUTION_LIMIT_KEYS,
  MUTATION_CLASS_INFO,
  MUTATION_CLASSES,
  RISK_CLASS_INFO,
  RISK_CLASSES,
  ScopeManifest,
  type ExecutionLimits,
  type MutationClass,
  type RiskClass,
  type ScopeEvaluation,
  type ScopeManifestInput,
  type SecurityEngagementDetail,
} from '@audivra/contracts'
import { useMutation } from '@tanstack/react-query'
import { Loader2, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { DecisionBadge } from '@/components/badges'
import { Panel, PanelBody, PanelHeader, SectionLabel } from '@/components/panel'
import { Notice } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { humanizeKey } from '@/lib/format'
import { useEngagementMutation } from './use-engagement-mutation'

/*
 * Editing happens on a flat draft (strings for list fields) that converts to a manifest on save. The
 * shared ScopeManifest schema validates it here and again on the server; the server is authoritative.
 */

interface HostDraft {
  host: string
  includeSubdomains: boolean
  ports: string
  pathPrefixes: string
}

interface Draft {
  hosts: HostDraft[]
  https: boolean
  http: boolean
  addresses: string
  cidrs: string
  exclusionHosts: string
  exclusionPaths: string
  dependencies: string
  followRedirects: boolean
  maxHops: string
  windowStart: string
  windowEnd: string
  limits: Partial<Record<keyof ExecutionLimits, string>>
  profileDefaults: boolean
  riskClasses: RiskClass[]
  mutationClasses: MutationClass[]
  externalIntegrations: boolean
}

const list = (text: string) =>
  text
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean)

const LIMIT_LABELS: Record<keyof ExecutionLimits, string> = {
  maxRequests: 'Max requests',
  requestsPerSecond: 'Requests / s',
  concurrency: 'Concurrency',
  executionTimeoutSeconds: 'Timeout (s)',
  maxResponseBytes: 'Response (bytes)',
  maxArtifactMb: 'Artifacts (MB)',
}

const toLocal = (iso: string | undefined) => (iso ? new Date(iso).toISOString().slice(0, 16) : '')

function toDraft(scope: ScopeManifest, engagement: SecurityEngagementDetail): Draft {
  return {
    hosts: scope.hosts.map((h) => ({ host: h.host, includeSubdomains: h.includeSubdomains, ports: (h.ports ?? []).join(', '), pathPrefixes: (h.pathPrefixes ?? []).join(', ') })),
    https: scope.protocols.includes('https'),
    http: scope.protocols.includes('http'),
    addresses: scope.networks.addresses.join('\n'),
    cidrs: scope.networks.cidrs.join('\n'),
    exclusionHosts: scope.exclusions.hosts.join('\n'),
    exclusionPaths: scope.exclusions.pathPrefixes.join('\n'),
    dependencies: scope.dependencies.map((d) => (d.includeSubdomains ? `*.${d.host}` : d.host)).join('\n'),
    followRedirects: scope.redirects.policy === 'evaluate-each-hop',
    maxHops: String(scope.redirects.maxHops),
    windowStart: toLocal(scope.testingWindow?.startsAt),
    windowEnd: toLocal(scope.testingWindow?.endsAt),
    limits: Object.fromEntries(EXECUTION_LIMIT_KEYS.filter((k) => scope.limits[k] !== undefined).map((k) => [k, String(scope.limits[k])])),
    profileDefaults: scope.permissions.riskClasses === undefined && scope.permissions.mutationClasses === undefined,
    riskClasses: scope.permissions.riskClasses ?? engagement.policy.risk.filter((r) => r.selected).map((r) => r.value),
    mutationClasses: scope.permissions.mutationClasses ?? engagement.policy.mutation.filter((m) => m.selected).map((m) => m.value),
    externalIntegrations: scope.permissions.externalIntegrations === 'allow',
  }
}

function toManifest(draft: Draft): ScopeManifestInput {
  const numbers = (text: string) => list(text).map(Number)
  return {
    hosts: draft.hosts
      .filter((h) => h.host.trim())
      .map((h) => ({
        host: h.host.trim(),
        includeSubdomains: h.includeSubdomains,
        ...(list(h.ports).length ? { ports: numbers(h.ports) } : {}),
        ...(list(h.pathPrefixes).length ? { pathPrefixes: list(h.pathPrefixes) } : {}),
      })),
    protocols: [...(draft.https ? (['https'] as const) : []), ...(draft.http ? (['http'] as const) : [])],
    networks: { addresses: list(draft.addresses), cidrs: list(draft.cidrs) },
    exclusions: { hosts: list(draft.exclusionHosts), pathPrefixes: list(draft.exclusionPaths) },
    dependencies: list(draft.dependencies).map((d) => (d.startsWith('*.') ? { host: d.slice(2), includeSubdomains: true } : { host: d })),
    redirects: { policy: draft.followRedirects ? 'evaluate-each-hop' : 'do-not-follow', maxHops: Number(draft.maxHops || 0) },
    testingWindow: draft.windowStart && draft.windowEnd ? { startsAt: new Date(draft.windowStart).toISOString(), endsAt: new Date(draft.windowEnd).toISOString() } : null,
    limits: Object.fromEntries(Object.entries(draft.limits).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, Number(v)])),
    permissions: {
      ...(draft.profileDefaults ? {} : { riskClasses: draft.riskClasses, mutationClasses: draft.mutationClasses }),
      externalIntegrations: draft.externalIntegrations ? 'allow' : 'deny',
    },
  }
}

function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  )
}

function Toggles<T extends string>({ values, selected, onChange, label }: { values: readonly T[]; selected: T[]; onChange: (next: T[]) => void; label: (v: T) => string }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value) => (
        <Switch
          key={value}
          label={label(value)}
          checked={selected.includes(value)}
          onCheckedChange={(on) => onChange(on ? [...selected, value] : selected.filter((s) => s !== value))}
        />
      ))}
    </div>
  )
}

function ScopeEditor({ engagement }: { engagement: SecurityEngagementDetail }) {
  const [draft, setDraft] = useState(() => toDraft(engagement.scope, engagement))
  const [baseVersion, setBaseVersion] = useState(engagement.scopeVersion)
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const setHost = (index: number, patch: Partial<HostDraft>) => setDraft((d) => ({ ...d, hosts: d.hosts.map((h, i) => (i === index ? { ...h, ...patch } : h)) }))
  const manifest = useMemo(() => toManifest(draft), [draft])
  const validation = useMemo(() => ScopeManifest.safeParse(manifest), [manifest])
  const closed = engagement.status === 'completed' || engagement.status === 'cancelled'
  const save = useEngagementMutation(engagement.id, () => api.updateScope(engagement.id, manifest, baseVersion), {
    success: (next) => {
      setBaseVersion(next.scopeVersion)
      return next.scopeVersion === baseVersion ? 'Scope unchanged' : `Scope saved as version ${next.scopeVersion}`
    },
    error: 'Could not save the scope',
  })
  const ceilings = engagement.policy.limits.ceilings

  return (
    <Panel>
      <PanelHeader
        title="Scope"
        description={`Version ${engagement.scopeVersion}. Only what is listed here is in scope: subdomains, other ports, redirects and third parties never are implicitly.`}
        actions={
          <Button size="sm" variant="primary" disabled={closed || !validation.success || save.isPending} onClick={() => save.mutate(undefined)}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save scope
          </Button>
        }
      />
      <PanelBody className="flex flex-col gap-5">
        {!validation.success ? (
          <Notice tone="warning" title="The scope cannot be saved yet">
            <ul className="list-inside list-disc">
              {validation.error.issues.slice(0, 5).map((issue, i) => (
                <li key={i}>
                  {issue.path.length ? `${humanizeKey(String(issue.path[0]))}: ` : ''}
                  {issue.message}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}

        <section>
          <SectionLabel>Hosts</SectionLabel>
          <div className="flex flex-col gap-2">
            {draft.hosts.map((host, index) => (
              <div key={index} className="grid items-end gap-2 rounded-md border border-border p-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto_auto]">
                <Field label="Host" htmlFor={`host-${index}`}>
                  <Input id={`host-${index}`} value={host.host} placeholder="app.example.com or 127.0.0.1" onChange={(e) => setHost(index, { host: e.target.value })} />
                </Field>
                <Field label="Ports" htmlFor={`ports-${index}`}>
                  <Input id={`ports-${index}`} value={host.ports} placeholder="Default (443 / 80)" onChange={(e) => setHost(index, { ports: e.target.value })} />
                </Field>
                <Field label="Paths" htmlFor={`paths-${index}`}>
                  <Input id={`paths-${index}`} value={host.pathPrefixes} placeholder="Whole host" onChange={(e) => setHost(index, { pathPrefixes: e.target.value })} />
                </Field>
                <Switch label="Subdomains" checked={host.includeSubdomains} onCheckedChange={(on) => setHost(index, { includeSubdomains: on })} />
                <Button variant="ghost" size="icon" aria-label={`Remove ${host.host || 'host'}`} onClick={() => set({ hosts: draft.hosts.filter((_, i) => i !== index) })}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div>
              <Button size="sm" onClick={() => set({ hosts: [...draft.hosts, { host: '', includeSubdomains: false, ports: '', pathPrefixes: '' }] })}>
                <Plus />
                Add host
              </Button>
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <Field label="Protocols" hint="Default ports apply to their own scheme only (443 for HTTPS, 80 for HTTP).">
            <div className="flex gap-1">
              <Switch label="HTTPS" checked={draft.https} onCheckedChange={(on) => set({ https: on })} />
              <Switch label="HTTP" checked={draft.http} onCheckedChange={(on) => set({ http: on })} />
            </div>
          </Field>
          <Field label="Redirects" hint="Followed only when in scope; every hop is evaluated as its own destination.">
            <div className="flex items-center gap-2">
              <Switch label="Follow" checked={draft.followRedirects} onCheckedChange={(on) => set({ followRedirects: on })} />
              <Input aria-label="Maximum redirect hops" className="w-20" inputMode="numeric" value={draft.maxHops} onChange={(e) => set({ maxHops: e.target.value })} />
              <span className="text-xs text-muted">hops</span>
            </div>
          </Field>
          <Field label="Network addresses" hint="Exact IP targets, one per line." htmlFor="addresses">
            <Textarea id="addresses" rows={2} value={draft.addresses} onChange={(e) => set({ addresses: e.target.value })} />
          </Field>
          <Field label="Network blocks (CIDR)" hint="At most 65,536 addresses per block." htmlFor="cidrs">
            <Textarea id="cidrs" rows={2} value={draft.cidrs} onChange={(e) => set({ cidrs: e.target.value })} />
          </Field>
          <Field label="Excluded hosts" hint="example.com, or *.example.com for its subdomains. Exclusions always win." htmlFor="ex-hosts">
            <Textarea id="ex-hosts" rows={2} value={draft.exclusionHosts} onChange={(e) => set({ exclusionHosts: e.target.value })} />
          </Field>
          <Field label="Excluded paths" hint="Path prefixes such as /admin." htmlFor="ex-paths">
            <Textarea id="ex-paths" rows={2} value={draft.exclusionPaths} onChange={(e) => set({ exclusionPaths: e.target.value })} />
          </Field>
          <Field label="Authorized dependencies" hint="Third parties you explicitly include. Everything a page merely loads stays out of scope." htmlFor="deps">
            <Textarea id="deps" rows={2} value={draft.dependencies} onChange={(e) => set({ dependencies: e.target.value })} />
          </Field>
          <Field label="Testing window" hint="Optional. Outside it, nothing may execute.">
            <div className="flex flex-wrap gap-2">
              <Input aria-label="Window start" type="datetime-local" className="w-auto" value={draft.windowStart} onChange={(e) => set({ windowStart: e.target.value })} />
              <Input aria-label="Window end" type="datetime-local" className="w-auto" value={draft.windowEnd} onChange={(e) => set({ windowEnd: e.target.value })} />
            </div>
          </Field>
        </section>

        <section>
          <SectionLabel>Limits</SectionLabel>
          <p className="mb-2 text-xs text-muted">Empty fields use the environment ceiling. Larger values are reduced to the ceiling.</p>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {EXECUTION_LIMIT_KEYS.map((key) => (
              <Field key={key} label={LIMIT_LABELS[key]} htmlFor={`limit-${key}`}>
                <Input
                  id={`limit-${key}`}
                  inputMode="numeric"
                  placeholder={String(ceilings[key])}
                  value={draft.limits[key] ?? ''}
                  onChange={(e) => set({ limits: { ...draft.limits, [key]: e.target.value } })}
                />
              </Field>
            ))}
          </div>
        </section>

        <section>
          <SectionLabel>Permissions</SectionLabel>
          <div className="flex flex-col gap-3">
            <Field label="Risk and mutation classes" hint="Profile defaults: what the policy profile allows by default in this environment.">
              <Switch label="Profile defaults" checked={draft.profileDefaults} onCheckedChange={(on) => set({ profileDefaults: on })} />
            </Field>
            {!draft.profileDefaults ? (
              <>
                <Field label="Risk classes" hint="Classes the profile denies stay denied; opt-in classes need to be selected here.">
                  <Toggles values={RISK_CLASSES} selected={draft.riskClasses} onChange={(riskClasses) => set({ riskClasses })} label={(v) => RISK_CLASS_INFO[v].label} />
                </Field>
                <Field label="Mutation classes">
                  <Toggles values={MUTATION_CLASSES} selected={draft.mutationClasses} onChange={(mutationClasses) => set({ mutationClasses })} label={(v) => MUTATION_CLASS_INFO[v].label} />
                </Field>
              </>
            ) : null}
            <Field label="External integrations" hint="Third-party services a capability may call. Only effective where the profile permits them.">
              <Switch label="Allow" checked={draft.externalIntegrations} onCheckedChange={(on) => set({ externalIntegrations: on })} />
            </Field>
          </div>
        </section>
      </PanelBody>
    </Panel>
  )
}

function EvaluationRow({ title, evaluation }: { title: string; evaluation: ScopeEvaluation }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted">{title}</span>
        <DecisionBadge decision={evaluation.decision} />
        <span className="font-mono text-2xs text-subtle">{evaluation.rule}</span>
      </div>
      <p className="text-sm text-foreground text-break">{evaluation.reason}</p>
      <p className="text-xs text-muted">
        {humanizeKey(evaluation.classification)}
        {evaluation.destination.addresses.length ? ` · ${evaluation.destination.addresses.map((a) => `${a.address} (${a.category})`).join(', ')}` : ''}
      </p>
    </div>
  )
}

function ScopeCheck({ engagement }: { engagement: SecurityEngagementDetail }) {
  const [url, setUrl] = useState('')
  const check = useMutation({ mutationFn: (value: string) => api.validateScope(engagement.id, value) })
  return (
    <Panel className="self-start">
      <PanelHeader title="Check a URL" description="Evaluates the saved scope by name and by resolved address. Sends nothing to the target." />
      <PanelBody className="flex flex-col gap-3">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (url.trim()) check.mutate(url.trim())
          }}
        >
          <Input aria-label="URL to check" icon={<Search />} placeholder="https://www.example.com/login" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button type="submit" disabled={check.isPending || !url.trim()}>
            {check.isPending ? <Loader2 className="animate-spin" /> : null}
            Check
          </Button>
        </form>
        {check.isError ? <p className="text-xs text-critical">{check.error.message}</p> : null}
        {check.data ? (
          <div className="flex flex-col gap-2" data-testid="scope-check-result">
            <EvaluationRow title="By name" evaluation={check.data.evaluation} />
            {check.data.network ? <EvaluationRow title="Resolved addresses" evaluation={check.data.network} /> : null}
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  )
}

export function ScopeTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
      {/* Remount the editor when the stored scope changes elsewhere, so it never edits a stale copy. */}
      <ScopeEditor key={engagement.scopeHash} engagement={engagement} />
      <ScopeCheck engagement={engagement} />
    </div>
  )
}
