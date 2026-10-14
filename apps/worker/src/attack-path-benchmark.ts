import type { Server } from 'node:http'
import type { Logger } from '@audivra/config'
import type { AiTaskOutcome, ComparisonPlanInput, SecurityActor, SecurityFinding, SecurityGraphEdge, SecurityGraphNode } from '@audivra/contracts'
import { listFindingsForEngagement, type Db } from '@audivra/database'
import {
  AttackPathReadService,
  AttackPathService,
  buildAiChain,
  CapabilityBroker,
  ComparisonEngine,
  createDbSecurityStore,
  createRuntimeRegistry,
  createSecretVault,
  DomainService,
  GraphProjector,
  pathVerdict,
  SecurityService,
  SessionEstablishmentService,
  VaultAuthResolver,
  VerificationService,
  type AttackPathView,
  type ReasoningAi,
  type ReasoningAiResult,
  type Resolver,
} from '@audivra/security'

/*
 * Phase 6B — the attack-path benchmark. A controlled multi-tenant fixture with a KNOWN ground truth over
 * which Audivra verifies findings and analyses paths. It measures the quality of the PATHS: precision/recall
 * against the true routes, zero false paths (a tempting but unconnected correlation is never verified), the
 * unsupported edge rate (a missing connector is labelled, never passed), dedupe/dominance (no trivial
 * variations), correct contradiction handling (a contradicted step rejects a path), bounded search
 * expansions, and no path on a healthy boundary. No Docker; verification uses a scripted confirming AI so
 * findings (and therefore verified paths) are produced deterministically.
 */

function aiResult(outcome: AiTaskOutcome['outcome'], output: unknown): ReasoningAiResult {
  return { outcome, output, selection: { taskType: 'security-verify-claim', providerId: 'bench', model: null, reason: 'bench', considered: [], at: new Date().toISOString() }, provenance: [], attempts: 1, refused: false, promptVersion: null }
}
const CONFIRMING_AI: ReasoningAi = {
  run: async (task) => {
    if (task.prompt === 'security-finding-verifier') return aiResult('succeeded', { verdict: 'confirm', rationale: 'confirmed by controls', citedEvidenceRefs: [], alternativeExplanation: null, missingEvidence: null, proposedAction: null })
    if (task.prompt === 'security-finding-prose') return aiResult('succeeded', { title: 'Broken authorization boundary', impact: 'Cross-boundary access.', remediation: 'Enforce the boundary.', severityExplanation: '' })
    return aiResult('succeeded', { verdict: 'ok', note: '', suggestedSeverity: null })
  },
}
/** An attack-path proposer scripted to return given proposals (used to measure false/missing-edge handling). */
function proposingAi(proposals: { title: string; findingIds: string[]; connectingEntityKeys: string[]; impactClass: string; rationale: string }[]): ReasoningAi {
  return {
    run: async (task) => {
      if (task.prompt === 'security-attack-path-proposer') return aiResult('succeeded', { proposals })
      if (task.prompt === 'security-attack-path-explainer') return aiResult('succeeded', { title: 'Attack path', explanation: 'A structured route over stored evidence.' })
      return aiResult('succeeded', {})
    },
  }
}

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
export interface AttackPathBenchmarkResult {
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
const bool = (value: boolean, detail: string): BenchmarkMetric => ({ value: value ? 1 : 0, target: '= 1', pass: value, detail })

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
  return mod.startIdentityFixture({ port: 0, label: 'attack-path-bench' })
}

