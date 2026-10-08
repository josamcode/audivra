import {
  cidrContains,
  classifyIp,
  isLocalhostName,
  isSameOrSubdomain,
  parseCidr,
  parseIp,
  unmapIp,
  type ParsedIp,
  type ScopeClassification,
  type ScopeEvaluation,
  type ScopeHostRule,
  type ScopeManifest,
} from '@audivra/contracts'
import { canonicalHash } from './canonical.ts'

/*
 * The scope engine: the one place that decides whether a destination is inside an engagement's scope.
 * Capabilities and clients never re-implement these checks; they call the functions below (the broker
 * before execution, the scoped HTTP client before every request and redirect hop).
 *
 * Decisions are made on canonical values: WHATWG URL parsing (which also normalizes obfuscated IPv4
 * forms such as 2130706433 or 0x7f.1), lower-case punycode hosts, canonical IP text and explicit ports.
 * Name-based checks are complemented by `evaluateNetworkDestination`, which checks the addresses a name
 * actually resolves to. Both are application-level checks: they bind the code paths that use them, not
 * the operating system's network stack (see docs/security-engagements.md).
 */

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }
const SCHEMES = new Set(['http', 'https'])

interface Destination {
  url: string
  scheme: string
  host: string
  port: number
  path: string
  ip: ParsedIp | null
  hasCredentials: boolean
}

type Kind = ScopeEvaluation['kind']

function emptyDestination(url: string | null): ScopeEvaluation['destination'] {
  return { url, scheme: null, host: null, port: null, path: null, addresses: [] }
}

function parseDestination(input: string): Destination | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  const rawHost = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const trimmed = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost
  const ip = parseIp(trimmed)
  const port = url.port ? Number(url.port) : (DEFAULT_PORTS[url.protocol] ?? 0)
  return {
    url: url.toString(),
    scheme: url.protocol.replace(/:$/, ''),
    host: ip ? unmapIp(ip).text : trimmed.toLowerCase(),
    port,
    path: url.pathname || '/',
    ip: ip ? unmapIp(ip) : null,
    hasCredentials: Boolean(url.username || url.password),
  }
}

function result(
  kind: Kind,
  decision: 'allow' | 'deny',
  rule: string,
  reason: string,
  classification: ScopeClassification,
  destination: ScopeEvaluation['destination'],
  extra: Partial<Pick<ScopeEvaluation, 'from' | 'matched' | 'limitations'>> = {},
): ScopeEvaluation {
  return {
    decision,
    rule,
    reason,
    kind,
    classification,
    destination,
    from: extra.from ?? null,
    matched: extra.matched ?? null,
    limitations: extra.limitations ?? [],
  }
}

function hostPatternMatches(pattern: string, host: string): boolean {
  return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : pattern === host
}

/** Segment-aware prefix match: "/app" matches "/app" and "/app/x", never "/application". */
function pathMatches(prefix: string, path: string): boolean {
  if (prefix === '/') return true
  return path === prefix || path.startsWith(`${prefix}/`)
}

function ruleHostMatches(rule: { host: string; includeSubdomains: boolean }, dest: Destination): boolean {
  if (dest.ip) {
    const ruleIp = parseIp(rule.host)
    return ruleIp !== null && unmapIp(ruleIp).text === dest.ip.text
  }
  return rule.includeSubdomains ? isSameOrSubdomain(dest.host, rule.host) : rule.host === dest.host
}

/** Explicit ports apply to every allowed scheme; without them only the URL scheme's own default port is in scope. */
function allowedPorts(manifest: ScopeManifest, scheme: string, rulePorts?: number[]): number[] {
  if (rulePorts?.length) return rulePorts
  if (manifest.ports?.length) return manifest.ports
  const port = DEFAULT_PORTS[`${scheme}:`]
  return port ? [port] : []
}

interface RuleMiss {
  rule: string
  reason: string
}

