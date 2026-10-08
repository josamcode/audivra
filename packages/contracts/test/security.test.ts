import { describe, expect, it } from 'vitest'
import {
  authorizationRequiredFor,
  AuthorizationSubject,
  cidrContains,
  classifyIp,
  CreateEngagementInput,
  currentPolicyProfile,
  defaultScopeManifest,
  findPolicyProfile,
  normalizeHostname,
  parseCidr,
  parseIp,
  redactSensitive,
  REDACTED,
  ScopeManifest,
  SECURITY_POLICY_PROFILES,
  SecurityActor,
  SecurityCapabilityMetadata,
  sensitive,
} from '../src/index.ts'

describe('network address parsing', () => {
  it('parses IPv4 strictly and IPv6 canonically', () => {
    expect(parseIp('127.0.0.1')?.text).toBe('127.0.0.1')
    expect(parseIp('[::1]')?.text).toBe('::1')
    expect(parseIp('0:0:0:0:0:0:0:1')?.text).toBe('::1')
    expect(parseIp('2001:DB8:0:0:1:0:0:1')?.text).toBe('2001:db8::1:0:0:1')
    expect(parseIp('1:2:3:4:5:6:1.2.3.4')?.text).toBe('1:2:3:4:5:6:102:304')
    // Ambiguous or host-local forms are rejected rather than guessed.
    for (const value of ['127.1', '010.0.0.1', '256.0.0.1', 'fe80::1%eth0', '1::2::3', 'example.com', '']) {
      expect(parseIp(value), value).toBeNull()
    }
  })

  it('classifies addresses, including private addresses carried inside IPv6 forms', () => {
    expect(classifyIp(parseIp('8.8.8.8')!)).toBe('public')
    expect(classifyIp(parseIp('127.0.0.5')!)).toBe('loopback')
    expect(classifyIp(parseIp('169.254.169.254')!)).toBe('link-local')
    expect(classifyIp(parseIp('192.168.1.10')!)).toBe('private')
    expect(classifyIp(parseIp('::1')!)).toBe('loopback')
    expect(classifyIp(parseIp('fd12::1')!)).toBe('unique-local')
    expect(classifyIp(parseIp('::ffff:10.0.0.1')!)).toBe('private')
    expect(classifyIp(parseIp('::ffff:127.0.0.1')!)).toBe('loopback')
    expect(classifyIp(parseIp('64:ff9b::a00:1')!)).toBe('private')
    expect(classifyIp(parseIp('2002:c0a8:101::1')!)).toBe('private')
  })

  it('matches CIDR blocks numerically, treating IPv4-mapped IPv6 as IPv4', () => {
    const block = parseCidr('10.1.2.3/16')!
    expect(block.text).toBe('10.1.0.0/16')
    expect(cidrContains(block, parseIp('10.1.255.1')!)).toBe(true)
    expect(cidrContains(block, parseIp('::ffff:10.1.0.9')!)).toBe(true)
    expect(cidrContains(block, parseIp('10.2.0.1')!)).toBe(false)
    expect(cidrContains(parseCidr('2001:db8::/48')!, parseIp('2001:db8:0:1::1')!)).toBe(true)
    expect(parseCidr('10.0.0.0/33')).toBeNull()
  })

  it('normalizes host names and rejects wildcards and malformed names', () => {
    expect(normalizeHostname('WWW.Example.COM.')).toBe('www.example.com')
    expect(normalizeHostname('bücher.de')).toBe('xn--bcher-kva.de')
    for (const value of ['*.example.com', 'a..b', '-a.com', 'foo.123', 'http://x.com', '1.2.3.4']) {
      expect(normalizeHostname(value), value).toBeNull()
    }
  })
})

describe('redaction', () => {
  it('replaces secrets by key and by recognizable value, keeping structure', () => {
    const { value, redactions } = redactSensitive({
      headers: { Authorization: 'Bearer abc.def', 'Set-Cookie': ['sid=1', 'x=2'] },
      authorization: { state: 'valid', authorizationIds: ['sa_1'] },
      requiresAuthorization: true,
      tokenCount: 3,
      url: 'https://user:pw@host.test/cb?access_token=zzz&q=1',
      note: 'password=hunter2, jwt eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl',
      wrapped: sensitive('top-secret'),
    })
    expect(value).toEqual({
      headers: { Authorization: REDACTED, 'Set-Cookie': [REDACTED, REDACTED] },
      authorization: { state: 'valid', authorizationIds: ['sa_1'] },
      requiresAuthorization: true,
      tokenCount: 3,
      url: `https://${REDACTED}@host.test/cb?access_token=${REDACTED}&q=1`,
      note: `password=${REDACTED}, jwt ${REDACTED}`,
      wrapped: REDACTED,
    })
    expect(redactions).toBe(8)
  })

  it('keeps sensitive values out of JSON, string interpolation and errors', () => {
    const secret = sensitive('s3cr3t-value', 'api key')
    expect(JSON.stringify({ secret })).not.toContain('s3cr3t')
    expect(`${secret}`).toBe(REDACTED)
    expect(new Error(`failed with ${secret}`).message).not.toContain('s3cr3t')
    expect(secret.reveal()).toBe('s3cr3t-value')
  })

  it('handles cycles and errors without leaking', () => {
    const node: Record<string, unknown> = { password: 'x' }
    node.self = node
    expect(redactSensitive(node).value).toEqual({ password: REDACTED, self: '[Circular]' })
    expect(redactSensitive(new Error('Bearer abcdefgh')).value).toEqual({ name: 'Error', message: `Bearer ${REDACTED}` })
  })
})

