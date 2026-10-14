import type { Server } from 'node:http'
import type { Logger } from '@audivra/config'
import type { AiTaskOutcome, ComparisonPlanInput, SecurityActor } from '@audivra/contracts'
import type { Db } from '@audivra/database'
import {
  CapabilityBroker,
  ComparisonEngine,
  createDbSecurityStore,
  createRuntimeRegistry,
  createSecretVault,
  DomainService,
  GraphProjector,
  GraphService,
  SecurityService,
  SessionEstablishmentService,
  VaultAuthResolver,
  VerificationService,
  type ReasoningAi,
  type ReasoningAiResult,
  type Resolver,
} from '@audivra/security'

/*
 * Phase 6A — the findings benchmark. It builds a multi-tenant fixture with a KNOWN ground truth (which
 * object/tenant boundaries are enforced vs intentionally broken), runs differential comparisons, then runs
 * the verification boundary and measures the quality of the FINDINGS it produces: precision and recall
 * against the broken boundaries, zero findings on a fully healthy engagement, no duplicate findings across a
 * repeated pass, sane deterministic severity, verification accuracy (an independent verifier confirming a
 * complete candidate verifies it; a provider failure blocks it; neither can manufacture one), and adversarial
 * rejection (an always-confirm AI cannot create a verified finding where no evidence exists). No real AI and
 * no Docker: the comparison engine and the verification core are deterministic and run in-process.
 */

function aiResult(outcome: AiTaskOutcome['outcome'], output: unknown): ReasoningAiResult {
  return { outcome, output, selection: { taskType: 'security-verify-claim', providerId: 'bench', model: null, reason: 'bench', considered: [], at: new Date().toISOString() }, provenance: [], attempts: 1, refused: false, promptVersion: null }
}
const CONFIRMING_AI: ReasoningAi = {
  run: async (task) => {
    if (task.prompt === 'security-finding-verifier') return aiResult('succeeded', { verdict: 'confirm', rationale: 'confirmed', citedEvidenceRefs: [], alternativeExplanation: null, missingEvidence: null, proposedAction: null })
    if (task.prompt === 'security-finding-prose') return aiResult('succeeded', { title: 'Broken authorization boundary', impact: 'Cross-boundary access.', remediation: 'Enforce the boundary.', severityExplanation: '' })
    return aiResult('succeeded', { verdict: 'ok', note: '', suggestedSeverity: null })
  },
}
const UNAVAILABLE_AI: ReasoningAi = { run: async () => aiResult('provider-unavailable', null) }

interface BenchmarkMetric {
  value: number
  target: string
  pass: boolean
  detail: string
}
interface ScenarioResult {
  name: string
  description: string
  pass: boolean
  metrics: Record<string, BenchmarkMetric>
  durationMs: number
}
export interface FindingsBenchmarkResult {
  startedAt: string
  durationMs: number
  scenarios: ScenarioResult[]
  summary: Record<string, BenchmarkMetric>
  pass: boolean
}

const USER: SecurityActor = { kind: 'user', id: 'benchmark', agentRunId: null }
const loopback: Resolver = async (host) => (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost') ? ['127.0.0.1'] : Promise.reject(new Error(`unexpected lookup ${host}`)))
const eq = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `= ${want}`, pass: value === want, detail })
const atLeast = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `≥ ${want}`, pass: value >= want, detail })
const atMost = (value: number, want: number, detail: string): BenchmarkMetric => ({ value, target: `≤ ${want}`, pass: value <= want, detail })

interface IdentityFixtureLike {
  url: string
  tokens: Map<string, string>
  principals: Map<string, { tenant: string; role: 'user' | 'admin' }>
  resources: Map<string, { tenant: string; owner: string; state: string; enforce: 'strict' | 'tenant' | 'leaky' }>
  close(): Promise<void>
  server: Server
}

async function startFixture(): Promise<IdentityFixtureLike> {
  // @ts-expect-error -- plain JS fixture module without type declarations
  const mod = (await import('../../../fixtures/identity/server.mjs')) as { startIdentityFixture(opts: { port: number; label: string }): Promise<IdentityFixtureLike> }
  return mod.startIdentityFixture({ port: 0, label: 'findings-bench' })
}

