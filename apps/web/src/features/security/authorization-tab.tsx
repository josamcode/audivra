import type { AuthorizationMethod, EffectiveAuthorizationStatus, SecurityAuthorizationItem, SecurityEngagementDetail } from '@audivra/contracts'
import { Loader2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { EmptyState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input, Label } from '@/components/ui/input'
import { api } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'
import { useEngagementMutation } from './use-engagement-mutation'

const STATUS: Record<EffectiveAuthorizationStatus, { label: string; tone: BadgeTone }> = {
  verified: { label: 'Verified', tone: 'success' },
  pending: { label: 'Pending', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'critical' },
  revoked: { label: 'Revoked', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'medium' },
}

const subjectText = (a: SecurityAuthorizationItem) =>
  `${a.subject.includeSubdomains ? '*.' : ''}${a.subject.host.includes(':') ? `[${a.subject.host}]` : a.subject.host}${a.subject.port ? `:${a.subject.port}` : ''}`

function defaultTarget(targetUrl: string): { host: string; port: string } {
  const url = new URL(targetUrl)
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || (url.protocol === 'https:' ? '443' : '80') }
}

function LocalVerification({ engagement }: { engagement: SecurityEngagementDetail }) {
  const initial = defaultTarget(engagement.targetUrl)
  const [host, setHost] = useState(initial.host)
  const [port, setPort] = useState(initial.port)
  const verify = useEngagementMutation(
    engagement.id,
    async (method: AuthorizationMethod) => (await api.requestAuthorization(engagement.id, method, { host: host.trim(), port: Number(port) || null })).engagement,
    {
      success: (next) => (next.authorizations[0]?.status === 'verified' ? 'Local target verified' : `Not verified: ${next.authorizations[0]?.reason ?? ''}`),
      error: 'Verification failed',
    },
  )
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        verify.mutate('local-development')
      }}
    >
      <div className="flex min-w-40 flex-1 flex-col gap-1.5">
        <Label htmlFor="auth-host">Host</Label>
        <Input id="auth-host" value={host} onChange={(e) => setHost(e.target.value)} />
      </div>
      <div className="flex w-24 flex-col gap-1.5">
        <Label htmlFor="auth-port">Port</Label>
        <Input id="auth-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
      </div>
      <Button type="submit" variant="primary" disabled={verify.isPending || engagement.status === 'cancelled' || engagement.status === 'completed'}>
        {verify.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
        Verify local target
      </Button>
    </form>
  )
}

export function AuthorizationTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const revoke = useEngagementMutation(engagement.id, (id: string) => api.revokeAuthorization(engagement.id, id), {
    success: 'Authorization revoked',
    error: 'Could not revoke',
  })
  const authorizationCheck = engagement.readiness.checks.find((c) => c.key === 'authorization')
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel>
          <PanelHeader title="Authorization records" description={authorizationCheck?.reason} />
          {engagement.authorizations.length === 0 ? (
            <EmptyState compact icon={ShieldCheck} title="Not authorized" description="Entering a target is not authorization. Verify ownership with one of the available methods." />
          ) : (
            <ul className="divide-y divide-border">
              {engagement.authorizations.map((a) => (
                <li key={a.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-foreground">{subjectText(a)}</span>
                      <Badge tone={STATUS[a.effectiveStatus].tone} dot>
                        {STATUS[a.effectiveStatus].label}
                      </Badge>
                      <span className="text-xs text-muted">{engagement.authorizationMethods.find((m) => m.method === a.method)?.label ?? a.method}</span>
                    </div>
                    {a.reason ? <p className="mt-0.5 text-xs text-muted text-break">{a.reason}</p> : null}
                    <p className="mt-0.5 text-xs text-subtle">
                      {a.verifiedAt ? `Verified ${formatDateTime(a.verifiedAt)}` : `Requested ${formatDateTime(a.createdAt)}`}
                      {a.expiresAt ? ` · expires ${formatRelative(a.expiresAt)}` : ''}
                      {a.revokedAt ? ` · revoked ${formatDateTime(a.revokedAt)}` : ''}
                    </p>
                  </div>
                  {a.effectiveStatus === 'verified' ? (
                    <ConfirmDialog
                      title="Revoke this authorization?"
                      confirmLabel="Revoke"
                      onConfirm={() => revoke.mutate(a.id)}
                      trigger={
                        <Button size="sm" variant="danger" disabled={revoke.isPending}>
                          Revoke
                        </Button>
                      }
                    >
                      {subjectText(a)} will no longer be authorized. Every capability request against it is denied until it is verified again.
                    </ConfirmDialog>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <Panel className="self-start">
        <PanelHeader title="Verification methods" />
        <ul className="divide-y divide-border">
          {engagement.authorizationMethods.map((method) => (
            <li key={method.method} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{method.label}</span>
                {method.available ? <Badge tone="success">Available</Badge> : <Badge>Not available yet</Badge>}
              </div>
              <p className="text-xs text-muted">{method.available ? method.description : `${method.description} ${method.unavailableReason ?? ''}`}</p>
              {method.method === 'local-development' && method.available ? <LocalVerification engagement={engagement} /> : null}
            </li>
          ))}
        </ul>
        <PanelBody className="border-t border-border text-xs text-muted">
          Local development verification only accepts loopback targets on this machine (localhost, 127.0.0.0/8, ::1), one port at a time, and expires
          after 7 days.
        </PanelBody>
      </Panel>
    </div>
  )
}
