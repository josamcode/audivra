import { describe, expect, it } from 'vitest'
import { ScopeManifest, type ScopeManifestInput, type SecurityAuthorizationItem, type SecurityCapabilityMetadata, type SecurityEnvironment } from '@audivra/contracts'
import {
  applyLifecycleAction,
  authorizationGaps,
  authorizationMethods,
  derivedStatus,
  effectiveAuthorizationStatus,
  effectivePolicy,
  evaluateAuthorizationCoverage,
  evaluateCapabilityPolicy,
  evaluateReadiness,
  localDevelopmentProvider,
  type Resolver,
} from '../src/index.ts'

const NOW = new Date('2026-10-08T12:00:00Z')
const scope = (input: ScopeManifestInput = {}) => ScopeManifest.parse({ hosts: [{ host: '127.0.0.1', ports: [4321] }], protocols: ['http'], ...input })
const policyFor = (environment: SecurityEnvironment | null, input: ScopeManifestInput = {}, profile = 'standard', version = 1) =>
  effectivePolicy({ environment, policyProfileKey: profile, policyProfileVersion: version, scope: scope(input) })

const capability = (patch: Partial<SecurityCapabilityMetadata> = {}): SecurityCapabilityMetadata => ({
  id: 'test.capability',
  version: 1,
  family: 'discovery',
  name: 'Test capability',
  description: 'A capability used by tests only.',
  riskClass: 'passive',
  sideEffect: 'read-only',
  supportedEnvironments: ['production', 'staging', 'isolated-lab'],
  requiresAuthorization: true,
  requiresIdentity: false,
  requiresNetwork: false,
  requiresExternalIntegration: false,
  supportsCancellation: true,
  rateLimitClass: 'light',
  resourceProfile: { disk: 'none', containerImage: null, spawnsProcesses: false },
  timeoutProfile: { defaultSeconds: 10, maxSeconds: 30 },
  evidenceTypes: [],
  implementation: 'test/capability@1',
  ...patch,
})

const authorization = (patch: Partial<SecurityAuthorizationItem> = {}): SecurityAuthorizationItem => ({
  id: 'sa_1',
  engagementId: 'eng1234567',
  method: 'local-development',
  status: 'verified',
  effectiveStatus: 'verified',
  subject: { host: '127.0.0.1', port: 4321, includeSubdomains: false },
  reason: null,
  verifiedAt: NOW.toISOString(),
  expiresAt: null,
  revokedAt: null,
  reference: null,
  metadata: {},
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  ...patch,
})