function checkHostRule(manifest: ScopeManifest, rule: ScopeHostRule, dest: Destination): RuleMiss | null {
  const schemes = rule.schemes ?? manifest.protocols
  if (!schemes.includes(dest.scheme as 'http' | 'https')) {
    return { rule: 'scope.scheme-not-allowed', reason: `${dest.scheme} is not an allowed protocol for ${rule.host} (allowed: ${schemes.join(', ')})` }
  }
  const ports = allowedPorts(manifest, dest.scheme, rule.ports)
  if (!ports.includes(dest.port)) {
    return { rule: 'scope.port-not-allowed', reason: `Port ${dest.port} is not in scope for ${rule.host} (allowed: ${ports.join(', ')})` }
  }
  if (rule.pathPrefixes) {
    if (/%2f|%5c/i.test(dest.path)) {
      return { rule: 'scope.path-ambiguous', reason: 'The path contains encoded separators, so its place in the allowed paths is ambiguous' }
    }
    if (!rule.pathPrefixes.some((prefix) => pathMatches(prefix, dest.path))) {
      return { rule: 'scope.path-not-allowed', reason: `${dest.path} is outside the allowed paths of ${rule.host} (${rule.pathPrefixes.join(', ')})` }
    }
  }
  return null
}

const NAME_ONLY = 'Decided on the host name; the addresses it resolves to are checked separately before connecting.'

/** Evaluates one absolute URL against the manifest. */
export function evaluateUrl(
  manifest: ScopeManifest,
  input: string,
  options: { kind?: Kind; from?: string | null } = {},
): ScopeEvaluation {
  const kind = options.kind ?? 'url'
  const from = options.from ?? null
  const dest = parseDestination(input)
  if (!dest) return result(kind, 'deny', 'scope.invalid-url', `"${input.slice(0, 200)}" is not an absolute URL`, 'invalid', emptyDestination(null), { from })
  const destination: ScopeEvaluation['destination'] = {
    url: dest.url,
    scheme: dest.scheme,
    host: dest.host,
    port: dest.port,
    path: dest.path,
    addresses: dest.ip ? [{ address: dest.ip.text, category: classifyIp(dest.ip) }] : [],
  }
  const deny = (rule: string, reason: string, classification: ScopeClassification = 'third-party') =>
    result(kind, 'deny', rule, reason, classification, destination, { from })

  if (!SCHEMES.has(dest.scheme)) return deny('scope.scheme-unsupported', `${dest.scheme}: URLs are never in scope`, 'invalid')
  if (dest.hasCredentials) return deny('scope.credentials-in-url', 'URLs with embedded credentials are never followed', 'invalid')
  if (!dest.port) return deny('scope.invalid-url', 'The URL has no usable port', 'invalid')

  // Exclusions win over every allow rule.
  const excludedHost = manifest.exclusions.hosts.find((pattern) => hostPatternMatches(pattern, dest.host))
  if (excludedHost) return deny('scope.excluded-host', `${dest.host} is excluded (${excludedHost})`, 'excluded')
  if (dest.ip) {
    const excludedAddress =
      manifest.exclusions.addresses.find((a) => parseIp(a)?.text === dest.ip!.text) ??
      manifest.exclusions.cidrs.find((c) => cidrContains(parseCidr(c)!, dest.ip!))
    if (excludedAddress) return deny('scope.excluded-address', `${dest.host} is excluded (${excludedAddress})`, 'excluded')
  }
  const excludedPath = manifest.exclusions.pathPrefixes.find((prefix) => pathMatches(prefix, dest.path))
  if (excludedPath) return deny('scope.excluded-path', `${dest.path} is excluded (${excludedPath})`, 'excluded')

  const limitations = dest.ip ? [] : [NAME_ONLY]

  // Primary targets: host rules.
  let closest: RuleMiss | null = null
  for (const rule of manifest.hosts) {
    if (!ruleHostMatches(rule, dest)) continue
    const miss = checkHostRule(manifest, rule, dest)
    if (!miss) {
      return result(kind, 'allow', 'scope.host-rule', `${dest.host}:${dest.port} matches the scope rule for ${rule.host}${rule.includeSubdomains ? ' (including subdomains)' : ''}`, 'primary', destination, {
        from,
        matched: { kind: 'host', value: rule.host },
        limitations,
      })
    }
    closest ??= miss
  }

  // Primary targets: network addresses and blocks (IP-literal destinations).
  if (dest.ip) {
    const address = manifest.networks.addresses.find((a) => parseIp(a)?.text === dest.ip!.text)
    const block = address ? undefined : manifest.networks.cidrs.find((c) => cidrContains(parseCidr(c)!, dest.ip!))
    const matched = address ? { kind: 'address' as const, value: address } : block ? { kind: 'cidr' as const, value: block } : null
    if (matched) {
      const miss = checkHostRule(manifest, { host: dest.host, includeSubdomains: false }, dest)
      if (!miss) {
        return result(kind, 'allow', `scope.network-${matched.kind}`, `${dest.host}:${dest.port} is inside the scoped ${matched.kind} ${matched.value}`, 'primary', destination, { from, matched })
      }
      closest ??= miss
    }
  }

  if (closest) return deny(closest.rule, closest.reason, 'primary')

  // Explicitly included third-party dependencies.
  const dependency = manifest.dependencies.find((d) => ruleHostMatches(d, dest))
  if (dependency) {
    const miss = checkHostRule(manifest, { host: dependency.host, includeSubdomains: dependency.includeSubdomains }, dest)
    if (miss) return deny(miss.rule, miss.reason, 'dependency')
    return result(kind, 'allow', 'scope.dependency', `${dest.host} is an explicitly included dependency${dependency.purpose ? ` (${dependency.purpose})` : ''}`, 'dependency', destination, {
      from,
      matched: { kind: 'dependency', value: dependency.host },
      limitations,
    })
  }

  // Subdomains are never implied by their parent.
  const parent = dest.ip ? undefined : manifest.hosts.find((rule) => !rule.includeSubdomains && isSameOrSubdomain(dest.host, rule.host))
  if (parent) {
    return deny('scope.subdomain-not-included', `${dest.host} is a subdomain of ${parent.host}, but subdomains of ${parent.host} are not in scope`)
  }
  return deny('scope.host-not-listed', `${dest.host} is not part of this engagement's scope (third parties are never authorized implicitly)`)
}

