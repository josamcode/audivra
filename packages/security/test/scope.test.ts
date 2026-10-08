import { describe, expect, it } from 'vitest'
import { ScopeManifest, type ScopeManifestInput } from '@audivra/contracts'
import { evaluateNetworkDestination, evaluateRedirect, evaluateTarget, evaluateUrl, manifestHash, scopeIssues } from '../src/index.ts'

const scope = (input: ScopeManifestInput) => ScopeManifest.parse(input)

const site = scope({ hosts: [{ host: 'example.com' }], protocols: ['https', 'http'] })

describe('scope engine: hosts, subdomains, ports and protocols', () => {
  it('allows the listed host on its default ports and normalizes the URL', () => {
    const result = evaluateUrl(site, 'HTTPS://Example.COM./a?b=1')
    expect(result).toMatchObject({ decision: 'allow', rule: 'scope.host-rule', classification: 'primary', matched: { kind: 'host', value: 'example.com' } })
    expect(result.destination).toMatchObject({ scheme: 'https', host: 'example.com', port: 443, path: '/a' })
    expect(evaluateUrl(site, 'http://example.com/').decision).toBe('allow')
  })

  it('never treats a parent host as covering subdomains (www included)', () => {
    for (const url of ['https://www.example.com/', 'https://anything.example.com/', 'https://a.b.example.com/']) {
      const result = evaluateUrl(site, url)
      expect(result.decision, url).toBe('deny')
      expect(result.rule).toBe('scope.subdomain-not-included')
    }
    const withSubdomains = scope({ hosts: [{ host: 'example.com', includeSubdomains: true }] })
    expect(evaluateUrl(withSubdomains, 'https://www.example.com/').decision).toBe('allow')
    expect(evaluateUrl(withSubdomains, 'https://a.b.example.com/').decision).toBe('allow')
    // Suffix tricks are not subdomains.
    expect(evaluateUrl(withSubdomains, 'https://evilexample.com/').decision).toBe('deny')
    expect(evaluateUrl(withSubdomains, 'https://example.com.evil.test/').decision).toBe('deny')
  })

  it('denies ports and protocols outside the rule', () => {
    expect(evaluateUrl(site, 'https://example.com:8443/')).toMatchObject({ decision: 'deny', rule: 'scope.port-not-allowed' })
    expect(evaluateUrl(site, 'http://example.com:443/')).toMatchObject({ decision: 'deny', rule: 'scope.port-not-allowed' })
    const httpsOnly = scope({ hosts: [{ host: 'example.com' }], protocols: ['https'] })
    expect(evaluateUrl(httpsOnly, 'http://example.com/')).toMatchObject({ decision: 'deny', rule: 'scope.scheme-not-allowed' })
    const local = scope({ hosts: [{ host: '127.0.0.1', ports: [4321] }], protocols: ['http'] })
    expect(evaluateUrl(local, 'http://127.0.0.1:4321/x').decision).toBe('allow')
    expect(evaluateUrl(local, 'http://127.0.0.1:4322/x')).toMatchObject({ decision: 'deny', rule: 'scope.port-not-allowed' })
    expect(evaluateUrl(local, 'http://127.0.0.1/x')).toMatchObject({ decision: 'deny', rule: 'scope.port-not-allowed' })
  })

  it('rejects unusable URLs outright', () => {
    expect(evaluateUrl(site, 'ftp://example.com/')).toMatchObject({ decision: 'deny', rule: 'scope.scheme-unsupported' })
    expect(evaluateUrl(site, 'https://user:pw@example.com/')).toMatchObject({ decision: 'deny', rule: 'scope.credentials-in-url' })
    expect(evaluateUrl(site, '/relative')).toMatchObject({ decision: 'deny', rule: 'scope.invalid-url' })
    expect(evaluateUrl(site, 'javascript:alert(1)')).toMatchObject({ decision: 'deny', rule: 'scope.scheme-unsupported' })
  })

  it('classifies anything else as an unauthorized third party', () => {
    for (const url of ['https://cdn.thirdparty.test/lib.js', 'https://www.google-analytics.com/collect', 'https://fonts.gstatic.com/x.woff2']) {
      expect(evaluateUrl(site, url)).toMatchObject({ decision: 'deny', rule: 'scope.host-not-listed', classification: 'third-party' })
    }
  })

  it('allows explicitly included dependencies, classified as such', () => {
    const withDependency = scope({ hosts: [{ host: 'example.com' }], dependencies: [{ host: 'api.partner.test', purpose: 'Own API on a partner domain' }] })
    expect(evaluateUrl(withDependency, 'https://api.partner.test/v1')).toMatchObject({ decision: 'allow', classification: 'dependency', matched: { kind: 'dependency' } })
    expect(evaluateUrl(withDependency, 'https://other.partner.test/').classification).toBe('third-party')
  })
})

