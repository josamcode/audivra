import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, resetConfig } from '@audivra/config'
import type { AiTaskOutcome, SessionEstablishmentResult } from '@audivra/contracts'
import { createBoss, ensureQueues, listFindingsForEngagement, listResearchActions, type PgBoss } from '@audivra/database'
import {
  CapabilityBroker,
  createDbSecurityStore,
  createRuntimeRegistry,
  DomainService,
  FakeSpecialistEngine,
  GraphProjector,
  ResearchReadService,
  ResearchService,
  SecurityService,
  SecretVault,
  SessionEstablishmentService,
  VaultAuthResolver,
  keyringFromKeys,
  type ReasoningAi,
  type ReasoningAiResult,
  type Resolver,
} from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, startIdentityFixture, testDb, type IdentityFixture } from '../../../test/helpers.ts'

/*
 * Phase 6E end to end on the real database + identity fixture, with a scripted AI + the deterministic fake
 * specialist. It proves the bounded research loop orchestrates the existing services: a healthy app stops with
 * ZERO findings; an authorization issue is found via a cheap comparison → verification → finding → attack
 * path without touching the expensive specialist; propose-only executes nothing; a provider outage degrades
 * honestly; and adversarial AI proposals are rejected deterministically.
 */

const KEY = randomBytes(32)
const handle = testDb()
const { db, pool } = handle
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const loopback: Resolver = async (host) => (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost') ? ['127.0.0.1'] : Promise.reject(new Error(`unexpected lookup ${host}`)))
const service = new SecurityService({ db, resolver: loopback })
const domain = new DomainService({ db })
const vault = new SecretVault({ db, keyring: keyringFromKeys([{ key: KEY }]) })
const registry = createRuntimeRegistry()

let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>
let fixture: IdentityFixture
let projector: GraphProjector
let broker: CapabilityBroker
let establishment: SessionEstablishmentService

function aiResult(outcome: AiTaskOutcome['outcome'], output: unknown): ReasoningAiResult {
  return { outcome, output, selection: { taskType: 'security-plan', providerId: 'fake', model: null, reason: 'test', considered: [], at: new Date().toISOString() }, provenance: [], attempts: 1, refused: false, promptVersion: 'v1' }
}
/** A scripted AI: the research planner proposes nothing (deterministic loop), and verification confirms. */
const confirmingAi: ReasoningAi = {
  async run(task) {
    if (task.prompt === 'security-research-planner') return aiResult('succeeded', { proposals: [], note: '' })
    if (task.prompt === 'security-finding-verifier') return aiResult('succeeded', { verdict: 'confirm', rationale: 'controls confirm the boundary is broken', citedEvidenceRefs: [], alternativeExplanation: null, missingEvidence: null, proposedAction: null })
    if (task.prompt === 'security-finding-prose') return aiResult('succeeded', { title: 'Broken authorization boundary', impact: 'Cross-boundary access.', remediation: 'Enforce the boundary.', severityExplanation: '' })
    if (task.prompt === 'security-attack-path-proposer') return aiResult('succeeded', { proposals: [] })
    if (task.prompt === 'security-attack-path-explainer') return aiResult('succeeded', { title: 'Path', explanation: 'A structured route.' })
    return aiResult('succeeded', { verdict: 'ok', note: '', suggestedSeverity: null })
  },
}
/** The planner becomes unavailable mid-run; verification still works (deterministic ingestion continues). */
const degradingAi: ReasoningAi = {
  async run(task) {
    if (task.prompt === 'security-research-planner') return aiResult('provider-unavailable', null)
    return confirmingAi.run(task)
  },
}

function research(ai: ReasoningAi | undefined) {
  return new ResearchService({ db, broker, ai, specialistEngines: { strix: new FakeSpecialistEngine({ vulnerabilities: [] }) }, graphProjector: projector, log: createLogger({ write: () => {} }) })
}

beforeAll(async () => {
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  resetConfig()
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  app = await buildApp({ db, boss, hub: null, log: createLogger({ write: () => {} }), security: service })
  fixture = await startIdentityFixture('research')
  projector = new GraphProjector({ db })
  broker = new CapabilityBroker({ registry, store: createDbSecurityStore(db), resolver: loopback, authResolver: new VaultAuthResolver({ db, vault }), checkResources: async () => ({ ok: true, rule: 'resources.ok', reason: 'ok', details: {} }) })
  establishment = new SessionEstablishmentService({ db, vault })
})
afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: false })
  await fixture.close()
  await handle.close()
  delete process.env.AUDIVRA_SECRET_KEY
  resetConfig()
})
beforeEach(async () => {
  await resetDb(handle)
  await pool.query('truncate security_engagements cascade')
  await boss.deleteAllJobs()
  for (const m of [fixture.tokens, fixture.sessions, fixture.principals, fixture.resources, fixture.users]) m.clear()
})