/** A target given as a host (and optional port/scheme) rather than a URL. */
export function evaluateTarget(manifest: ScopeManifest, target: { host: string; port?: number | null; scheme?: 'http' | 'https' }): ScopeEvaluation {
  const scheme = target.scheme ?? manifest.protocols[0] ?? 'https'
  const ip = parseIp(target.host)
  const host = ip?.family === 6 ? `[${ip.text}]` : target.host
  const url = `${scheme}://${host}${target.port ? `:${target.port}` : ''}/`
  return evaluateUrl(manifest, url, { kind: 'target' })
}

/**
 * Evaluates a redirect independently of the request that produced it: the Location is resolved against
 * the redirecting URL and the result is evaluated like any other destination.
 */
export function evaluateRedirect(manifest: ScopeManifest, fromUrl: string, location: string, hop = 1): ScopeEvaluation {
  const deny = (rule: string, reason: string, url: string | null = null) =>
    result('redirect', 'deny', rule, reason, url ? 'third-party' : 'invalid', emptyDestination(url), { from: fromUrl })
  if (manifest.redirects.policy === 'do-not-follow') return deny('redirect.not-followed', 'This engagement does not follow redirects')
  if (hop > manifest.redirects.maxHops) return deny('redirect.too-many-hops', `More than ${manifest.redirects.maxHops} redirects`)
  let target: URL
  try {
    target = new URL(location, fromUrl)
  } catch {
    return deny('redirect.invalid-location', `The redirect location "${location.slice(0, 200)}" is not a valid URL`)
  }
  if (!manifest.redirects.allowSchemeDowngrade && fromUrl.startsWith('https:') && target.protocol === 'http:') {
    return deny('redirect.scheme-downgrade', 'Redirect from HTTPS to HTTP is not followed', target.toString())
  }
  const evaluation = evaluateUrl(manifest, target.toString(), { kind: 'redirect', from: fromUrl })
  return evaluation.decision === 'allow' ? evaluation : { ...evaluation, reason: `Redirect target is out of scope: ${evaluation.reason}` }
}

/**
 * Checks the addresses a destination resolves to (DNS awareness). Every address must pass, because a
 * client may connect to any of them:
 * - excluded addresses are refused;
 * - with `dns.requireResolvedInNetworks`, every address must be inside the scoped networks;
 * - non-public addresses (loopback, private, link-local, …) are accepted only when explicitly in scope:
 *   listed in `networks`, the destination itself is that IP literal, or a `localhost` name resolving to
 *   loopback. A public name that suddenly resolves to an internal address is therefore refused;
 * - unspecified and multicast addresses are never usable.
 */