describe('scope engine: IP literals and networks', () => {
  const local = scope({ hosts: [{ host: '127.0.0.1', ports: [4321] }], protocols: ['http'] })

  it('compares canonical addresses, so obfuscated forms of an address are the same address', () => {
    // WHATWG URL parsing turns these into 127.0.0.1; the decision is about the address, not the text.
    for (const url of ['http://2130706433:4321/', 'http://0x7f.1:4321/', 'http://127.1:4321/']) {
      expect(evaluateUrl(local, url).destination.host, url).toBe('127.0.0.1')
      expect(evaluateUrl(local, url).decision, url).toBe('allow')
    }
    expect(evaluateUrl(local, 'http://127.0.0.2:4321/')).toMatchObject({ decision: 'deny', rule: 'scope.host-not-listed' })
    expect(evaluateUrl(local, 'http://localhost:4321/')).toMatchObject({ decision: 'deny', rule: 'scope.host-not-listed' })
  })

  it('handles IPv6 and IPv4-mapped IPv6', () => {
    const v6 = scope({ hosts: [{ host: '::1', ports: [8080] }], protocols: ['http'] })
    expect(evaluateUrl(v6, 'http://[0:0:0:0:0:0:0:1]:8080/').decision).toBe('allow')
    expect(evaluateUrl(v6, 'http://[::2]:8080/').decision).toBe('deny')
    expect(evaluateUrl(local, 'http://[::ffff:127.0.0.1]:4321/').decision).toBe('allow')
  })

  it('matches network addresses and CIDR blocks with the manifest ports', () => {
    const lab = scope({ networks: { cidrs: ['10.20.0.0/24'], addresses: ['192.168.5.9'] }, protocols: ['http'], ports: [8080] })
    expect(evaluateUrl(lab, 'http://10.20.0.77:8080/')).toMatchObject({ decision: 'allow', rule: 'scope.network-cidr' })
    expect(evaluateUrl(lab, 'http://192.168.5.9:8080/')).toMatchObject({ decision: 'allow', rule: 'scope.network-address' })
    expect(evaluateUrl(lab, 'http://10.20.1.1:8080/').decision).toBe('deny')
    expect(evaluateUrl(lab, 'http://10.20.0.77:22/')).toMatchObject({ decision: 'deny', rule: 'scope.port-not-allowed' })
  })
})