describe('environment and risk policy', () => {
  it('keeps production near passive by default', () => {
    const policy = policyFor('production')
    expect(Object.fromEntries(policy.risk.map((r) => [r.value, r.effective]))).toEqual({
      passive: 'allowed',
      'low-impact': 'bounded',
      'state-changing': 'denied',
      'high-impact': 'denied',
      destructive: 'denied',
    })
    expect(policy.mutation.find((m) => m.value === 'read-only')?.effective).toBe('allowed')
    expect(policy.mutation.find((m) => m.value === 'reversible-write')?.effective).toBe('denied')
    expect(policy.issues).toEqual([])
  })

  it('evaluates as production (the most restrictive) while no environment is chosen', () => {
    const policy = policyFor(null)
    expect(policy.evaluatedEnvironment).toBe('production')
    expect(evaluateCapabilityPolicy(policy, capability()).rule).toBe('policy.environment-not-set')
  })

  it('needs an explicit opt-in for opt-in classes and never lets an engagement override a denial', () => {
    expect(policyFor('staging').risk.find((r) => r.value === 'state-changing')?.effective).toBe('denied')
    const optedIn = policyFor('staging', { permissions: { riskClasses: ['passive', 'state-changing'] } })
    expect(optedIn.risk.find((r) => r.value === 'state-changing')?.effective).toBe('allowed')
    expect(optedIn.risk.find((r) => r.value === 'low-impact')?.effective).toBe('denied')
    const overreach = policyFor('production', { permissions: { riskClasses: ['passive', 'high-impact'] } })
    expect(overreach.risk.find((r) => r.value === 'high-impact')?.effective).toBe('denied')
    expect(overreach.issues[0]).toMatch(/High impact is selected but denied in production/)
  })

  it('clamps requested limits to the environment ceilings', () => {
    const policy = policyFor('production', { limits: { maxRequests: 50_000, requestsPerSecond: 1 } })
    expect(policy.limits.effective.maxRequests).toBe(1000)
    expect(policy.limits.effective.requestsPerSecond).toBe(1)
    expect(policy.limits.clamped).toEqual(['maxRequests: 50000 → 1000 (production ceiling)'])
  })

  it('decides capabilities from their declared classes per environment', () => {
    const stateChanging = capability({ riskClass: 'state-changing', sideEffect: 'reversible-write' })
    expect(evaluateCapabilityPolicy(policyFor('production'), stateChanging)).toMatchObject({ allowed: false, rule: 'policy.risk-not-selected' })
    expect(evaluateCapabilityPolicy(policyFor('production', { permissions: { riskClasses: ['passive', 'state-changing'] } }), stateChanging)).toMatchObject({
      allowed: false,
      rule: 'policy.mutation-not-selected',
    })
    expect(evaluateCapabilityPolicy(policyFor('isolated-lab'), stateChanging)).toMatchObject({ allowed: true, rule: 'policy.allowed' })
    expect(evaluateCapabilityPolicy(policyFor('production'), capability({ riskClass: 'destructive', sideEffect: 'irreversible-write' }))).toMatchObject({
      allowed: false,
      rule: 'policy.risk-denied',
    })
    expect(evaluateCapabilityPolicy(policyFor('staging'), capability({ supportedEnvironments: ['isolated-lab'] }))).toMatchObject({
      allowed: false,
      rule: 'policy.environment-unsupported',
    })
    expect(evaluateCapabilityPolicy(policyFor('production'), capability({ requiresExternalIntegration: true }))).toMatchObject({
      allowed: false,
      rule: 'policy.external-integration-denied',
    })
  })

  it('applies the bounded limits to bounded risk classes and the capability timeout', () => {
    const result = evaluateCapabilityPolicy(policyFor('production'), capability({ riskClass: 'low-impact' }))
    expect(result).toMatchObject({ allowed: true, rule: 'policy.allowed-bounded', risk: 'bounded' })
    expect(result.limits.maxRequests).toBe(200)
    expect(result.limits.executionTimeoutSeconds).toBe(30)
  })

  it('denies everything beyond passive under the observe-only profile and for unknown profiles', () => {
    const observe = policyFor('isolated-lab', {}, 'observe-only')
    expect(evaluateCapabilityPolicy(observe, capability({ riskClass: 'low-impact' })).allowed).toBe(false)
    const unknown = policyFor('production', {}, 'standard', 99)
    expect(unknown.issues[0]).toMatch(/not known/)
    expect(evaluateCapabilityPolicy(unknown, capability()).rule).toBe('policy.invalid')
  })
})

describe('authorization', () => {
  it('derives expiry from the clock and covers only its subject', () => {
    expect(effectiveAuthorizationStatus({ status: 'verified', expiresAt: '2026-10-08T11:00:00Z' }, NOW)).toBe('expired')
    expect(effectiveAuthorizationStatus({ status: 'verified', expiresAt: '2026-10-09T11:00:00Z' }, NOW)).toBe('verified')
    const auths = [authorization()]
    expect(evaluateAuthorizationCoverage(auths, { host: '127.0.0.1', port: 4321 }).state).toBe('valid')
    expect(evaluateAuthorizationCoverage(auths, { host: '127.0.0.1', port: 4322 }).state).toBe('missing')
    expect(evaluateAuthorizationCoverage(auths, { host: 'localhost', port: 4321 }).state).toBe('missing')
    expect(evaluateAuthorizationCoverage([authorization({ effectiveStatus: 'expired' })], { host: '127.0.0.1', port: 4321 }).state).toBe('expired')
    expect(evaluateAuthorizationCoverage([authorization({ status: 'revoked', effectiveStatus: 'revoked' })], { host: '127.0.0.1', port: 4321 }).state).toBe('revoked')
  })

  it('lists scope targets that no valid authorization covers', () => {
    expect(authorizationGaps(scope(), [authorization()])).toEqual([])
    expect(authorizationGaps(scope(), [])).toEqual(['127.0.0.1 port 4321'])
    expect(authorizationGaps(scope({ hosts: [{ host: '127.0.0.1', ports: [4321, 4322] }] }), [authorization()])).toEqual(['127.0.0.1 port 4322'])
    expect(authorizationGaps(scope({ networks: { cidrs: ['10.0.0.0/24'] } }), [authorization()])[0]).toMatch(/network 10.0.0.0\/24/)
  })

  const resolver = (map: Record<string, string[]>): Resolver => async (host) => {
    if (!(host in map)) throw new Error('not found')
    return map[host]!
  }

  it('verifies local development targets only on loopback, per port', async () => {
    const deps = { resolver: resolver({ localhost: ['127.0.0.1', '::1'], 'evil.localhost': ['10.0.0.1'] }), now: NOW }
    const ok = await localDevelopmentProvider.verify!({ host: '127.0.0.1', port: 4321, includeSubdomains: false }, deps)
    expect(ok).toMatchObject({ status: 'verified' })
    expect(ok.expiresAt!.getTime() - NOW.getTime()).toBe(7 * 24 * 3600 * 1000)
    expect((await localDevelopmentProvider.verify!({ host: 'localhost', port: 4321, includeSubdomains: false }, deps)).status).toBe('verified')
    for (const subject of [
      { host: '93.184.215.14', port: 443, includeSubdomains: false },
      { host: 'example.com', port: 443, includeSubdomains: false },
      { host: '192.168.1.5', port: 80, includeSubdomains: false },
      { host: '127.0.0.1', port: null, includeSubdomains: false },
      { host: 'localhost', port: 4321, includeSubdomains: true },
      { host: 'evil.localhost', port: 4321, includeSubdomains: false },
    ]) {
      expect((await localDevelopmentProvider.verify!(subject, deps)).status, JSON.stringify(subject)).toBe('failed')
    }
  })

  it('reports unimplemented verification methods as unavailable instead of faking them', () => {
    const methods = authorizationMethods()
    expect(methods.filter((m) => m.available).map((m) => m.method)).toEqual(['local-development'])
    for (const method of methods.filter((m) => !m.available)) expect(method.unavailableReason).toMatch(/Not available in this version/)
  })
})

