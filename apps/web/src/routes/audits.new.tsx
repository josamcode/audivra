import { zodResolver } from '@hookform/resolvers/zod'
import { CreateAuditInput } from '@audivra/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Globe, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { PageFrame, PageHeader, pageColumns } from '@/components/page-header'
import { Panel, PanelBody, PanelHeader, SectionLabel } from '@/components/panel'
import { Notice } from '@/components/states'
import { Dot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { api } from '@/lib/api'
import { queryKeys, systemQuery } from '@/lib/queries'

export const Route = createFileRoute('/audits/new')({
  component: NewAuditPage,
})

const PIPELINE = [
  {
    title: 'Baseline inspection',
    text: 'Crawl, sitemap/robots, Lighthouse, axe accessibility, screenshots, console and network capture, headers/TLS, tracking and localization signals.',
  },
  {
    title: 'AI investigation',
    text: 'An autonomous auditor uses a real browser, terminal and audit tools, and writes small scripts when useful. Every important claim is backed by recorded evidence.',
  },
  {
    title: 'Adversarial review',
    text: 'A reviewer challenges unsupported claims, inflated severities and missed areas.',
  },
  {
    title: 'Verification pass',
    text: 'The auditor rechecks what the reviewer flagged, then findings are finalized.',
  },
]

function Readiness() {
  const { data, isLoading, isError } = useQuery(systemQuery())
  if (isLoading) return <p className="text-xs text-muted">Checking local tools…</p>
  if (isError || !data) {
    return (
      <Notice tone="critical" icon={TriangleAlert} title="Cannot reach the Audivra API">
        Start the app with <code className="font-mono text-xs">pnpm dev</code>.
      </Notice>
    )
  }
  const claude = data.tools.find((tool) => tool.id === 'claude')
  const ready = data.tools.filter((tool) => tool.state === 'ready').length
  if (claude && claude.state !== 'ready') {
    return (
      <Notice
        tone="warning"
        icon={TriangleAlert}
        title={claude.state === 'disabled' ? 'AI is disabled' : 'Claude runtime unavailable'}
      >
        The audit will run the baseline only. {claude.detail}{' '}
        <Link to="/system" className="text-link hover:underline">
          View system status
        </Link>
      </Notice>
    )
  }
  return (
    <Link to="/system" className="inline-flex items-center gap-2 text-xs text-muted hover:text-foreground">
      <Dot tone="success" />
      Claude ready
      <span className="text-subtle">·</span>
      <span className="tabular-nums">
        {ready}/{data.tools.length} tools ready
      </span>
    </Link>
  )
}

function NewAuditPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const form = useForm<CreateAuditInput>({
    resolver: zodResolver(CreateAuditInput),
    defaultValues: { url: '', clientName: '' },
    mode: 'onSubmit',
  })
  const mutation = useMutation({
    mutationFn: (input: CreateAuditInput) =>
      api.createAudit({
        url: input.url,
        clientName: input.clientName?.trim() ? input.clientName.trim() : undefined,
      }),
    onSuccess: (audit) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.audits })
      queryClient.setQueryData(queryKeys.audit(audit.id), audit)
      toast.success('Audit started', { description: audit.domain })
      void navigate({ to: '/audits/$auditId', params: { auditId: audit.id } })
    },
    onError: (error) => {
      form.setError('url', { message: error instanceof Error ? error.message : 'Could not start the audit' })
    },
  })
  const { errors } = form.formState

  return (
    <div className="pb-10">
      <PageHeader title="New audit" description="Paste a website. Business context is inferred from the public site." />
      <PageFrame className={pageColumns}>
        <Panel>
          <PanelHeader title="Target" />
          <PanelBody>
            <form
              className="flex flex-col gap-4"
              noValidate
              onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="url">Website URL</Label>
                <Input
                  id="url"
                  icon={<Globe />}
                  placeholder="https://example.com"
                  autoComplete="url"
                  inputMode="url"
                  autoFocus
                  aria-invalid={errors.url ? true : undefined}
                  aria-describedby={errors.url ? 'url-error' : 'url-hint'}
                  {...form.register('url')}
                />
                {errors.url ? (
                  <p id="url-error" className="text-xs text-critical">
                    {errors.url.message}
                  </p>
                ) : (
                  <p id="url-hint" className="text-xs text-muted">
                    The homepage or any page of the site. Bare domains are fine.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="clientName">
                  Client / project name <span className="font-normal text-subtle">(optional)</span>
                </Label>
                <Input
                  id="clientName"
                  placeholder="Acme Dental"
                  autoComplete="organization"
                  {...form.register('clientName')}
                />
                {errors.clientName ? (
                  <p className="text-xs text-critical">{errors.clientName.message}</p>
                ) : null}
              </div>
              <div className="flex flex-col-reverse gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <Readiness />
                <Button type="submit" variant="primary" disabled={mutation.isPending}>
                  {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
                  Start full audit
                  {!mutation.isPending ? <ArrowRight /> : null}
                </Button>
              </div>
            </form>
          </PanelBody>
        </Panel>

        <Panel className="self-start">
          <PanelHeader title="What happens" />
          <PanelBody className="flex flex-col gap-4">
            <ol className="flex flex-col gap-3">
              {PIPELINE.map((step, index) => (
                <li key={step.title} className="flex gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-sm border border-border font-mono text-2xs text-muted">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{step.title}</p>
                    <p className="text-xs text-muted">{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div>
              <SectionLabel>Safety</SectionLabel>
              <p className="flex gap-2 text-xs text-muted">
                <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />
                Passive security checks only. No forms are submitted, nothing is purchased and no active
                scanning is run.
              </p>
            </div>
          </PanelBody>
        </Panel>
      </PageFrame>
    </div>
  )
}
