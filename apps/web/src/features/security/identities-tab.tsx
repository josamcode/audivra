import type { AuthFlow, CredentialMetadata, EstablishSessionInput, SecurityDomainDeclaration, SecurityEngagementDetail, SessionMetadata, SessionStatus } from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Loader2, LogIn, UserRound } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Panel, PanelBody, PanelHeader } from '@/components/panel'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Sheet } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'
import { engagementCredentialsQuery, engagementIdentitiesQuery, engagementIdentityCoverageQuery, engagementSessionsQuery, queryKeys } from '@/lib/queries'

/*
 * Phase 5 Step 3 — the Identities area. It lists the declared test identities, whether each has a credential
 * configured (never the secret), how it authenticates, and its current session (status/expiry). A session is
 * established or revoked from here; a secret is never typed in or shown, and establishing a session is a
 * trusted server action the AI never performs.
 */

const SESSION_STATUS: Record<SessionStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  pending: { label: 'Pending', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'medium' },
  revoked: { label: 'Revoked', tone: 'neutral' },
  invalid: { label: 'Invalid', tone: 'critical' },
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

interface IdentityView {
  ref: string
  label: string
  type: string
  authMethod: string
  credentialRef: string | null
  roleRefs: string[]
  tenantRef: string | null
  lifecycle: string
}

function identityView(d: SecurityDomainDeclaration): IdentityView {
  const spec = d.spec as Record<string, unknown>
  return {
    ref: d.ref,
    label: d.label,
    type: str(spec.identityType) ?? 'user',
    authMethod: str(spec.authMethod) ?? 'unknown',
    credentialRef: str(spec.credentialRef),
    roleRefs: strList(spec.roleRefs),
    tenantRef: str(spec.tenantRef),
    lifecycle: str(spec.lifecycle) ?? 'declared',
  }
}