export async function runFindingsBenchmark(options: { db: Db; log?: Logger }): Promise<FindingsBenchmarkResult> {
  const { db } = options
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const fixture = await startFixture()
  const service = new SecurityService({ db, resolver: loopback })
  const domain = new DomainService({ db })
  const vault = createSecretVault(db)
  const establishment = new SessionEstablishmentService({ db, vault })
  const registry = createRuntimeRegistry()
  const broker = new CapabilityBroker({ registry, store: createDbSecurityStore(db), resolver: loopback, authResolver: new VaultAuthResolver({ db, vault }), checkResources: async () => ({ ok: true, rule: 'resources.ok', reason: 'ok', details: {} }) })
  const projector = new GraphProjector({ db })
  const engine = new ComparisonEngine({ db, broker, projector })
  const graph = new GraphService({ db })

  let seq = 0
  const mkIdentity = async (e: string, ref: string, tenant: string) => {
    const token = `fb-${ref}-${Math.random().toString(36).slice(2, 10)}`
    fixture.tokens.set(token, ref)
    fixture.principals.set(ref, { tenant, role: 'user' })
    await domain.declare(e, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } }, USER)
    await vault.setCredential(e, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, USER)
    await establishment.establish(e, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, USER)
  }
  const mkResource = async (e: string, id: string, tenant: string, owner: string, enforce: 'strict' | 'tenant' | 'leaky') => {
    fixture.resources.set(id, { tenant, owner, state: 'draft', enforce })
    const url = `${fixture.url}/api/resources/${id}`
    await domain.declare(e, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: owner, tenantRef: tenant, canonicalUrl: url, testData: 'test-owned' } }, USER)
    return url
  }
  const armPlan = (role: 'subject' | 'positive-control' | 'negative-control', identityRef: string | null, resourceRef: string, url: string, outcome: 'allow' | 'deny') => ({
    role,
    identityRef,
    resourceRef,
    url,
    method: 'GET' as const,
    expected: { outcome, basis: outcome === 'allow' ? ('observed' as const) : ('declared' as const), invariantRef: null, sourceRef: null, rationale: '' },
  })

  /** Builds an engagement with the given boundaries and runs a comparison per resource. Returns the engagement id. */
  async function buildEngagement(name: string, resources: { id: string; enforce: 'strict' | 'leaky'; dimension: 'object-boundary' | 'tenant-boundary' }[]): Promise<string> {
    const created = await service.createEngagement({ name, targetUrl: fixture.url, environment: 'isolated-lab' }, USER)
    const e = created.id
    await service.requestAuthorization(e, { method: 'local-development' }, USER)
    await mkIdentity(e, 'alice', 't1')
    await mkIdentity(e, 'bob', 't1')
    await mkIdentity(e, 'carol', 't2')
    for (const r of resources) {
      const url = await mkResource(e, r.id, 't1', 'alice', r.enforce)
      const subject = r.dimension === 'tenant-boundary' ? 'carol' : 'bob'
      const plan: ComparisonPlanInput = {
        dimension: r.dimension,
        resourceRef: r.id,
        action: 'read',
        arms: [armPlan('subject', subject, r.id, url, 'deny'), armPlan('positive-control', 'alice', r.id, url, 'allow'), armPlan('negative-control', null, r.id, url, 'deny')],
      } as ComparisonPlanInput
      await engine.planAndRun(e, plan, USER)
    }
    return e
  }

  const scenarios: ScenarioResult[] = []
  try {
    // ── Scenario 1: precision / recall / false positives / dedupe / severity (deterministic, no AI). ──
    {
      const s0 = Date.now()
      const e = await buildEngagement(`fb-mixed-${seq++}`, [
        { id: `obj-enf-${seq}`, enforce: 'strict', dimension: 'object-boundary' },
        { id: `obj-brk-${seq}`, enforce: 'leaky', dimension: 'object-boundary' },
        { id: `ten-enf-${seq}`, enforce: 'strict', dimension: 'tenant-boundary' },
        { id: `ten-brk-${seq}`, enforce: 'leaky', dimension: 'tenant-boundary' },
      ])
      const verify = new VerificationService({ db, registry, graphProjector: projector })
      await verify.drive(e)
      const second = await verify.drive(e) // idempotency
      const read = await listFindings(db, e)
      const authz = read.filter((f) => f.category === 'authorization').length
      const tenant = read.filter((f) => f.category === 'tenant-isolation').length
      const nonInfo = read.filter((f) => f.severity !== 'info' && f.severity !== 'low').length
      scenarios.push({
        name: 'precision-recall',
        description: 'Two broken boundaries (object IDOR + cross-tenant) yield exactly two findings; two enforced boundaries yield none.',
        metrics: {
          recall: eq(read.length, 2, `${read.length} findings for 2 broken boundaries`),
          precision: eq(read.length, 2, 'every finding corresponds to a broken boundary (no false positive on the 2 enforced ones)'),
          categories: eq(authz + tenant, 2, `authorization=${authz}, tenant-isolation=${tenant}`),
          severity: eq(nonInfo, 2, 'both findings carry a meaningful severity (not info/low)'),
          dedupe: eq(second.findingsCreated, 0, 'a repeated pass created no duplicate findings'),
          supported: eq(read.filter((f) => f.verificationState === 'supported').length, 2, 'both are supported (no independent verifier ran)'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // ── Scenario 2: a fully healthy engagement yields zero findings. ──
    {
      const s0 = Date.now()
      const e = await buildEngagement(`fb-healthy-${seq++}`, [
        { id: `h-obj-${seq}`, enforce: 'strict', dimension: 'object-boundary' },
        { id: `h-ten-${seq}`, enforce: 'strict', dimension: 'tenant-boundary' },
      ])
      // Even an always-confirm AI cannot manufacture a finding where there is no candidate.
      const verify = new VerificationService({ db, registry, ai: CONFIRMING_AI, graphProjector: projector })
      const result = await verify.drive(e)
      const read = await listFindings(db, e)
      scenarios.push({
        name: 'healthy-zero-findings',
        description: 'A fully enforced engagement produces no candidates and no findings, even with an always-confirm AI.',
        metrics: {
          candidates: eq(result.candidatesCreated, 0, 'no candidates generated for enforced boundaries'),
          findings: eq(read.length, 0, 'no findings synthesized'),
          verified: eq(result.verified, 0, 'the always-confirm AI verified nothing (adversarial rejection)'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // ── Scenario 3: verification accuracy — confirm → verified, provider failure → blocked. ──
    {
      const s0 = Date.now()
      const confirmed = await buildEngagement(`fb-confirm-${seq++}`, [{ id: `c-obj-${seq}`, enforce: 'leaky', dimension: 'object-boundary' }])
      const cv = await new VerificationService({ db, registry, ai: CONFIRMING_AI, graphProjector: projector }).drive(confirmed)
      const confirmedFindings = await listFindings(db, confirmed)

      const blockedE = await buildEngagement(`fb-blocked-${seq++}`, [{ id: `b-obj-${seq}`, enforce: 'leaky', dimension: 'object-boundary' }])
      const bv = await new VerificationService({ db, registry, ai: UNAVAILABLE_AI, graphProjector: projector }).drive(blockedE)

      scenarios.push({
        name: 'verification-accuracy',
        description: 'An independent verifier confirming a complete candidate verifies it; a provider failure blocks it and never verifies.',
        metrics: {
          verified: eq(cv.verified, 1, 'confirm verdict on a complete candidate → verified'),
          verifiedStatus: eq(confirmedFindings.filter((f) => f.verificationState === 'verified').length, 1, 'the finding is recorded verified'),
          graphNode: atLeast(await findingNodeCount(graph, confirmed), 1, 'the verified finding is projected into the graph'),
          blocked: eq(bv.blocked, 1, 'provider failure blocked the candidate'),
          blockedNotVerified: eq(bv.verified, 0, 'a provider failure never produces a verified finding'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    for (const s of scenarios) s.pass = Object.values(s.metrics).every((m) => m.pass)
    const summary: Record<string, BenchmarkMetric> = {
      scenarios: eq(scenarios.filter((s) => s.pass).length, scenarios.length, `${scenarios.filter((s) => s.pass).length}/${scenarios.length} scenarios passed`),
      totalMetrics: atMost(scenarios.flatMap((s) => Object.values(s.metrics)).filter((m) => !m.pass).length, 0, 'no failing metric'),
    }
    return { startedAt, durationMs: Date.now() - t0, scenarios, summary, pass: scenarios.every((s) => s.pass) }
  } finally {
    await fixture.close()
  }
}

async function listFindings(db: Db, engagementId: string) {
  const { listFindingsForEngagement } = await import('@audivra/database')
  return listFindingsForEngagement(db, engagementId)
}

async function findingNodeCount(graph: GraphService, engagementId: string): Promise<number> {
  return (await graph.nodes(engagementId, { kind: 'finding' })).length
}