describe('scope engine: exclusions and paths', () => {
  const manifest = scope({
    hosts: [{ host: 'example.com', includeSubdomains: true }, { host: 'app.example.com', pathPrefixes: ['/api'] }],
    exclusions: { hosts: ['*.admin.example.com', 'billing.example.com'], pathPrefixes: ['/internal'], cidrs: ['10.0.0.0/8'] },
    networks: { cidrs: ['10.1.0.0/16'] },
  })

  it('applies exclusions before any allow rule', () => {
    expect(evaluateUrl(manifest, 'https://billing.example.com/')).toMatchObject({ decision: 'deny', rule: 'scope.excluded-host', classification: 'excluded' })
    expect(evaluateUrl(manifest, 'https://x.admin.example.com/')).toMatchObject({ decision: 'deny', rule: 'scope.excluded-host' })
    expect(evaluateUrl(manifest, 'https://www.example.com/internal/x')).toMatchObject({ decision: 'deny', rule: 'scope.excluded-path' })
    expect(evaluateUrl(manifest, 'https://10.1.2.3/')).toMatchObject({ decision: 'deny', rule: 'scope.excluded-address' })
  })

  it('evaluates path prefixes per segment and rejects ambiguous encodings', () => {
    const api = scope({ hosts: [{ host: 'app.example.com', pathPrefixes: ['/api'] }] })
    expect(evaluateUrl(api, 'https://app.example.com/api').decision).toBe('allow')
    expect(evaluateUrl(api, 'https://app.example.com/api/v1/users').decision).toBe('allow')
    expect(evaluateUrl(api, 'https://app.example.com/apiary')).toMatchObject({ decision: 'deny', rule: 'scope.path-not-allowed' })
    // Dot segments are resolved by URL parsing before the check.
    expect(evaluateUrl(api, 'https://app.example.com/api/../admin')).toMatchObject({ decision: 'deny', rule: 'scope.path-not-allowed' })
    expect(evaluateUrl(api, 'https://app.example.com/api%2f..%2fadmin')).toMatchObject({ decision: 'deny', rule: 'scope.path-ambiguous' })
  })

  it('reports blocking scope problems', () => {
    expect(scopeIssues(scope({}))).toEqual(['The scope has no targets: add at least one host, address or network.'])
    expect(scopeIssues(scope({ hosts: [{ host: 'example.com' }], exclusions: { hosts: ['example.com'] } }))[0]).toMatch(/both in scope and excluded/)
    expect(scopeIssues(site)).toEqual([])
  })
})

describe('scope engine: redirects', () => {
  it('evaluates every redirect destination independently', () => {
    expect(evaluateRedirect(site, 'https://example.com/a', '/b')).toMatchObject({ decision: 'allow', kind: 'redirect', from: 'https://example.com/a' })
    expect(evaluateRedirect(site, 'http://example.com/', 'https://example.com/')).toMatchObject({ decision: 'allow' })
    const toWww = evaluateRedirect(site, 'https://example.com/', 'https://www.example.com/')
    expect(toWww).toMatchObject({ decision: 'deny', rule: 'scope.subdomain-not-included' })
    expect(toWww.reason).toMatch(/^Redirect target is out of scope/)
    expect(evaluateRedirect(site, 'https://example.com/', 'https://login.thirdparty.test/sso')).toMatchObject({ decision: 'deny', rule: 'scope.host-not-listed' })
    expect(evaluateRedirect(site, 'https://example.com/', '//evil.test/')).toMatchObject({ decision: 'deny', rule: 'scope.host-not-listed' })
  })

  it('refuses downgrades, excess hops and redirects when the engagement does not follow them', () => {
    expect(evaluateRedirect(site, 'https://example.com/', 'http://example.com/')).toMatchObject({ decision: 'deny', rule: 'redirect.scheme-downgrade' })
    expect(evaluateRedirect(site, 'https://example.com/', '/x', 6)).toMatchObject({ decision: 'deny', rule: 'redirect.too-many-hops' })
    const noFollow = scope({ hosts: [{ host: 'example.com' }], redirects: { policy: 'do-not-follow' } })
    expect(evaluateRedirect(noFollow, 'https://example.com/', '/x')).toMatchObject({ decision: 'deny', rule: 'redirect.not-followed' })
  })
})

