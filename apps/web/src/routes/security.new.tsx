import { zodResolver } from '@hookform/resolvers/zod'
import {
  CreateEngagementInput,
  DEFAULT_POLICY_PROFILE_KEY,
  SECURITY_ENVIRONMENT_INFO,
  SECURITY_ENVIRONMENTS,
  SECURITY_POLICY_PROFILES,
  SecurityEnvironment,
  type PolicyProfileKey,
} from '@audivra/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Globe, Loader2, ShieldCheck } from 'lucide-react'
import { Controller, useForm } from 'react-hook-form'
import { toast } from 'sonner'
import type { z } from 'zod'
import { PageFrame, PageHeader, pageColumns } from '@/components/page-header'
import { Panel, PanelBody, PanelHeader, SectionLabel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { ChoiceList } from '@/components/ui/choice-list'
import { Input, Label, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/queries'

export const Route = createFileRoute('/security/new')({
  component: NewEngagementPage,
})

/** The environment is optional in the API (an engagement can be drafted) but chosen deliberately here. */
const NewEngagementForm = CreateEngagementInput.extend({ environment: SecurityEnvironment.nullable().refine((value) => value !== null, 'Choose the environment') })
type NewEngagementForm = z.input<typeof NewEngagementForm>

const PROFILES = SECURITY_POLICY_PROFILES.filter((p) => !p.retired)

function NewEngagementPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const form = useForm<NewEngagementForm>({
    resolver: zodResolver(NewEngagementForm),
    defaultValues: { name: '', targetUrl: '', environment: null, policyProfile: DEFAULT_POLICY_PROFILE_KEY, description: '' },
  })
  const mutation = useMutation({
    mutationFn: (values: NewEngagementForm) =>
      api.createEngagement({
        name: values.name.trim(),
        targetUrl: values.targetUrl.trim(),
        environment: values.environment ?? undefined,
        policyProfile: values.policyProfile,
        description: values.description?.trim() || undefined,
      }),
    onSuccess: (engagement) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.engagements })
      queryClient.setQueryData(queryKeys.engagement(engagement.id), engagement)
      toast.success('Engagement created', { description: engagement.name })
      void navigate({ to: '/security/$engagementId', params: { engagementId: engagement.id } })
    },
    onError: (error) => form.setError('targetUrl', { message: error instanceof Error ? error.message : 'Could not create the engagement' }),
  })
  const { errors } = form.formState

  return (
    <div className="pb-10">
      <PageHeader title="New security engagement" description="Define what is assessed and where it runs. Authorization and scope come next." />
      <PageFrame className={pageColumns}>
        <Panel>
          <PanelHeader title="Engagement" />
          <PanelBody>
            <form className="flex flex-col gap-4" noValidate onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" placeholder="Checkout staging review" autoFocus aria-invalid={errors.name ? true : undefined} {...form.register('name')} />
                {errors.name ? <p className="text-xs text-critical">{errors.name.message}</p> : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="targetUrl">Target URL</Label>
                <Input
                  id="targetUrl"
                  icon={<Globe />}
                  placeholder="https://staging.example.com"
                  inputMode="url"
                  aria-invalid={errors.targetUrl ? true : undefined}
                  aria-describedby="target-hint"
                  {...form.register('targetUrl')}
                />
                {errors.targetUrl ? (
                  <p className="text-xs text-critical">{errors.targetUrl.message}</p>
                ) : (
                  <p id="target-hint" className="text-xs text-muted">
                    The scope starts as exactly this host, scheme and port — nothing else is included until you add it.
                  </p>
                )}
              </div>
              <Controller
                control={form.control}
                name="environment"
                render={({ field }) => (
                  <div className="flex flex-col gap-1.5">
                    <Label id="environment-label">Environment</Label>
                    <ChoiceList
                      label="Environment"
                      value={field.value ?? null}
                      onValueChange={field.onChange}
                      invalid={Boolean(errors.environment)}
                      options={SECURITY_ENVIRONMENTS.map((env) => ({ value: env, label: SECURITY_ENVIRONMENT_INFO[env].label, description: SECURITY_ENVIRONMENT_INFO[env].description }))}
                    />
                    {errors.environment ? <p className="text-xs text-critical">{errors.environment.message}</p> : null}
                  </div>
                )}
              />
              <Controller
                control={form.control}
                name="policyProfile"
                render={({ field }) => (
                  <div className="flex flex-col gap-1.5">
                    <Label>Policy profile</Label>
                    <Select<PolicyProfileKey>
                      label="Policy profile"
                      hideLabel
                      value={field.value ?? DEFAULT_POLICY_PROFILE_KEY}
                      onValueChange={field.onChange}
                      options={PROFILES.map((p) => ({ value: p.key, label: `${p.name} (v${p.version})`, description: p.description }))}
                      className="w-full"
                    />
                  </div>
                )}
              />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="description">
                  Notes <span className="font-normal text-subtle">(optional)</span>
                </Label>
                <Textarea id="description" rows={3} placeholder="Context, contacts, constraints. Do not paste credentials." {...form.register('description')} />
              </div>
              <div className="flex justify-end border-t border-border pt-4">
                <Button type="submit" variant="primary" disabled={mutation.isPending}>
                  {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
                  Create engagement
                  {!mutation.isPending ? <ArrowRight /> : null}
                </Button>
              </div>
            </form>
          </PanelBody>
        </Panel>
        <Panel className="self-start">
          <PanelHeader title="What this does" />
          <PanelBody className="flex flex-col gap-3 text-xs text-muted">
            <p>Creates a draft engagement. Nothing is sent to the target.</p>
            <div>
              <SectionLabel>Next</SectionLabel>
              <p>Verify authorization, review the scope and check the effective policy. The engagement becomes ready only when all of them hold.</p>
            </div>
            <p className="flex gap-2 border-t border-border pt-3">
              <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />
              Production defaults to the most restrictive policy.
            </p>
          </PanelBody>
        </Panel>
      </PageFrame>
    </div>
  )
}