export async function runAttackPathBenchmark(options: { db: Db; log?: Logger }): Promise<AttackPathBenchmarkResult> {
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

  const mkIdentity = async (e: string, ref: string, tenant: string) => {
    const token = `apb-${ref}-${Math.random().toString(36).slice(2, 10)}`
    fixture.tokens.set(token, ref)
    fixture.principals.set(ref, { tenant, role: 'user' })
    await domain.declare(e, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: tenant } }, USER)
    await vault.setCredential(e, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, USER)
    await establishment.establish(e, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, USER)
  }
  const arm = (role: 'subject' | 'positive-control' | 'negative-control', identityRef: string | null, resourceRef: string, url: string, outcome: 'allow' | 'deny') => ({ role, identityRef, resourceRef, url, method: 'GET' as const, expected: { outcome, basis: outcome === 'allow' ? ('observed' as const) : ('declared' as const), invariantRef: null, sourceRef: null, rationale: '' } })
  const brokenFor = async (e: string, subject: string, tenant: string, id: string, dimension: 'object-boundary' | 'tenant-boundary', enforce: 'strict' | 'leaky') => {
    fixture.resources.set(id, { tenant: 't1', owner: 'alice', state: 'draft', enforce })
    const url = `${fixture.url}/api/resources/${id}`
    await domain.declare(e, { kind: 'resource', ref: id, spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: url, testData: 'test-owned' } }, USER)
    return engine.planAndRun(e, { dimension, resourceRef: id, action: 'read', arms: [arm('subject', subject, id, url, 'deny'), arm('positive-control', 'alice', id, url, 'allow'), arm('negative-control', null, id, url, 'deny')] } as ComparisonPlanInput, USER)
  }

  const scenarios: ScenarioResult[] = []
  try {
    // ── Scenario 1: precision / recall / dedupe / dominance / expansions / healthy-zero (full DB). ──
    {
      const s0 = Date.now()
      const e = await service.createEngagement({ name: `apb-main-${Math.random().toString(36).slice(2, 6)}`, targetUrl: fixture.url, environment: 'isolated-lab' }, USER)
      await service.requestAuthorization(e.id, { method: 'local-development' }, USER)
      await mkIdentity(e.id, 'alice', 't1')
      await mkIdentity(e.id, 'bob', 't1')
      await brokenFor(e.id, 'bob', 't1', 'doc1', 'object-boundary', 'leaky')
      await brokenFor(e.id, 'bob', 't1', 'doc2', 'object-boundary', 'leaky')
      await brokenFor(e.id, 'bob', 't1', 'doc3', 'object-boundary', 'strict') // enforced → no finding → no path
      await new VerificationService({ db, registry, ai: CONFIRMING_AI, graphProjector: projector }).drive(e.id)

      const svc = new AttackPathService({ db })
      const result = await svc.drive(e.id)
      const second = await svc.drive(e.id)

      const read = new AttackPathReadService({ db })
      const all = await read.listPaths(e.id, { includeDominated: true })
      const primary = await read.listPaths(e.id)
      const chain = all.find((p) => p.findingIds.length === 2)
      const verifiedChain = chain && chain.state === 'verified'
      scenarios.push({
        name: 'precision-recall-dedupe',
        description: 'Two broken boundaries for one principal yield a verified correlation path plus verified single-finding paths; an enforced boundary yields none; dominated subpaths are related; a re-run adds nothing.',
        metrics: {
          recall: bool(!!chain, 'the true multi-finding path was discovered'),
          verifiedChain: bool(!!verifiedChain, 'the multi-finding path is verified (every step verified)'),
          singleFindingPaths: atLeast(all.filter((p) => p.findingIds.length === 1).length, 2, 'both single-finding impact paths discovered'),
          falsePositive: eq(all.filter((p) => p.findingIds.length === 1 && p.affectedEntityKeys.some((k) => k.includes('doc3'))).length, 0, 'no path for the enforced boundary'),
          dedupe: eq(second.pathsCreated, 0, 'a repeated analysis created no duplicate paths'),
          dominance: bool(primary.length < all.length && primary.every((p) => !p.dominatedBy), 'dominated subpaths are hidden from the primary list but kept'),
          boundedSearch: atMost(result.expansions, 2000, `search expansions bounded (${result.expansions})`),
          termination: bool(result.terminationReason === 'complete', 'search terminated completely, not by a limit'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // ── Scenario 2: a tempting but false correlation (different principals, no connector) → speculative. ──
    {
      const s0 = Date.now()
      const e = await service.createEngagement({ name: `apb-false-${Math.random().toString(36).slice(2, 6)}`, targetUrl: fixture.url, environment: 'isolated-lab' }, USER)
      await service.requestAuthorization(e.id, { method: 'local-development' }, USER)
      await mkIdentity(e.id, 'alice', 't1')
      await mkIdentity(e.id, 'bob', 't1')
      await mkIdentity(e.id, 'carol', 't2')
      await brokenFor(e.id, 'bob', 't1', 'fdoc1', 'object-boundary', 'leaky')
      await brokenFor(e.id, 'carol', 't2', 'fdoc2', 'tenant-boundary', 'leaky')
      await new VerificationService({ db, registry, ai: CONFIRMING_AI, graphProjector: projector }).drive(e.id)
      const findings = await listFindingsForEngagement(db, e.id)
      const bob = findings.find((f) => f.affectedEntities.some((a) => a.key === 'identity:bob'))!
      const carol = findings.find((f) => f.affectedEntities.some((a) => a.key === 'identity:carol'))!

      const proposer = proposingAi([{ title: 'tempting chain', findingIds: [bob.id, carol.id], connectingEntityKeys: [], impactClass: 'privilege-boundary-crossed', rationale: 'two unrelated findings the model wants to connect' }])
      await new AttackPathService({ db, ai: proposer }).drive(e.id)
      const read = new AttackPathReadService({ db })
      const all = await read.listPaths(e.id, { includeDominated: true })
      const falseChain = all.find((p) => p.findingIds.length === 2 && p.findingIds.includes(bob.id) && p.findingIds.includes(carol.id))
      scenarios.push({
        name: 'false-and-missing-edge',
        description: 'An AI proposal connecting two unrelated findings with no graph connector is kept as a speculative path with an explicit missing edge — never verified.',
        metrics: {
          present: bool(!!falseChain, 'the proposed correlation was evaluated, not silently dropped'),
          notVerified: bool(!!falseChain && falseChain.state !== 'verified', 'the false chain is NOT verified'),
          speculative: bool(!!falseChain && falseChain.state === 'speculative', 'the false chain is classified speculative'),
          missingEdge: bool(!!falseChain && falseChain.missingEvidence.length > 0, 'the missing connector is an explicit evidence gap'),
          falsePathRate: eq(all.filter((p) => p.state === 'verified' && p.findingIds.length === 2 && p.findingIds.includes(carol.id)).length, 0, 'no verified false multi-finding path'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    // ── Scenario 3: contradiction handling (controlled graph with a contradicted bridge). ──
    {
      const s0 = Date.now()
      const verdict = contradictionScenario()
      scenarios.push({
        name: 'contradiction-handling',
        description: 'A proposed chain whose only bridge is a contradicted graph edge is rejected (never verified or dropped).',
        metrics: {
          contradictedStep: bool(verdict.hasContradicted, 'the bridging step is labelled contradicted'),
          rejected: bool(verdict.state === 'rejected', 'the path is rejected'),
        },
        pass: false,
        durationMs: Date.now() - s0,
      })
    }

    for (const s of scenarios) s.pass = Object.values(s.metrics).every((m) => m.pass)
    const summary: Record<string, BenchmarkMetric> = {
      scenarios: eq(scenarios.filter((s) => s.pass).length, scenarios.length, `${scenarios.filter((s) => s.pass).length}/${scenarios.length} scenarios passed`),
      failingMetrics: atMost(scenarios.flatMap((s) => Object.values(s.metrics)).filter((m) => !m.pass).length, 0, 'no failing metric'),
    }
    return { startedAt, durationMs: Date.now() - t0, scenarios, summary, pass: scenarios.every((s) => s.pass) }
  } finally {
    await fixture.close()
  }
}

/** A controlled synthetic view: two findings bridged only by a CONTRADICTED edge → a rejected path. */
function contradictionScenario(): { hasContradicted: boolean; state: string } {
  const T = new Date().toISOString()
  const node = (kind: SecurityGraphNode['kind'], key: string): SecurityGraphNode => ({ id: `gn_${key}`, engagementId: 'e', kind, key, label: key, attributes: {}, scopeClass: 'in-scope', basis: 'declared', confidence: 1, corroboration: 1, tools: [], status: 'active', statusReason: null, conflicts: [], firstObservedAt: T, lastObservedAt: T, firstExecutionId: null, lastExecutionId: null, updatedAt: T })
  const finding = (id: string, identity: string, resource: string): SecurityFinding => ({
    id, engagementId: 'e', issueKey: id, title: `Finding ${id}`, category: 'authorization', severity: 'high', severityReason: '', confidence: 0.8, verificationState: 'verified', status: 'verified',
    affectedEntities: [{ key: `identity:${identity}`, kind: 'identity', label: identity }, { key: `resource:document:${resource}`, kind: 'resource', label: resource }],
    claim: '', evidenceRefs: [], contradictingEvidenceRefs: [], impact: '', remediation: '', reproduction: null,
    severityInputs: { category: 'authorization', scopeClass: 'in-scope', privilegeBoundaryCrossed: false, tenantBoundaryCrossed: false, dataSensitivity: 'unknown', exploitPrerequisites: 'authenticated', confidence: 0.8, environment: 'isolated-lab' },
    confidenceFactors: { directObservation: true, independentCorroboration: true, positiveControl: true, negativeControl: true, deterministicReproduction: true, contradictoryEvidence: false, aiInferenceDependency: false },
    candidateIds: [], hypothesisIds: [], comparisonIds: [], invariantRefs: [], reviewed: false, reviewNote: null, history: [], createdAt: T, updatedAt: T,
  })
  const a = finding('F_A', 'bob', 'd1')
  const b = finding('F_B', 'carol', 'd2')
  const contradicted: SecurityGraphEdge = { id: 'ge_c', engagementId: 'e', key: 'CAN_ACCESS|resource:document:d1|resource:document:d2', type: 'CAN_ACCESS', fromId: 'gn_r1', toId: 'gn_r2', fromKey: 'resource:document:d1', toKey: 'resource:document:d2', attributes: {}, basis: 'inferred', confidence: 0.4, corroboration: 0, tools: [], status: 'contradicted', statusReason: 'conflict', conflicts: [{ reason: 'conflicting evidence', withEdgeKey: null } as never], firstObservedAt: T, lastObservedAt: T, firstExecutionId: null, lastExecutionId: null, updatedAt: T }
  const nodes = [node('identity', 'identity:bob'), node('identity', 'identity:carol'), node('resource', 'resource:document:d1'), node('resource', 'resource:document:d2')]
  const view: AttackPathView = { engagementId: 'e', environment: 'isolated-lab', findings: [a, b], nodesByKey: new Map(nodes.map((n) => [n.key, n])), edges: [contradicted], edgesByFrom: new Map([['resource:document:d1', [contradicted]]]) }
  const chain = buildAiChain([a, b], ['resource:document:d1', 'resource:document:d2'], view)
  const hasContradicted = chain.steps.some((s) => s.edgeVerification === 'contradicted')
  return { hasContradicted, state: pathVerdict(chain.steps).state }
}
