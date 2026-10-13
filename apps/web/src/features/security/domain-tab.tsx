import type { DomainDeclarationKind, SecurityDomainDeclaration, SecurityEngagementDetail } from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, Loader2, Plus } from 'lucide-react'
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
import { api } from '@/lib/api'
import { engagementDeclarationsQuery, queryKeys } from '@/lib/queries'

/*
 * Phase 5 Step 5 — the Domain management view. A person declares, updates and retires the application-semantics
 * an engagement holds (identities, roles, tenants, resources, business actions/states, invariants) so a real
 * engagement never needs fixture/database seeding. Relationships are declared through reference fields and
 * validated server-side (no dangling references). Credential VALUES live only in the vault — never here.
 */

const KINDS: { value: DomainDeclarationKind; label: string }[] = [
  { value: 'identity', label: 'Identity' },
  { value: 'role', label: 'Role' },
  { value: 'tenant', label: 'Tenant' },
  { value: 'resource', label: 'Resource' },
  { value: 'business-action', label: 'Business action' },
  { value: 'business-state', label: 'Business state' },
  { value: 'invariant', label: 'Invariant' },
]

const SOURCE_TONE: Record<string, BadgeTone> = { declared: 'info', observed: 'success', 'code-derived': 'neutral', 'ai-inferred': 'medium' }

