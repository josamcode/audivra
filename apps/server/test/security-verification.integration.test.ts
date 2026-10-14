import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, resetConfig } from '@audivra/config'
import type { AiTaskOutcome, SecurityAssessmentReport, SecurityFinding, SecurityVerificationCandidate, VerificationCoverage } from '@audivra/contracts'
import { createBoss, ensureQueues, type PgBoss } from '@audivra/database'
import {
  ComparisonEngine,
  createDurableBroker,
  createRuntimeRegistry,
  DomainService,
  GraphProjector,
  GraphService,
  keyringFromKeys,
  SecretVault,
  SecurityService,
  SessionEstablishmentService,
  VerificationService,
  type ReasoningAi,
  type ReasoningAiResult,
  type Resolver,
} from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, startIdentityFixture, testDb, type IdentityFixture } from '../../../test/helpers.ts'

/*
 * Phase 6A end to end on the real database + identity fixture: a broken authorization boundary becomes an
 * inconsistent differential comparison, the verification boundary generates a candidate, AUDIVRA decides
 * deterministically that its machine-checkable evidence exists, and a Security Finding is synthesized and
 * projected into the graph. A healthy boundary yields zero findings; an adversarial AI that always
 * "confirms" cannot upgrade weak evidence and a provider failure blocks a candidate (never verifies it);
 * the pass is idempotent across restarts; and the read API/report/exports are built only from stored state.
 */

