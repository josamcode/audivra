import { createHash } from 'node:crypto'
import type { ProposedAction, SecurityHypothesis } from '@audivra/contracts'
import type { CapabilityRegistry } from '../capabilities/registry.ts'
import { urlParts } from '../graph/identity.ts'
import { stableJson } from '../graph/projector.ts'
import { evaluateCheck, hypothesisEntities, isOpenHypothesis } from './hypotheses.ts'
import type { KnowledgeView, PlanningCapability } from './knowledge.ts'
import { capabilityFits, planningTargets } from './ranking.ts'

/*
 * Validation of a model's proposed next capability. A proposal names a hypothesis, a capability id, that
 * capability's input, the evidence it expects and why — never an image, command, network policy, scope or
 * environment. Before anything is preflighted with the broker, Audivra checks that:
 *
 *   the hypothesis exists and is still open · the capability exists, may run here and needs only inputs a
 *   planner can supply · the input validates against the capability's strict schema · every target is a
 *   known in-scope asset related to the hypothesis · the capability can produce evidence the unmet checks
 *   need · no cheaper eligible capability does the same · the same action is not already running or already
 *   ran without resolving the hypothesis.
 */

export const ACTION_REJECTIONS = [
  'unknown-hypothesis',
  'hypothesis-resolved',
  'unknown-capability',
  'capability-not-eligible',
  'invalid-input',
  'unknown-asset',
  'unrelated-asset',
  'irrelevant-capability',
  'unnecessary-cost',
  'duplicate-in-plan',
  'redundant-in-flight',
  'redundant',
] as const
export type ActionRejection = (typeof ACTION_REJECTIONS)[number]

export type ActionVerdict =
  | { kind: 'valid'; action: ProposedAction; hypothesis: SecurityHypothesis; capability: PlanningCapability; input: Record<string, unknown>; actionKey: string; targets: string[] }
  | { kind: 'reject'; action: ProposedAction; hypothesis: SecurityHypothesis | null; reason: ActionRejection; detail: string; actionKey: string | null }

/** Stable key of capability + canonical validated input (identical actions share it). */
export function actionKeyOf(capabilityId: string, input: unknown): string {
  return `${capabilityId}:${createHash('sha256').update(stableJson(input)).digest('hex').slice(0, 24)}`
}

const normalizeTarget = (url: string) => {
  const parts = urlParts(url)
  return parts ? `${parts.origin}${parts.path}` : null
}

export function validateAction(action: ProposedAction, view: KnowledgeView, registry: CapabilityRegistry, plannedKeys: ReadonlySet<string>): ActionVerdict {
  const hypothesis = view.hypotheses.find((h) => h.id === action.hypothesisId) ?? null
  const reject = (reason: ActionRejection, detail: string, actionKey: string | null = null): ActionVerdict => ({ kind: 'reject', action, hypothesis, reason, detail, actionKey })
  if (!hypothesis) return reject('unknown-hypothesis', `${action.hypothesisId} is not a hypothesis of this engagement`)
  if (!isOpenHypothesis(hypothesis)) return reject('hypothesis-resolved', `The hypothesis is already ${hypothesis.status}`)

  const capability = view.capabilities.find((c) => c.id === action.capabilityId)
  const implementation = registry.get(action.capabilityId)
  if (!capability || !implementation) return reject('unknown-capability', `${action.capabilityId} is not a capability Audivra can plan`)
  if (!capability.eligibleHere || !capability.plannable) return reject('capability-not-eligible', capability.reason ?? `${capability.id} cannot be planned here`)

  const parsed = implementation.implementation.input.safeParse(action.input)
  if (!parsed.success) {
    return reject('invalid-input', parsed.error.issues.slice(0, 3).map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; '))
  }
  const input = parsed.data as Record<string, unknown>
  const actionKey = actionKeyOf(capability.id, input)

  // Every destination must be a known, in-scope asset related to this hypothesis.
  let targets: string[]
  try {
    targets = implementation.implementation.targets(input)
  } catch (error) {
    return reject('invalid-input', `Could not determine the action's destinations: ${error instanceof Error ? error.message : String(error)}`, actionKey)
  }
  const related = new Set(hypothesisEntities(hypothesis, view).flatMap((id) => planningTargets(view, id)).map(normalizeTarget).filter((t): t is string => !!t))
  const known = new Set([...view.nodes.values()].flatMap((n) => planningTargets(view, n.id)).map(normalizeTarget).filter((t): t is string => !!t))
  for (const target of targets) {
    const normalized = normalizeTarget(target)
    if (!normalized || !known.has(normalized)) return reject('unknown-asset', `${target} is not a known in-scope asset in the graph`, actionKey)
    if (!related.has(normalized)) return reject('unrelated-asset', `${target} is not related to the hypothesis' entities`, actionKey)
  }

  // It must be able to teach us something the unmet checks need — and not cost more than necessary.
  const results = hypothesis.evidenceChecks.map((c, i) => evaluateCheck(c, i, view))
  const fits = capabilityFits(hypothesis, results, view)
  const fit = fits.find((f) => f.capability.id === capability.id)
  if (!fit) return reject('irrelevant-capability', `${capability.id} cannot produce the evidence the unmet checks need`, actionKey)
  // Effective fit: a capability already tried for this hypothesis is worth much less a second time.
  const effective = (f: (typeof fits)[number]) => f.resolvability * (f.previouslyTried ? 0.3 : 1)
  const cheaper = fits.find((f) => f.capability.costUnits < capability.costUnits && effective(f) >= effective(fit))
  if (cheaper) return reject('unnecessary-cost', `${cheaper.capability.id} (${cheaper.capability.costClass} cost) produces the same evidence more cheaply than ${capability.id} (${capability.costClass})`, actionKey)

  if (plannedKeys.has(actionKey)) return reject('duplicate-in-plan', 'The same action is already part of this plan', actionKey)
  if (view.actions.some((a) => a.actionKey === actionKey && a.status === 'queued')) return reject('redundant-in-flight', 'The same action is already running', actionKey)
  const ranBefore = view.actions.find((a) => a.actionKey === actionKey && a.status === 'completed' && a.updatedAt > hypothesis.createdAt)
  if (ranBefore) return reject('redundant', `The same action already ran (${ranBefore.executionId ?? ranBefore.id}) since this hypothesis exists, without resolving it`, actionKey)

  return { kind: 'valid', action, hypothesis, capability, input, actionKey, targets }
}

/**
 * Whether an approved action may run without a person: conservative by design. Only read-only, passive or
 * low-impact capabilities that are not high-cost — and in production, passive ones only.
 */
export function autoExecutable(capability: PlanningCapability, environment: string | null): { ok: boolean; reason: string } {
  if (capability.sideEffect !== 'read-only') return { ok: false, reason: `${capability.id} is not read-only` }
  if (capability.riskClass !== 'passive' && capability.riskClass !== 'low-impact') return { ok: false, reason: `${capability.id} is ${capability.riskClass}` }
  if (capability.costClass === 'high') return { ok: false, reason: `${capability.id} is high-cost` }
  if ((environment ?? 'production') === 'production' && capability.riskClass !== 'passive') return { ok: false, reason: `Only passive capabilities run automatically in production` }
  return { ok: true, reason: 'Read-only, low-risk and within the automatic-execution rules' }
}