describe('readiness and lifecycle', () => {
  const ready = (patch: Partial<Parameters<typeof evaluateReadiness>[0]> = {}) =>
    evaluateReadiness({ status: 'draft', environment: 'staging', scope: scope(), policy: policyFor('staging'), authorizations: [authorization()], now: NOW, ...patch })

  it('is ready only when every requirement holds', () => {
    expect(ready()).toMatchObject({ ready: true, state: 'ready', blockingReasons: [] })
    expect(ready({ authorizations: [] })).toMatchObject({ ready: false, state: 'not-authorized' })
    expect(ready({ scope: ScopeManifest.parse({}) })).toMatchObject({ ready: false, state: 'scope-incomplete' })
    expect(ready({ environment: null, policy: policyFor(null) })).toMatchObject({ ready: false, state: 'policy-incomplete' })
    expect(ready({ policy: policyFor('production', { permissions: { riskClasses: ['destructive'] } }), environment: 'production' })).toMatchObject({ state: 'policy-incomplete' })
    expect(ready({ authorizations: [authorization({ effectiveStatus: 'expired' })] }).state).toBe('not-authorized')
  })

  it('honours the testing window and the lifecycle', () => {
    const window = (startsAt: string, endsAt: string) => ready({ scope: scope({ testingWindow: { startsAt, endsAt } }) })
    expect(window('2026-10-08T00:00:00Z', '2026-10-09T00:00:00Z').ready).toBe(true)
    expect(window('2026-10-09T00:00:00Z', '2026-10-10T00:00:00Z')).toMatchObject({ ready: false, state: 'outside-window' })
    expect(window('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z').blockingReasons[0]).toMatch(/ended/)
    expect(ready({ status: 'cancelled' })).toMatchObject({ ready: false, state: 'closed' })
    expect(ready({ status: 'paused' })).toMatchObject({ ready: false, state: 'paused' })
  })

  it('derives setup statuses from readiness and gates lifecycle actions on it', () => {
    expect(derivedStatus('draft', ready())).toBe('ready')
    expect(derivedStatus('ready', ready({ authorizations: [] }))).toBe('authorization-pending')
    expect(derivedStatus('ready', ready({ scope: ScopeManifest.parse({}) }))).toBe('draft')
    expect(derivedStatus('active', ready({ authorizations: [] }))).toBe('active')
    expect(applyLifecycleAction('ready', 'activate', ready())).toEqual({ ok: true, status: 'active' })
    expect(applyLifecycleAction('ready', 'activate', ready({ authorizations: [] }))).toMatchObject({ ok: false })
    expect(applyLifecycleAction('draft', 'activate', ready())).toMatchObject({ ok: false })
    expect(applyLifecycleAction('active', 'pause', ready())).toEqual({ ok: true, status: 'paused' })
    expect(applyLifecycleAction('paused', 'resume', ready({ status: 'paused' }))).toEqual({ ok: true, status: 'active' })
    expect(applyLifecycleAction('completed', 'cancel', ready())).toMatchObject({ ok: false })
    expect(applyLifecycleAction('draft', 'cancel', ready())).toEqual({ ok: true, status: 'cancelled' })
  })
})