const KEY = randomBytes(32)
const handle = testDb()
const { db, pool } = handle
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const loopback: Resolver = async (host) => (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost') ? ['127.0.0.1'] : Promise.reject(new Error(`unexpected lookup ${host}`)))
const service = new SecurityService({ db, resolver: loopback })
const domain = new DomainService({ db })
const vault = new SecretVault({ db, keyring: keyringFromKeys([{ key: KEY }]) })
const graph = new GraphService({ db })
const registry = createRuntimeRegistry()

let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>
let fixture: IdentityFixture
let engine: ComparisonEngine
let establishment: SessionEstablishmentService
let projector: GraphProjector

function aiResult(outcome: AiTaskOutcome['outcome'], output: unknown): ReasoningAiResult {
  return { outcome, output, selection: { taskType: 'security-verify-claim', providerId: 'fake', model: 'm', reason: 'test', considered: [], at: new Date().toISOString() }, provenance: [], attempts: 1, refused: false, promptVersion: 'v1' }
}

/** A deliberately credulous verifier that always confirms; proves AUDIVRA never lets the AI fabricate. */
function confirmingAi(): ReasoningAi {
  return {
    async run(task) {
      if (task.prompt === 'security-finding-verifier') return aiResult('succeeded', { verdict: 'confirm', rationale: 'looks real to me', citedEvidenceRefs: [], alternativeExplanation: null, missingEvidence: null, proposedAction: null })
      if (task.prompt === 'security-finding-prose') return aiResult('succeeded', { title: 'Broken object authorization', impact: 'A user reads another user document.', remediation: 'Enforce ownership on read.', severityExplanation: '' })
      if (task.prompt === 'security-finding-reviewer') return aiResult('succeeded', { verdict: 'ok', note: '', suggestedSeverity: null })
      return aiResult('succeeded', {})
    },
  }
}

/** A verifier whose provider is always down; a candidate must then be blocked, never verified. */
function failingAi(): ReasoningAi {
  return { async run() { return aiResult('provider-unavailable', null) } }
}

beforeAll(async () => {
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  resetConfig()
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  app = await buildApp({ db, boss, hub: null, log: createLogger({ write: () => {} }), security: service })
  fixture = await startIdentityFixture('verify')
  projector = new GraphProjector({ db })
  const broker = createDurableBroker({ db, boss, resolver: loopback })
  engine = new ComparisonEngine({ db, broker, projector })
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
  fixture.requests.length = 0
  for (const m of [fixture.tokens, fixture.sessions, fixture.principals, fixture.resources, fixture.users]) m.clear()
})

async function engagement(name: string): Promise<string> {
  const created = await service.createEngagement({ name, targetUrl: fixture.url, environment: 'isolated-lab' }, user)
  await service.requestAuthorization(created.id, { method: 'local-development' }, user)
  return created.id
}
async function identity(e: string, ref: string, tenant: string): Promise<void> {
  const token = `v-${ref}-${randomBytes(5).toString('hex')}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant, role: 'user' })
  await domain.declare(e, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } }, user)
  await vault.setCredential(e, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, user)
  const r = await establishment.establish(e, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, user)
  expect(r.established).toBe(true)
}
async function resource(e: string, id: string, owner: string, tenant: string, enforce: 'strict' | 'leaky'): Promise<string> {
  fixture.resources.set(id, { tenant, owner, state: 'draft', enforce })
  const url = `${fixture.url}/api/resources/${id}`
  await domain.declare(e, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: owner, tenantRef: tenant, canonicalUrl: url, testData: 'test-owned' } }, user)
  return url
}
const arm = (role: string, identityRef: string | null, resourceRef: string, url: string, outcome: string) => ({ role, identityRef, resourceRef, url, method: 'GET', expected: { outcome, basis: outcome === 'allow' ? 'observed' : 'declared', rationale: role } })

async function brokenBoundary(e: string, withNegativeControl = true) {
  await identity(e, 'alice', 't1')
  await identity(e, 'bob', 't1')
  const url = await resource(e, 'doc1', 'alice', 't1', 'leaky')
  const arms = [arm('subject', 'bob', 'doc1', url, 'deny'), arm('positive-control', 'alice', 'doc1', url, 'allow'), ...(withNegativeControl ? [arm('negative-control', null, 'doc1', url, 'deny')] : [])]
  const result = await engine.planAndRun(e, { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', arms }, user)
  expect(result.result).toBe('inconsistent')
}

async function api<T = unknown>(method: 'GET' | 'POST', url: string): Promise<{ status: number; body: T; text: string }> {
  const response = await app.inject({ method, url })
  return { status: response.statusCode, body: (response.headers['content-type']?.includes('json') ? response.json() : null) as T, text: response.body }
}

describe('Phase 6A — verification and evidence-backed findings', () => {
  it('synthesizes a supported finding (no AI) from an inconsistent comparison and projects it into the graph', async () => {
    const e = await engagement('verify-supported')
    await brokenBoundary(e)
    const verification = new VerificationService({ db, registry, graphProjector: projector })
    const result = await verification.drive(e)

    expect(result.candidatesCreated).toBe(1)
    expect(result.findingsCreated).toBe(1)
    // No independent verifier ran → the strongest honest verdict is `supported`, never `verified`.
    expect(result.verified).toBe(0)
    expect(result.supported).toBe(1)

    const findings = (await api<SecurityFinding[]>('GET', `/api/security/engagements/${e}/findings`)).body
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ category: 'authorization', verificationState: 'supported', status: 'open' })
    expect(findings[0]!.reproduction?.arms.length).toBeGreaterThanOrEqual(2)

    // The finding is in the graph as a finding node with an edge to an affected entity.
    const nodes = await graph.nodes(e, { kind: 'finding' })
    expect(nodes).toHaveLength(1)
    const edges = await graph.edges(e, { type: 'FINDING_AFFECTS' })
    expect(edges.length).toBeGreaterThanOrEqual(1)
  })

  it('a healthy boundary yields zero findings', async () => {
    const e = await engagement('verify-healthy')
    await identity(e, 'alice', 't1')
    await identity(e, 'bob', 't1')
    const url = await resource(e, 'doc1', 'alice', 't1', 'strict')
    const result = await engine.planAndRun(e, { dimension: 'object-boundary', resourceRef: 'doc1', action: 'read', arms: [arm('subject', 'bob', 'doc1', url, 'deny'), arm('positive-control', 'alice', 'doc1', url, 'allow'), arm('negative-control', null, 'doc1', url, 'deny')] }, user)
    expect(result.result).toBe('consistent')

    const verification = new VerificationService({ db, registry, graphProjector: projector })
    const outcome = await verification.drive(e)
    expect(outcome.candidatesCreated).toBe(0)
    expect(outcome.findingsCreated).toBe(0)
    expect((await api<SecurityFinding[]>('GET', `/api/security/engagements/${e}/findings`)).body).toHaveLength(0)
  })

  it('an independent verifier confirming a complete candidate yields a verified finding', async () => {
    const e = await engagement('verify-confirmed')
    await brokenBoundary(e)
    const verification = new VerificationService({ db, registry, ai: confirmingAi(), graphProjector: projector })
    const result = await verification.drive(e)
    expect(result.verified).toBe(1)
    const findings = (await api<SecurityFinding[]>('GET', `/api/security/engagements/${e}/findings`)).body
    expect(findings[0]).toMatchObject({ verificationState: 'verified', status: 'verified' })
    expect(findings[0]!.title).toBe('Broken object authorization') // AI prose, fact-checked
  })

  it('an always-confirm AI CANNOT upgrade a partial candidate (missing negative control) past supported', async () => {
    const e = await engagement('verify-adversarial')
    await brokenBoundary(e, false) // no negative control → a required check is unmet
    const verification = new VerificationService({ db, registry, ai: confirmingAi(), graphProjector: projector })
    const result = await verification.drive(e)
    expect(result.verified).toBe(0)
    expect(result.supported).toBe(1)
  })

  it('a provider failure blocks a candidate — it is never verified', async () => {
    const e = await engagement('verify-blocked')
    await brokenBoundary(e)
    const verification = new VerificationService({ db, registry, ai: failingAi(), graphProjector: projector })
    const result = await verification.drive(e)
    expect(result.verified).toBe(0)
    expect(result.blocked).toBe(1)
    const candidates = (await api<SecurityVerificationCandidate[]>('GET', `/api/security/engagements/${e}/findings/candidates`)).body
    expect(candidates[0]!.status).toBe('blocked')
  })

  it('is idempotent: a second pass advances the same issue, never duplicating', async () => {
    const e = await engagement('verify-idempotent')
    await brokenBoundary(e)
    const verification = new VerificationService({ db, registry, graphProjector: projector })
    await verification.drive(e)
    const second = await verification.drive(e)
    expect(second.candidatesCreated).toBe(0)
    expect(second.findingsCreated).toBe(0)
    expect((await api<SecurityFinding[]>('GET', `/api/security/engagements/${e}/findings`)).body).toHaveLength(1)
  })

  it('serves the report and exports (JSON/CSV) from persisted state', async () => {
    const e = await engagement('verify-report')
    await brokenBoundary(e)
    await new VerificationService({ db, registry, graphProjector: projector }).drive(e)

    const report = (await api<SecurityAssessmentReport>('GET', `/api/security/engagements/${e}/findings/report`)).body
    expect(report.supportedSignals).toHaveLength(1)
    expect(report.verifiedFindings).toHaveLength(0)

    const coverage = (await api<VerificationCoverage>('GET', `/api/security/engagements/${e}/findings/coverage`)).body
    expect(coverage.findings.total).toBe(1)
    expect(coverage.candidates.total).toBe(1)

    const json = await api('GET', `/api/security/engagements/${e}/findings/export/json`)
    expect(json.status).toBe(200)
    expect(JSON.parse(json.text).schemaVersion).toBe('audivra.security-findings.v1')
    const csv = await api('GET', `/api/security/engagements/${e}/findings/export/csv-findings`)
    expect(csv.status).toBe(200)
    expect(csv.text.split('\n')[0]).toContain('issueKey,title,category,severity')
  })
})
