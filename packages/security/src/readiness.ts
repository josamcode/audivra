import { SECURITY_ENVIRONMENT_INFO } from '@audivra/contracts'
import type {
  EffectivePolicy,
  EngagementReadiness,
  EngagementStatus,
  LifecycleAction,
  ReadinessCheck,
  ReadinessState,
  ScopeManifest,
  SecurityAuthorizationItem,
  SecurityEnvironment,
} from '@audivra/contracts'
import { authorizationGaps } from './authorization.ts'
import { scopeIssues } from './scope.ts'

/*
 * Readiness is computed from requirements every time it is needed — the stored status is a label for
 * people, never a permission. An engagement can only execute when every check below passes.
 */

export interface ReadinessInput {
  status: EngagementStatus
  environment: SecurityEnvironment | null
  scope: ScopeManifest
  policy: EffectivePolicy
  authorizations: SecurityAuthorizationItem[]
  now: Date
}

export const READINESS_LABELS: Record<ReadinessState, string> = {
  ready: 'Ready',
  'scope-incomplete': 'Scope incomplete',
  'policy-incomplete': 'Policy incomplete',
  'not-authorized': 'Not authorized',
  'outside-window': 'Outside testing window',
  paused: 'Paused',
  closed: 'Closed',
  invalid: 'Invalid',
}

function windowCheck(scope: ScopeManifest, now: Date): { ok: boolean; reason: string } {
  const window = scope.testingWindow
  if (!window) return { ok: true, reason: 'No testing window restriction' }
  const start = Date.parse(window.startsAt)
  const end = Date.parse(window.endsAt)
  if (now.getTime() < start) return { ok: false, reason: `The testing window opens at ${window.startsAt}` }
  if (now.getTime() >= end) return { ok: false, reason: `The testing window ended at ${window.endsAt}` }
  return { ok: true, reason: `Inside the testing window (until ${window.endsAt})` }
}

export function evaluateReadiness(input: ReadinessInput): EngagementReadiness {
  const checks: ReadinessCheck[] = []
  const add = (key: ReadinessCheck['key'], label: string, ok: boolean, reason: string) => checks.push({ key, label, ok, reason })

  const closed = input.status === 'completed' || input.status === 'cancelled'
  add(
    'lifecycle',
    'Lifecycle',
    !closed && input.status !== 'paused' && input.status !== 'invalid',
    closed ? `The engagement is ${input.status}` : input.status === 'paused' ? 'The engagement is paused' : input.status === 'invalid' ? 'The engagement is invalid' : 'Open',
  )
  add('environment', 'Environment', input.environment !== null, input.environment ? SECURITY_ENVIRONMENT_INFO[input.environment].label : 'Choose the environment (production, staging or isolated lab)')
  const scope = scopeIssues(input.scope)
  add('scope', 'Scope', scope.length === 0, scope[0] ?? 'Targets defined')
  add('policy', 'Policy', input.policy.issues.length === 0, input.policy.issues[0] ?? `${input.policy.profile.name} v${input.policy.profile.version}`)
  const gaps = authorizationGaps(input.scope, input.authorizations)
  add('authorization', 'Authorization', gaps.length === 0, gaps.length ? `Not authorized: ${gaps.join('; ')}` : 'Every scope target is covered by a verified authorization')
  const window = windowCheck(input.scope, input.now)
  add('testing-window', 'Testing window', window.ok, window.reason)

  const failed = (key: ReadinessCheck['key']) => checks.some((c) => c.key === key && !c.ok)
  let state: ReadinessState = 'ready'
  if (input.status === 'invalid') state = 'invalid'
  else if (closed) state = 'closed'
  else if (failed('scope')) state = 'scope-incomplete'
  else if (failed('environment') || failed('policy')) state = 'policy-incomplete'
  else if (failed('authorization')) state = 'not-authorized'
  else if (failed('testing-window')) state = 'outside-window'
  else if (input.status === 'paused') state = 'paused'

  return {
    ready: state === 'ready',
    state,
    label: READINESS_LABELS[state],
    checks,
    blockingReasons: checks.filter((c) => !c.ok).map((c) => c.reason),
    evaluatedAt: input.now.toISOString(),
  }
}

const SETUP_STATUSES = new Set<EngagementStatus>(['draft', 'authorization-pending', 'ready'])

/** The setup status that matches the requirements (only setup statuses are recomputed). */
export function derivedStatus(current: EngagementStatus, readiness: EngagementReadiness): EngagementStatus {
  if (!SETUP_STATUSES.has(current)) return current
  if (readiness.state === 'scope-incomplete' || readiness.state === 'policy-incomplete') return 'draft'
  if (readiness.state === 'not-authorized') return 'authorization-pending'
  return 'ready'
}

/** Lifecycle actions. Activation and resumption require the engagement to be ready right now. */
export function applyLifecycleAction(
  current: EngagementStatus,
  action: LifecycleAction,
  readiness: EngagementReadiness,
): { ok: true; status: EngagementStatus } | { ok: false; reason: string } {
  const notReady = () => ({ ok: false as const, reason: `Not ready: ${readiness.blockingReasons.join('; ') || readiness.label}` })
  switch (action) {
    case 'activate':
      if (current !== 'ready') return { ok: false, reason: `Only a ready engagement can be activated (it is ${current})` }
      return readiness.ready ? { ok: true, status: 'active' } : notReady()
    case 'pause':
      return current === 'active' ? { ok: true, status: 'paused' } : { ok: false, reason: `Only an active engagement can be paused (it is ${current})` }
    case 'resume':
      if (current !== 'paused') return { ok: false, reason: `Only a paused engagement can be resumed (it is ${current})` }
      return evaluateResumable(readiness) ? { ok: true, status: 'active' } : notReady()
    case 'complete':
      return current === 'active' || current === 'paused' ? { ok: true, status: 'completed' } : { ok: false, reason: `Only an active or paused engagement can be completed (it is ${current})` }
    case 'cancel':
      return current === 'completed' || current === 'cancelled' ? { ok: false, reason: `The engagement is already ${current}` } : { ok: true, status: 'cancelled' }
  }
}

/** A paused engagement can resume when everything except the pause itself is satisfied. */
function evaluateResumable(readiness: EngagementReadiness): boolean {
  return readiness.state === 'paused' && readiness.checks.every((c) => c.ok || c.key === 'lifecycle')
}