async function engagement(name: string): Promise<string> {
  const created = await service.createEngagement({ name, targetUrl: fixture.url, environment: 'isolated-lab' }, user)
  await service.requestAuthorization(created.id, { method: 'local-development' }, user)
  await identity(created.id, 'alice', 't1')
  await identity(created.id, 'bob', 't1')
  return created.id
}
async function identity(eid: string, ref: string, tenant: string): Promise<void> {
  const token = `rs-${ref}-${randomBytes(5).toString('hex')}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant, role: 'user' })
  await domain.declare(eid, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } }, user)
  await vault.setCredential(eid, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, user)
  const r = await establishment.establish(eid, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, user)
  expect((r as SessionEstablishmentResult).established).toBe(true)
}
async function resource(eid: string, id: string, enforce: 'leaky' | 'strict'): Promise<void> {
  fixture.resources.set(id, { tenant: 't1', owner: 'alice', state: 'draft', enforce })
  await domain.declare(eid, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: `${fixture.url}/api/resources/${id}`, testData: 'test-owned' } }, user)
}

describe('Phase 6E — autonomous research orchestration', () => {
  it('a healthy application stops with ZERO verified findings (never manufactured)', async () => {
    const eid = await engagement('rs-healthy')
    await resource(eid, 'hdoc', 'strict') // enforced → comparisons are consistent → no finding
    const svc = research(confirmingAi)
    const run = await svc.create(eid, { mode: 'investigate', objective: 'investigate-authorization', objectiveNote: null, objectiveDetail: {} })
    const done = await svc.drive(run.id)
    expect(['stopped', 'degraded']).toContain(done.state === 'degraded' ? 'degraded' : done.state)
    expect(done.terminationReason).toBeTruthy()
    expect(await listFindingsForEngagement(db, eid)).toHaveLength(0) // headline: zero false findings on a healthy app
  }, 120_000)

  it('finds an authorization issue via a cheap comparison → verification → finding, without the specialist', async () => {
    const eid = await engagement('rs-authz')
    await resource(eid, 'ldoc', 'leaky') // broken boundary
    const svc = research(confirmingAi)
    const run = await svc.create(eid, { mode: 'investigate', objective: 'investigate-authorization', objectiveNote: null, objectiveDetail: {} })
    const done = await svc.drive(run.id)
    const findings = await listFindingsForEngagement(db, eid)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    const actions = await listResearchActions(db, run.id)
    expect(actions.some((a) => a.kind === 'comparison' && a.state === 'completed')).toBe(true)
    expect(actions.some((a) => a.kind === 'verify' && a.state === 'completed')).toBe(true)
    expect(done.usage.specialistRuns).toBe(0) // cheaper capabilities sufficed — the expensive specialist was not run
    expect(done.state).toBe('stopped')
  }, 120_000)

  it('propose-only records proposals and executes nothing', async () => {
    const eid = await engagement('rs-propose')
    await resource(eid, 'ldoc', 'leaky')
    const svc = research(confirmingAi)
    const run = await svc.create(eid, { mode: 'propose-only', objective: 'investigate-authorization', objectiveNote: null, objectiveDetail: {} })
    const done = await svc.drive(run.id)
    expect(done.terminationReason).toBe('objective-satisfied')
    expect(done.usage.actions).toBe(0) // nothing executed
    expect(await listFindingsForEngagement(db, eid)).toHaveLength(0)
    const actions = await listResearchActions(db, run.id)
    expect(actions.some((a) => a.state === 'policy-allowed' || a.state === 'proposed')).toBe(true)
  }, 120_000)

  it('degrades honestly when the AI provider is unavailable (deterministic work continues)', async () => {
    const eid = await engagement('rs-degrade')
    await resource(eid, 'ldoc', 'leaky')
    const svc = research(degradingAi)
    const run = await svc.create(eid, { mode: 'investigate', objective: 'investigate-authorization', objectiveNote: null, objectiveDetail: {} })
    const done = await svc.drive(run.id)
    expect(done.providerAvailable).toBe(false)
    expect(done.terminationReason).not.toBe('ai-unavailable') // it did not falsely complete nor crash
    expect(await listFindingsForEngagement(db, eid)).not.toHaveLength(0) // deterministic verification still produced a finding
  }, 120_000)

  it('rejects adversarial AI proposals (duplicate / invented ref / unjustified specialist)', async () => {
    const eid = await engagement('rs-adversarial')
    await resource(eid, 'ldoc', 'leaky')
    const adversarialAi: ReasoningAi = {
      async run(task) {
        if (task.prompt === 'security-research-planner')
          return aiResult('succeeded', {
            proposals: [
              { kind: 'specialist', objectiveRef: null, resourceRef: null, findingId: null, priority: 'high', reason: 'run the big tool to be safe' },
              { kind: 'comparison', objectiveRef: 'ghost', resourceRef: 'ghost', findingId: null, priority: 'high', reason: 'compare an invented resource' },
              { kind: 'retest', objectiveRef: 'fnd_doesnotexist0', resourceRef: null, findingId: 'fnd_doesnotexist0', priority: 'high', reason: 'retest a non-existent finding' },
            ],
            note: '',
          })
        return confirmingAi.run(task)
      },
    }
    const svc = research(adversarialAi)
    const run = await svc.create(eid, { mode: 'investigate', objective: 'investigate-authorization', objectiveNote: null, objectiveDetail: {} })
    await svc.drive(run.id)
    const actions = await listResearchActions(db, run.id)
    const rejected = actions.filter((a) => a.state === 'rejected')
    expect(rejected.some((a) => a.kind === 'specialist' && (a.rejection === 'too-expensive' || a.rejection === 'specialist-unavailable' || a.rejection === 'not-eligible'))).toBe(true)
    expect(rejected.some((a) => a.origin === 'ai-proposed' && (a.rejection === 'reference-missing' || a.rejection === 'input-invalid'))).toBe(true)
    expect(actions.every((a) => a.kind !== 'specialist' || a.state !== 'completed')).toBe(true) // the unjustified specialist never ran
  }, 120_000)

  it('is idempotent: re-driving a finished run changes nothing', async () => {
    const eid = await engagement('rs-idem')
    await resource(eid, 'ldoc', 'leaky')
    const svc = research(confirmingAi)
    const run = await svc.create(eid, { mode: 'investigate', objective: 'investigate-authorization', objectiveNote: null, objectiveDetail: {} })
    const first = await svc.drive(run.id)
    const findingsAfter = (await listFindingsForEngagement(db, eid)).length
    const again = await svc.drive(run.id)
    expect(again.state).toBe(first.state)
    expect(again.terminationReason).toBe(first.terminationReason)
    expect((await listFindingsForEngagement(db, eid)).length).toBe(findingsAfter)
  }, 120_000)
})
