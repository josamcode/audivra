import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dataDir, getLogger } from '@audivra/config'
import { getDb, runMigrations } from '@audivra/database'
import { getConfig } from '@audivra/config'
import {
  CapabilityBroker,
  createDbSecurityStore,
  createRuntimeRegistry,
  createSecretVault,
  createSecurityReportService,
  DomainService,
  FakeSpecialistEngine,
  generateSecurityReportExport,
  GraphProjector,
  ResearchService,
  SecurityService,
  SessionEstablishmentService,
  VaultAuthResolver,
  type Resolver,
} from '@audivra/security'

/*
 * Phase 6F — `pnpm demo`: a safe, no-internet demonstration. It spins up the bundled local identity fixture,
 * creates an authorized engagement in the dev database, declares two identities + a deliberately broken
 * object boundary, then runs an autonomous research run (comparison → verification → finding → attack path)
 * and writes the client HTML report. A new user can open the engagement in the UI to understand Audivra end
 * to end without targeting any real website. Uses the deterministic fake specialist and no AI provider.
 */

const log = getLogger()
const user = { kind: 'user' as const, id: 'demo', agentRunId: null }
const loopback: Resolver = async (host) => (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost') ? ['127.0.0.1'] : Promise.reject(new Error(`unexpected lookup ${host}`)))

await runMigrations(getConfig().DATABASE_URL)
const { db } = getDb()
const vault = createSecretVault(db)
const service = new SecurityService({ db, resolver: loopback })
const domain = new DomainService({ db })
const establishment = new SessionEstablishmentService({ db, vault })
const registry = createRuntimeRegistry()
const projector = new GraphProjector({ db })
const broker = new CapabilityBroker({ registry, store: createDbSecurityStore(db), resolver: loopback, authResolver: new VaultAuthResolver({ db, vault }) })

// @ts-expect-error -- plain JS fixture module without type declarations
const mod = (await import('../fixtures/identity/server.mjs')) as { startIdentityFixture(opts: { port: number; label: string }): Promise<{ url: string; tokens: Map<string, string>; principals: Map<string, unknown>; resources: Map<string, unknown>; close(): Promise<void> }> }
const fixture = await mod.startIdentityFixture({ port: 0, label: 'demo' })

async function identity(eid: string, ref: string) {
  const token = `demo-${ref}-${Math.random().toString(36).slice(2, 10)}`
  fixture.tokens.set(token, ref)
  fixture.principals.set(ref, { tenant: 't1', role: 'user' })
  await domain.declare(eid, { kind: 'identity', ref, spec: { identityType: 'user', authMethod: 'api-token', credentialRef: `${ref}-cred`, tenantRef: 't1' } }, user)
  await vault.setCredential(eid, { ref: `${ref}-cred`, identityRef: ref, secret: { type: 'bearer-token', token } }, user)
  await establishment.establish(eid, { identityRef: ref, flow: { type: 'api-token', placement: 'bearer', validateUrl: `${fixture.url}/me`, validStatuses: [200] } }, user)
}

try {
  console.log('\nAudivra demo — a safe local assessment (no external target)\n')
  const created = await service.createEngagement({ name: `Demo assessment ${new Date().toISOString().slice(0, 16)}`, targetUrl: fixture.url, environment: 'isolated-lab' }, user)
  const eid = created.id
  await service.requestAuthorization(eid, { method: 'local-development' }, user)
  await identity(eid, 'alice')
  await identity(eid, 'bob')
  fixture.resources.set('demo-doc', { tenant: 't1', owner: 'alice', state: 'draft', enforce: 'leaky' })
  await domain.declare(eid, { kind: 'resource', ref: 'demo-doc', spec: { resourceType: 'document', ownerRef: 'alice', tenantRef: 't1', canonicalUrl: `${fixture.url}/api/resources/demo-doc`, testData: 'test-owned' } }, user)
  console.log(`  ✓ Created engagement ${eid} against the local fixture (a broken object boundary)`)

  const research = new ResearchService({ db, broker, specialistEngines: { strix: new FakeSpecialistEngine({ vulnerabilities: [] }) }, graphProjector: projector })
  const run = await research.create(eid, { mode: 'investigate', objective: 'investigate-authorization', objectiveNote: null, objectiveDetail: {} })
  const done = await research.drive(run.id)
  console.log(`  ✓ Autonomous research run ${run.id} stopped: ${done.terminationReason} (${done.usage.actions} actions, ${done.usage.iterations} iterations)`)

  const report = await createSecurityReportService(db).build(eid)
  console.log(`  ✓ Report: ${report.findings.verifiedFindings.length} verified, ${report.findings.supportedSignals.length} supported finding(s); ${report.attackPaths.verifiedPaths.length + report.attackPaths.partiallyVerifiedPaths.length} attack path(s)`)

  const html = await generateSecurityReportExport(createSecurityReportService(db), eid, 'html')
  const out = path.join(dataDir(), 'demo')
  await mkdir(out, { recursive: true })
  const file = path.join(out, `${eid}.html`)
  await writeFile(file, html.body, 'utf8')
  console.log(`\n  Report written: ${file}`)
  console.log(`  Open the engagement in the UI:  /security/${eid}   (run \`pnpm dev\`)\n`)
} finally {
  await fixture.close()
  log.debug('demo complete')
}
process.exit(0)