export function IdentitiesTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const id = engagement.id
  const identities = useQuery(engagementIdentitiesQuery(id))
  const credentials = useQuery(engagementCredentialsQuery(id))
  const sessions = useQuery(engagementSessionsQuery(id))
  const coverage = useQuery(engagementIdentityCoverageQuery(id))
  const [establishFor, setEstablishFor] = useState<IdentityView | null>(null)
  const queryClient = useQueryClient()

  const revoke = useMutation({
    mutationFn: (sessionId: string) => api.revokeSession(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.engagementSessions(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.engagementEvents(id) })
      toast.success('Session revoked')
    },
    onError: (error) => toast.error('Could not revoke the session', { description: error instanceof Error ? error.message : String(error) }),
  })

  if (identities.isError) return <ErrorState title="Could not load identities" error={identities.error} onRetry={() => void identities.refetch()} />
  if (!identities.data || !credentials.data || !sessions.data) return <LoadingState rows={6} />

  const credByRef = new Map<string, CredentialMetadata>(credentials.data.map((c) => [c.ref, c]))
  const latestByIdentity = new Map<string, SessionMetadata>()
  for (const s of sessions.data) if (!latestByIdentity.has(s.identityRef)) latestByIdentity.set(s.identityRef, s)
  const views = identities.data.map(identityView)

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
      <Panel>
        <PanelHeader title="Identities" description="Declared test identities, their credential and their current session. Secrets are never shown here." />
        {views.length === 0 ? (
          <EmptyState compact icon={UserRound} title="No identities declared" description="Declare an identity (with an optional credential reference) to establish authenticated sessions for it." />
        ) : (
          <ul className="divide-y divide-border">
            {views.map((view) => {
              const credential = view.credentialRef ? credByRef.get(view.credentialRef) : undefined
              const session = latestByIdentity.get(view.ref)
              const sessionStatus = session ? SESSION_STATUS[session.status] : null
              return (
                <li key={view.ref} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{view.label}</span>
                      <Badge tone="neutral">{view.type}</Badge>
                      <span className="text-xs text-muted">auth: {view.authMethod}</span>
                      {sessionStatus ? (
                        <Badge tone={sessionStatus.tone} dot>
                          {sessionStatus.label}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-subtle">
                      <span className="font-mono">{view.ref}</span>
                      {view.tenantRef ? <span>· tenant {view.tenantRef}</span> : null}
                      {view.roleRefs.length ? <span>· roles {view.roleRefs.join(', ')}</span> : null}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {credential ? (
                        <span className="inline-flex items-center gap-1">
                          <KeyRound className="size-3" /> credential “{credential.ref}” ({credential.type}){credential.status === 'revoked' ? ' — revoked' : ''}
                        </span>
                      ) : view.credentialRef ? (
                        <span className="text-medium">credential “{view.credentialRef}” referenced but not stored</span>
                      ) : (
                        <span>no credential configured</span>
                      )}
                      {session ? (
                        <span>
                          {' '}
                          · session {session.id}
                          {session.status === 'active' && session.expiresAt ? ` · expires ${formatRelative(session.expiresAt)}` : ''}
                          {session.refreshedAt ? ` · established ${formatDateTime(session.refreshedAt)}` : ''}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEstablishFor(view)}>
                      <LogIn /> Establish
                    </Button>
                    {session && session.status === 'active' ? (
                      <ConfirmDialog
                        title="Revoke this session?"
                        confirmLabel="Revoke"
                        onConfirm={() => revoke.mutate(session.id)}
                        trigger={
                          <Button size="sm" variant="danger" disabled={revoke.isPending}>
                            Revoke
                          </Button>
                        }
                      >
                        The session material is dropped from the vault. Identity-aware capability requests using it are refused until a new session is established.
                      </ConfirmDialog>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      {coverage.data && coverage.data.length > 0 ? (
        <Panel className="self-start">
          <PanelHeader title="Coverage" description="What the engagement can authenticate as." />
          <ul className="divide-y divide-border">
            {coverage.data.map((c) => (
              <li key={c.ref} className="flex flex-col gap-1.5 px-4 py-3">
                <span className="truncate text-sm font-medium text-foreground">{c.label}</span>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={c.credentialAvailable ? 'success' : c.credentialConfigured ? 'medium' : 'neutral'}>{c.credentialAvailable ? 'credential ready' : c.credentialConfigured ? 'credential unavailable' : 'no credential'}</Badge>
                  <Badge tone={c.sessionActive ? 'success' : c.sessionEstablished ? 'medium' : 'neutral'}>{c.sessionActive ? 'session active' : c.sessionEstablished ? 'session inactive' : 'no session'}</Badge>
                  <Badge tone={c.observationsUnderIdentity > 0 ? 'info' : 'neutral'}>{c.observationsUnderIdentity} observed</Badge>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel className="self-start">
        <PanelHeader title="Sessions" description="Every established session for this engagement." />
        {sessions.data.length === 0 ? (
          <PanelBody className="text-xs text-muted">No sessions yet. Establish one for an identity to run capabilities as that identity.</PanelBody>
        ) : (
          <ul className="divide-y divide-border">
            {sessions.data.map((session) => (
              <li key={session.id} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{session.identityRef}</span>
                  <Badge tone={SESSION_STATUS[session.status].tone} dot>
                    {SESSION_STATUS[session.status].label}
                  </Badge>
                </div>
                <p className="text-xs text-subtle">
                  <span className="font-mono">{session.id}</span> · {session.authMethod} · {session.environment}
                </p>
                <p className="text-xs text-subtle">
                  {session.material ? 'material held' : 'no material'}
                  {session.expiresAt ? ` · expires ${formatRelative(session.expiresAt)}` : ''}
                  {session.revokedAt ? ` · revoked ${formatDateTime(session.revokedAt)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <EstablishSheet engagementId={id} identity={establishFor} onClose={() => setEstablishFor(null)} />
    </div>
  )
}

function EstablishSheet({ engagementId, identity, onClose }: { engagementId: string; identity: IdentityView | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [flowType, setFlowType] = useState<AuthFlow['type']>('api-token')
  const [placement, setPlacement] = useState<'bearer' | 'header'>('bearer')
  const [reuse, setReuse] = useState(true)
  const [validateUrl, setValidateUrl] = useState('')
  const [loginUrl, setLoginUrl] = useState('')
  const [usernameSelector, setUsernameSelector] = useState('')
  const [passwordSelector, setPasswordSelector] = useState('')
  const [submitSelector, setSubmitSelector] = useState('')
  const [successUrlIncludes, setSuccessUrlIncludes] = useState('')
  const [successSelector, setSuccessSelector] = useState('')

  const establish = useMutation({
    mutationFn: (input: EstablishSessionInput) => api.establishSession(engagementId, input),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.engagementSessions(engagementId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.engagementEvents(engagementId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.engagementIdentities(engagementId) })
      if (result.failure) {
        toast.error(`Could not establish a session (${result.failure.kind})`, { description: result.failure.message })
        return
      }
      toast.success(result.reused ? 'Reused an existing session' : result.session ? 'Session established' : 'Running anonymously (no session)')
      onClose()
    },
    onError: (error) => toast.error('Establishment failed', { description: error instanceof Error ? error.message : String(error) }),
  })

  if (!identity) return null

  const buildFlow = (): AuthFlow => {
    const v = validateUrl.trim()
    switch (flowType) {
      case 'anonymous':
        return { type: 'anonymous' }
      case 'api-token':
        return { type: 'api-token', placement, validStatuses: [200], ...(v ? { validateUrl: v } : {}) }
      case 'preestablished':
        return { type: 'preestablished', validStatuses: [200], ...(v ? { validateUrl: v } : {}) }
      case 'form-login':
        return {
          type: 'form-login',
          loginUrl: loginUrl.trim(),
          usernameSelector: usernameSelector.trim(),
          passwordSelector: passwordSelector.trim(),
          submitSelector: submitSelector.trim(),
          ...(successUrlIncludes.trim() ? { successUrlIncludes: successUrlIncludes.trim() } : {}),
          ...(successSelector.trim() ? { successSelector: successSelector.trim() } : {}),
          ...(v ? { validateUrl: v } : {}),
        }
    }
  }

  const formValid = flowType !== 'form-login' || (loginUrl.trim() && usernameSelector.trim() && passwordSelector.trim() && submitSelector.trim())

  return (
    <Sheet
      open={!!identity}
      onOpenChange={(open) => (!open ? onClose() : undefined)}
      eyebrow="Establish session"
      title={identity.label}
      description="Audivra authenticates on the server using the identity's stored credential. The credential is never shown or entered here."
    >
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={(event) => {
          event.preventDefault()
          establish.mutate({ identityRef: identity.ref, flow: buildFlow(), reuse })
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="flow-type">Authentication flow</Label>
          <Select
            label="Authentication flow"
            hideLabel
            value={flowType}
            onValueChange={(next) => setFlowType(next)}
            options={[
              { value: 'api-token', label: 'API token', description: 'Attach the identity’s token/bearer to same-origin requests' },
              { value: 'preestablished', label: 'Pre-established', description: 'Use stored cookies or a header secret' },
              { value: 'form-login', label: 'Form login (browser)', description: 'Log in with a username/password credential' },
              { value: 'anonymous', label: 'Anonymous', description: 'Run unauthenticated (no session)' },
            ]}
          />
        </div>

        {flowType === 'api-token' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="placement">Token placement</Label>
            <Select label="Token placement" hideLabel value={placement} onValueChange={setPlacement} options={[{ value: 'bearer', label: 'Authorization: Bearer' }, { value: 'header', label: 'Credential’s own header' }]} />
          </div>
        ) : null}

        {flowType === 'form-login' ? (
          <>
            <Field label="Login URL (in scope)" value={loginUrl} onChange={setLoginUrl} placeholder="https://app.example.test/login" />
            <Field label="Username field selector" value={usernameSelector} onChange={setUsernameSelector} placeholder="#username" />
            <Field label="Password field selector" value={passwordSelector} onChange={setPasswordSelector} placeholder="#password" />
            <Field label="Submit selector" value={submitSelector} onChange={setSubmitSelector} placeholder="button[type=submit]" />
            <Field label="Success URL contains (optional)" value={successUrlIncludes} onChange={setSuccessUrlIncludes} placeholder="/dashboard" />
            <Field label="Success selector (optional)" value={successSelector} onChange={setSuccessSelector} placeholder="[data-user-menu]" />
          </>
        ) : null}

        {flowType !== 'anonymous' ? (
          <Field label="Validate URL (optional, in scope)" value={validateUrl} onChange={setValidateUrl} placeholder="https://app.example.test/api/me" />
        ) : null}

        <Switch checked={reuse} onCheckedChange={setReuse} label="Reuse a valid existing session" />

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={establish.isPending || !formValid}>
            {establish.isPending ? <Loader2 className="animate-spin" /> : <LogIn />}
            Establish
          </Button>
        </div>
      </form>
    </Sheet>
  )
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  )
}