describe('scope engine: resolved destinations (DNS awareness)', () => {
  it('accepts public addresses for an in-scope name and records them', () => {
    const result = evaluateNetworkDestination(site, { host: 'example.com', port: 443, addresses: ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'] })
    expect(result).toMatchObject({ decision: 'allow', kind: 'network' })
    expect(result.destination.addresses.map((a) => a.category)).toEqual(['public', 'public'])
  })

  it('refuses a public name that resolves to an internal address, even if only one record does', () => {
    expect(evaluateNetworkDestination(site, { host: 'example.com', port: 443, addresses: ['127.0.0.1'] })).toMatchObject({ decision: 'deny', rule: 'dns.resolved-to-non-public' })
    expect(evaluateNetworkDestination(site, { host: 'example.com', port: 443, addresses: ['93.184.215.14', '169.254.169.254'] })).toMatchObject({
      decision: 'deny',
      rule: 'dns.resolved-to-non-public',
    })
    expect(evaluateNetworkDestination(site, { host: 'example.com', port: 443, addresses: ['::ffff:10.0.0.1'] }).decision).toBe('deny')
    expect(evaluateNetworkDestination(site, { host: 'example.com', port: 443, addresses: ['0.0.0.0'] })).toMatchObject({ decision: 'deny', rule: 'dns.unusable-address' })
    expect(evaluateNetworkDestination(site, { host: 'example.com', port: 443, addresses: [] })).toMatchObject({ decision: 'deny', rule: 'dns.no-addresses' })
  })

  it('accepts internal addresses only when they are explicitly in scope', () => {
    const local = scope({ hosts: [{ host: 'localhost', ports: [4321] }, { host: '127.0.0.1', ports: [4321] }], protocols: ['http'] })
    expect(evaluateNetworkDestination(local, { host: 'localhost', port: 4321, addresses: ['127.0.0.1', '::1'] }).decision).toBe('allow')
    expect(evaluateNetworkDestination(local, { host: '127.0.0.1', port: 4321, addresses: ['127.0.0.1'] }).decision).toBe('allow')
    expect(evaluateNetworkDestination(local, { host: 'localhost', port: 4321, addresses: ['10.0.0.5'] }).decision).toBe('deny')
    const staging = scope({ hosts: [{ host: 'staging.internal.test' }], networks: { cidrs: ['10.8.0.0/24'] } })
    expect(evaluateNetworkDestination(staging, { host: 'staging.internal.test', port: 443, addresses: ['10.8.0.4'] }).decision).toBe('allow')
    expect(evaluateNetworkDestination(staging, { host: 'staging.internal.test', port: 443, addresses: ['10.9.0.4'] }).decision).toBe('deny')
  })

  it('can require every resolved address to be inside the scoped networks, and honours exclusions', () => {
    const pinned = scope({ hosts: [{ host: 'example.com' }], networks: { cidrs: ['203.0.113.0/24'] }, dns: { requireResolvedInNetworks: true } })
    expect(evaluateNetworkDestination(pinned, { host: 'example.com', port: 443, addresses: ['203.0.113.10'] }).decision).toBe('allow')
    expect(evaluateNetworkDestination(pinned, { host: 'example.com', port: 443, addresses: ['93.184.215.14'] })).toMatchObject({ decision: 'deny', rule: 'dns.resolved-outside-networks' })
    const excluded = scope({ hosts: [{ host: 'example.com' }], exclusions: { addresses: ['93.184.215.14'] } })
    expect(evaluateNetworkDestination(excluded, { host: 'example.com', port: 443, addresses: ['93.184.215.14'] })).toMatchObject({ decision: 'deny', rule: 'dns.resolved-excluded' })
  })

  it('marks name-only decisions with their limitation', () => {
    expect(evaluateUrl(site, 'https://example.com/').limitations[0]).toMatch(/resolves to are checked separately/)
    expect(evaluateUrl(scope({ hosts: [{ host: '127.0.0.1' }] }), 'https://127.0.0.1/').limitations).toEqual([])
  })
})

describe('scope engine: targets and hashing', () => {
  it('evaluates host targets with explicit or default ports', () => {
    expect(evaluateTarget(site, { host: 'example.com' }).decision).toBe('allow')
    expect(evaluateTarget(site, { host: 'example.com', port: 22 }).decision).toBe('deny')
    expect(evaluateTarget(scope({ hosts: [{ host: '::1', ports: [80] }], protocols: ['http'] }), { host: '::1', port: 80 }).decision).toBe('allow')
  })

  it('hashes manifests independently of key order', () => {
    const a = scope({ hosts: [{ host: 'example.com' }], protocols: ['https'] })
    const b = ScopeManifest.parse(JSON.parse(JSON.stringify({ protocols: ['https'], hosts: [{ includeSubdomains: false, host: 'example.com' }] })))
    expect(manifestHash(a)).toBe(manifestHash(b))
    expect(manifestHash(a)).not.toBe(manifestHash(site))
  })
})