export function evaluateNetworkDestination(
  manifest: ScopeManifest,
  input: { host: string; port: number; addresses: string[]; classification?: ScopeClassification; url?: string | null },
): ScopeEvaluation {
  const parsed = input.addresses.map((a) => ({ text: a, ip: parseIp(a) }))
  const addresses = parsed.filter((p) => p.ip).map((p) => ({ address: unmapIp(p.ip!).text, category: classifyIp(p.ip!) }))
  const destination: ScopeEvaluation['destination'] = { url: input.url ?? null, scheme: null, host: input.host, port: input.port, path: null, addresses }
  const classification = input.classification ?? 'primary'
  const deny = (rule: string, reason: string, cls: ScopeClassification = classification) => result('network', 'deny', rule, reason, cls, destination)

  if (parsed.length === 0) return deny('dns.no-addresses', `${input.host} did not resolve to any address`, 'invalid')
  const invalid = parsed.find((p) => !p.ip)
  if (invalid) return deny('dns.invalid-address', `${input.host} resolved to "${invalid.text}", which is not an IP address`, 'invalid')

  const hostIp = parseIp(input.host)
  const listedAsTarget = (ip: ParsedIp) => hostIp !== null && unmapIp(hostIp).text === ip.text
  for (const { ip: raw } of parsed) {
    const ip = unmapIp(raw!)
    const category = classifyIp(ip)
    const inNetworks =
      manifest.networks.addresses.some((a) => parseIp(a)?.text === ip.text) || manifest.networks.cidrs.some((c) => cidrContains(parseCidr(c)!, ip))
    if (manifest.exclusions.addresses.some((a) => parseIp(a)?.text === ip.text) || manifest.exclusions.cidrs.some((c) => cidrContains(parseCidr(c)!, ip))) {
      return deny('dns.resolved-excluded', `${input.host} resolves to excluded address ${ip.text}`, 'excluded')
    }
    if (category === 'unspecified' || category === 'multicast') {
      return deny('dns.unusable-address', `${input.host} resolves to ${ip.text} (${category}), which is never a valid destination`)
    }
    if (manifest.dns.requireResolvedInNetworks && !inNetworks && !listedAsTarget(ip)) {
      return deny('dns.resolved-outside-networks', `${input.host} resolves to ${ip.text}, which is outside the scoped networks`)
    }
    if (category !== 'public' && !inNetworks && !listedAsTarget(ip) && !(category === 'loopback' && isLocalhostName(input.host))) {
      return deny('dns.resolved-to-non-public', `${input.host} resolves to ${ip.text} (${category}); non-public addresses must be listed in the scope's networks`)
    }
  }
  return result('network', 'allow', 'dns.addresses-in-scope', `${input.host} resolves to ${addresses.map((a) => a.address).join(', ')}, all acceptable for this scope`, classification, destination)
}

/** Blocking problems with a manifest (used by readiness); empty when the scope is usable. */
export function scopeIssues(manifest: ScopeManifest): string[] {
  const issues: string[] = []
  const targets = manifest.hosts.length + manifest.networks.addresses.length + manifest.networks.cidrs.length
  if (targets === 0) issues.push('The scope has no targets: add at least one host, address or network.')
  for (const rule of manifest.hosts) {
    const pattern = manifest.exclusions.hosts.find((p) => hostPatternMatches(p, rule.host))
    if (pattern) issues.push(`${rule.host} is both in scope and excluded (${pattern}).`)
  }
  if (manifest.exclusions.pathPrefixes.includes('/')) issues.push('Every path is excluded ("/").')
  if (manifest.testingWindow && Date.parse(manifest.testingWindow.endsAt) <= Date.parse(manifest.testingWindow.startsAt)) {
    issues.push('The testing window ends before it starts.')
  }
  return [...new Set(issues)]
}

/** Content hash of a manifest (key order independent), recorded with every decision. */
export function manifestHash(manifest: ScopeManifest): string {
  return canonicalHash(manifest)
}