/** The fields each kind's form offers (a subset of the strict contract; lists are comma-separated). */
interface FieldDef {
  name: string
  label: string
  kind: 'text' | 'list' | 'select'
  options?: string[]
  placeholder?: string
}
const FIELDS: Record<DomainDeclarationKind, FieldDef[]> = {
  identity: [
    { name: 'identityType', label: 'Type', kind: 'select', options: ['user', 'admin', 'service', 'anonymous', 'other'] },
    { name: 'authMethod', label: 'Auth method', kind: 'select', options: ['api-token', 'form', 'session', 'preauthenticated', 'browser', 'none', 'unknown'] },
    { name: 'credentialRef', label: 'Credential ref (vault pointer, not a secret)', kind: 'text', placeholder: 'alice-cred' },
    { name: 'tenantRef', label: 'Tenant ref', kind: 'text' },
    { name: 'roleRefs', label: 'Role refs', kind: 'list', placeholder: 'editor, viewer' },
  ],
  role: [
    { name: 'scopeTenantRef', label: 'Scope tenant ref', kind: 'text' },
    { name: 'permits', label: 'Permitted action refs', kind: 'list', placeholder: 'approve, delete' },
  ],
  tenant: [
    { name: 'tenantType', label: 'Type', kind: 'select', options: ['organization', 'workspace', 'account', 'project', 'other'] },
    { name: 'externalId', label: 'External id', kind: 'text' },
  ],
  resource: [
    { name: 'resourceType', label: 'Resource type', kind: 'text', placeholder: 'document' },
    { name: 'ownerRef', label: 'Owner (identity ref)', kind: 'text' },
    { name: 'tenantRef', label: 'Tenant ref', kind: 'text' },
    { name: 'canonicalUrl', label: 'Canonical URL (in scope)', kind: 'text', placeholder: 'https://app.test/api/resources/1' },
    { name: 'testData', label: 'Test data', kind: 'select', options: ['test-owned', 'synthetic', 'production-like', 'unknown'] },
  ],
  'business-action': [
    { name: 'verb', label: 'Verb', kind: 'text', placeholder: 'approve' },
    { name: 'endpointUrl', label: 'Endpoint URL', kind: 'text' },
    { name: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    { name: 'requiredRoleRefs', label: 'Required role refs', kind: 'list' },
    { name: 'actsOnRefs', label: 'Acts-on resource refs', kind: 'list' },
    { name: 'stateProbeUrl', label: 'State probe URL', kind: 'text' },
  ],
  'business-state': [
    { name: 'name', label: 'State name', kind: 'text', placeholder: 'approved' },
    { name: 'resourceType', label: 'Resource type', kind: 'text' },
    { name: 'transitionsToRefs', label: 'Transitions-to state refs', kind: 'list' },
  ],
  invariant: [
    { name: 'category', label: 'Category', kind: 'select', options: ['object-boundary', 'role-boundary', 'tenant-boundary', 'function-level', 'field-access', 'session-boundary', 'state-transition', 'ownership', 'other'] },
    { name: 'rule', label: 'Rule', kind: 'text', placeholder: 'Only the owner may read a document' },
  ],
}

export function DomainTab({ engagement }: { engagement: SecurityEngagementDetail }) {
  const id = engagement.id
  const declarations = useQuery(engagementDeclarationsQuery(id))
  const [declaring, setDeclaring] = useState(false)
  const queryClient = useQueryClient()
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: queryKeys.engagementDeclarations(id) })

  const retire = useMutation({
    mutationFn: (declarationId: string) => api.retireDeclaration(declarationId),
    onSuccess: () => {
      invalidate()
      toast.success('Declaration retired')
    },
    onError: (error) => toast.error('Could not retire', { description: error instanceof Error ? error.message : String(error) }),
  })

  if (declarations.isError) return <ErrorState title="Could not load the domain" error={declarations.error} onRetry={() => void declarations.refetch()} />
  if (!declarations.data) return <LoadingState rows={6} />

  const byKind = new Map<DomainDeclarationKind, SecurityDomainDeclaration[]>()
  for (const d of declarations.data) byKind.set(d.kind, [...(byKind.get(d.kind) ?? []), d])

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Application domain"
          description="The identities, roles, tenants, resources, business actions/states and invariants this engagement holds. Declaring here means no database seeding is needed."
          actions={
            <Button size="sm" variant="primary" onClick={() => setDeclaring(true)}>
              <Plus /> Declare
            </Button>
          }
        />
        {declarations.data.length === 0 ? (
          <EmptyState compact icon={Boxes} title="No domain declared" description="Declare identities, roles, tenants, resources and invariants to let Audivra reason about and compare the application's boundaries." />
        ) : (
          <div className="flex flex-col">
            {KINDS.filter((k) => byKind.has(k.value)).map((k) => (
              <section key={k.value} className="border-b border-border last:border-0">
                <h3 className="px-4 pt-3 text-xs font-semibold tracking-wide text-muted uppercase">{k.label}</h3>
                <ul className="divide-y divide-border">
                  {byKind.get(k.value)!.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm text-foreground">{d.ref}</span>
                          <Badge tone={SOURCE_TONE[d.source] ?? 'neutral'}>{d.source}</Badge>
                          {d.version > 1 ? <span className="text-xs text-subtle">v{d.version}</span> : null}
                        </div>
                        <p className="mt-0.5 text-xs text-subtle text-break">{summarize(d)}</p>
                      </div>
                      <ConfirmDialog
                        title="Retire this declaration?"
                        confirmLabel="Retire"
                        onConfirm={() => retire.mutate(d.id)}
                        trigger={
                          <Button size="sm" variant="danger" disabled={retire.isPending}>
                            Retire
                          </Button>
                        }
                      >
                        {d.ref} will be kept for history but no longer projected into the graph or used in comparisons.
                      </ConfirmDialog>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        <PanelBody className="border-t border-border text-xs text-muted">Credential values are never declared here — they live in the vault (Identities tab). A declaration holds only an opaque credential reference.</PanelBody>
      </Panel>
      <DeclareSheet engagementId={id} open={declaring} onClose={() => setDeclaring(false)} onCreated={invalidate} />
    </div>
  )
}

function summarize(d: SecurityDomainDeclaration): string {
  const spec = d.spec as Record<string, unknown>
  const parts = Object.entries(spec)
    .filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0) && v !== false && v !== 'unknown')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('/') : String(v)}`)
  return parts.join(' · ').slice(0, 300) || d.label
}

function DeclareSheet({ engagementId, open, onClose, onCreated }: { engagementId: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<DomainDeclarationKind>('identity')
  const [ref, setRef] = useState('')
  const [label, setLabel] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})

  const create = useMutation({
    mutationFn: () => {
      const spec: Record<string, unknown> = {}
      for (const field of FIELDS[kind]) {
        const raw = (values[field.name] ?? '').trim()
        if (!raw) continue
        spec[field.name] = field.kind === 'list' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw
      }
      return api.createDeclaration(engagementId, { kind, ref: ref.trim(), label: label.trim() || undefined, spec })
    },
    onSuccess: () => {
      toast.success(`${kind} "${ref}" declared`)
      setRef('')
      setLabel('')
      setValues({})
      onCreated()
      onClose()
    },
    onError: (error) => toast.error('Could not declare', { description: error instanceof Error ? error.message : String(error) }),
  })

  return (
    <Sheet open={open} onOpenChange={(o) => (!o ? onClose() : undefined)} eyebrow="Declare" title="New domain declaration" description="A person/Audivra declares application semantics; a model never can. References are validated — no dangling entities.">
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label>Kind</Label>
          <Select label="Kind" hideLabel value={kind} onValueChange={(next) => (setKind(next), setValues({}))} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
        </div>
        <Field label="Handle (ref)" value={ref} onChange={setRef} placeholder="alice / doc1 / editor" />
        <Field label="Label (optional)" value={label} onChange={setLabel} />
        {FIELDS[kind].map((field) => (
          <div key={field.name} className="flex flex-col gap-1.5">
            <Label>{field.label}</Label>
            {field.kind === 'select' ? (
              <Select label={field.label} hideLabel value={values[field.name] ?? field.options![0]!} onValueChange={(v) => setValues((s) => ({ ...s, [field.name]: v }))} options={field.options!.map((o) => ({ value: o, label: o }))} />
            ) : (
              <Input value={values[field.name] ?? ''} onChange={(e) => setValues((s) => ({ ...s, [field.name]: e.target.value }))} placeholder={field.placeholder} />
            )}
          </div>
        ))}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending || !ref.trim()}>
            {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Declare
          </Button>
        </div>
      </form>
    </Sheet>
  )
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  )
}