describe('scope manifest', () => {
  it('starts from exactly the target host, scheme and port', () => {
    const local = defaultScopeManifest('http://127.0.0.1:4321/path')
    expect(local.hosts).toEqual([{ host: '127.0.0.1', includeSubdomains: false, ports: [4321] }])
    expect(local.protocols).toEqual(['http'])
    const site = defaultScopeManifest('Example.com')
    expect(site.hosts).toEqual([{ host: 'example.com', includeSubdomains: false }])
    expect(site.protocols).toEqual(['https'])
    expect(site.permissions.externalIntegrations).toBe('deny')
    expect(site.redirects.policy).toBe('evaluate-each-hop')
  })

  it('normalizes hosts and path prefixes', () => {
    const manifest = ScopeManifest.parse({
      hosts: [{ host: 'WWW.Example.COM.', pathPrefixes: ['/app/../api/'] }],
      exclusions: { hosts: ['*.Admin.example.com'] },
      networks: { addresses: ['::FFFF:7f00:1'] },
    })
    expect(manifest.hosts[0]).toMatchObject({ host: 'www.example.com', pathPrefixes: ['/api'] })
    expect(manifest.exclusions.hosts).toEqual(['*.admin.example.com'])
    expect(manifest.networks.addresses).toEqual(['::ffff:7f00:1'])
  })

  it('rejects unknown keys, over-broad blocks, TLD subdomains and encoded separators', () => {
    const result = ScopeManifest.safeParse({
      hosts: [{ host: 'com', includeSubdomains: true }],
      networks: { cidrs: ['0.0.0.0/0'] },
      exclusions: { pathPrefixes: ['/a%2fb'] },
      authorized: true,
    })
    expect(result.success).toBe(false)
    const messages = result.error!.issues.map((issue) => issue.message).join(' | ')
    expect(messages).toMatch(/top-level name/)
    expect(messages).toMatch(/too broad/)
    expect(messages).toMatch(/encoded separators/)
    expect(messages).toMatch(/Unrecognized key/)
    expect(ScopeManifest.safeParse({ testingWindow: { startsAt: '2026-02-01T00:00:00Z', endsAt: '2026-01-01T00:00:00Z' } }).success).toBe(false)
  })
})

describe('policy profiles and capability metadata', () => {
  it('pins profiles by key and version and keeps production restrictive', () => {
    const standard = currentPolicyProfile('standard')
    expect(findPolicyProfile('standard', standard.version)).toBe(standard)
    expect(findPolicyProfile('standard', 999)).toBeUndefined()
    expect(standard.environments.production.risk['high-impact']).toBe('deny')
    expect(standard.environments.production.risk.destructive).toBe('deny')
    expect(standard.environments.production.mutation['irreversible-write']).toBe('deny')
    for (const profile of SECURITY_POLICY_PROFILES) {
      for (const env of Object.values(profile.environments)) {
        expect(env.risk.passive).toBe('allow')
        // Ceilings never exceed what the schema accepts and bounded limits never exceed ceilings.
        for (const key of Object.keys(env.bounded) as (keyof typeof env.bounded)[]) {
          expect(env.bounded[key]).toBeLessThanOrEqual(env.ceilings[key])
        }
      }
    }
  })

  it('requires authorization above passive / read-only whatever a capability declares', () => {
    expect(authorizationRequiredFor({ riskClass: 'passive', sideEffect: 'read-only', requiresAuthorization: false })).toBe(false)
    expect(authorizationRequiredFor({ riskClass: 'low-impact', sideEffect: 'read-only', requiresAuthorization: false })).toBe(true)
    expect(authorizationRequiredFor({ riskClass: 'passive', sideEffect: 'transient-state', requiresAuthorization: false })).toBe(true)
  })

  it('validates capability metadata strictly', () => {
    const base = {
      id: 'discovery.http-observe',
      version: 1,
      family: 'discovery',
      name: 'Observe',
      description: 'Reads one in-scope URL.',
      riskClass: 'passive',
      sideEffect: 'read-only',
      supportedEnvironments: ['production'],
      requiresAuthorization: true,
      requiresIdentity: false,
      requiresNetwork: true,
      requiresExternalIntegration: false,
      supportsCancellation: true,
      rateLimitClass: 'light',
      resourceProfile: { disk: 'small', containerImage: null, spawnsProcesses: false },
      timeoutProfile: { defaultSeconds: 10, maxSeconds: 30 },
      evidenceTypes: ['http-header'],
      implementation: 'builtin/http-observe@1',
    }
    expect(SecurityCapabilityMetadata.safeParse(base).success).toBe(true)
    expect(SecurityCapabilityMetadata.safeParse({ ...base, id: 'NoFamily' }).success).toBe(false)
    expect(SecurityCapabilityMetadata.safeParse({ ...base, extra: true }).success).toBe(false)
    expect(SecurityCapabilityMetadata.safeParse({ ...base, timeoutProfile: { defaultSeconds: 60, maxSeconds: 30 } }).success).toBe(false)
  })

  it('accepts only the documented engagement and actor fields', () => {
    expect(CreateEngagementInput.safeParse({ name: 'x', targetUrl: 'http://127.0.0.1:4321' }).success).toBe(true)
    expect(CreateEngagementInput.safeParse({ name: 'x', targetUrl: 'javascript:alert(1)' }).success).toBe(false)
    expect(CreateEngagementInput.safeParse({ name: 'x', targetUrl: 'example.com', authorized: true }).success).toBe(false)
    expect(SecurityActor.safeParse({ kind: 'agent', role: 'admin' }).success).toBe(false)
    expect(AuthorizationSubject.parse({ host: '[::1]' })).toEqual({ host: '::1', port: null, includeSubdomains: false })
  })
})
