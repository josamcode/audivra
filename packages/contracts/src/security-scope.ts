import { z } from 'zod'
import { ADDRESS_CATEGORIES, cidrSize, normalizeHostname, parseCidr, parseIp } from './net.ts'
import { MutationClass, RiskClass } from './security-classes.ts'
import { normalizeTargetUrl } from './url.ts'

/*
 * Scope manifest: the machine-enforced boundary of a security engagement. Every field is normalized on
 * parse (lower-case punycode hosts, canonical IP text, normalized path prefixes), so the scope engine
 * compares canonical values only. Unknown keys are rejected everywhere: a manifest cannot carry
 * anything the engine does not understand.
 */

export const SCOPE_SCHEMA_VERSION = 1

type Ctx = { issues: { code: string; message: string; input: unknown }[] }
function invalid(ctx: unknown, input: unknown, message: string): never {
  ;(ctx as Ctx).issues.push({ code: 'custom', message, input })
  return z.NEVER as never
}

/** A DNS name or IP literal, normalized. */
export const ScopeHost = z
  .string()
  .trim()
  .min(1, 'Enter a host')
  .max(253)
  .transform((value, ctx) => {
    const ip = parseIp(value)
    if (ip) return ip.text
    return normalizeHostname(value) ?? invalid(ctx, value, `"${value}" is not a valid host name or IP address`)
  })

/** `example.com` (that host) or `*.example.com` (its subdomains only). */
const HostPattern = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .transform((value, ctx) => {
    const wildcard = value.startsWith('*.')
    const rest = wildcard ? value.slice(2) : value
    const ip = wildcard ? null : parseIp(rest)
    if (ip) return ip.text
    const host = normalizeHostname(rest)
    return host ? `${wildcard ? '*.' : ''}${host}` : invalid(ctx, value, `"${value}" is not a valid host pattern`)
  })

const IpLiteral = z
  .string()
  .trim()
  .max(64)
  .transform((value, ctx) => parseIp(value)?.text ?? invalid(ctx, value, `"${value}" is not an IP address`))

/** Upper bound on one CIDR block, so a scope can never silently cover the internet. */
export const MAX_CIDR_ADDRESSES = 65_536n

const cidrBlock = (maxAddresses: bigint | null) =>
  z
    .string()
    .trim()
    .max(64)
    .transform((value, ctx) => {
      const cidr = parseCidr(value)
      if (!cidr) return invalid(ctx, value, `"${value}" is not a CIDR block (e.g. 10.0.0.0/24)`)
      if (maxAddresses !== null && cidrSize(cidr) > maxAddresses) return invalid(ctx, value, `${cidr.text} is too broad (at most 65,536 addresses per block)`)
      return cidr.text
    })
/** A block that is part of the scope (bounded). */
const CidrBlock = cidrBlock(MAX_CIDR_ADDRESSES)
/** A block excluded from the scope: excluding more only narrows it, so any size is fine. */
const ExcludedCidrBlock = cidrBlock(null)

export const Port = z.number().int().min(1).max(65_535)

export const WEB_SCHEMES = ['https', 'http'] as const
export const WebScheme = z.enum(WEB_SCHEMES)
export type WebScheme = z.infer<typeof WebScheme>

/** Segment-aware path prefix: "/app" covers "/app" and "/app/…", never "/application". */
const PathPrefix = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((value, ctx) => {
    if (!value.startsWith('/')) return invalid(ctx, value, 'Path prefixes start with "/"')
    if (/[?#\\]|%2f|%5c/i.test(value)) return invalid(ctx, value, 'Path prefixes cannot contain "?", "#", backslashes or encoded separators')
    const path = new URL(value, 'http://scope.invalid').pathname
    return path.length > 1 ? path.replace(/\/+$/, '') : path
  })

export const ScopeHostRule = z
  .strictObject({
    host: ScopeHost,
    /** Subdomains are never implied: `example.com` does not cover `www.example.com` unless this is set. */
    includeSubdomains: z.boolean().default(false),
    /** Allowed ports; default: the default port of each allowed scheme (443 / 80). */
    ports: z.array(Port).min(1).max(20).optional(),
    /** Allowed schemes; default: the manifest's protocols. */
    schemes: z.array(WebScheme).min(1).max(2).optional(),
    /** Allowed path prefixes; default: the whole host. */
    pathPrefixes: z.array(PathPrefix).min(1).max(20).optional(),
  })
  .superRefine((rule, ctx) => {
    if (!rule.includeSubdomains) return
    if (parseIp(rule.host)) ctx.addIssue({ code: 'custom', message: `${rule.host} is an IP address and has no subdomains`, path: ['includeSubdomains'] })
    else if (!rule.host.includes('.') && rule.host !== 'localhost') {
      ctx.addIssue({ code: 'custom', message: `Subdomains of a top-level name (${rule.host}) cannot be in scope`, path: ['includeSubdomains'] })
    }
  })
export type ScopeHostRule = z.infer<typeof ScopeHostRule>

/** A third-party dependency the engagement explicitly includes (never implied by being loaded by a page). */
export const ScopeDependency = z.strictObject({
  host: ScopeHost,
  includeSubdomains: z.boolean().default(false),
  purpose: z.string().trim().max(200).default(''),
})
export type ScopeDependency = z.infer<typeof ScopeDependency>

export const ExecutionLimits = z.strictObject({
  maxRequests: z.number().int().min(1).max(100_000),
  requestsPerSecond: z.number().positive().max(100),
  concurrency: z.number().int().min(1).max(32),
  executionTimeoutSeconds: z.number().int().min(1).max(86_400),
  maxResponseBytes: z.number().int().min(1024).max(100_000_000),
  maxArtifactMb: z.number().int().min(1).max(10_240),
})
export type ExecutionLimits = z.infer<typeof ExecutionLimits>
export const EXECUTION_LIMIT_KEYS = Object.keys(ExecutionLimits.shape) as (keyof ExecutionLimits)[]

export const TestingWindow = z
  .strictObject({ startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }) })
  .refine((w) => Date.parse(w.endsAt) > Date.parse(w.startsAt), { message: 'The testing window must end after it starts', path: ['endsAt'] })
export type TestingWindow = z.infer<typeof TestingWindow>

export const ScopeManifest = z.strictObject({
  schemaVersion: z.literal(SCOPE_SCHEMA_VERSION).default(SCOPE_SCHEMA_VERSION),
  /** Web targets by host name or IP literal. */
  hosts: z.array(ScopeHostRule).max(50).default([]),
  /** Network-level targets: exact addresses and bounded CIDR blocks. */
  networks: z
    .strictObject({ addresses: z.array(IpLiteral).max(50).default([]), cidrs: z.array(CidrBlock).max(20).default([]) })
    .prefault({}),
  protocols: z.array(WebScheme).min(1).max(2).default(['https', 'http']),
  /** Manifest-wide allowed ports for rules and network targets that do not list their own. */
  ports: z.array(Port).min(1).max(20).optional(),
  /** Exclusions win over every allow rule. */
  exclusions: z
    .strictObject({
      hosts: z.array(HostPattern).max(50).default([]),
      pathPrefixes: z.array(PathPrefix).max(50).default([]),
      addresses: z.array(IpLiteral).max(50).default([]),
      cidrs: z.array(ExcludedCidrBlock).max(20).default([]),
    })
    .prefault({}),
  dependencies: z.array(ScopeDependency).max(50).default([]),
  redirects: z
    .strictObject({
      /** Every hop is evaluated as an independent destination; `do-not-follow` stops at the first redirect. */
      policy: z.enum(['evaluate-each-hop', 'do-not-follow']).default('evaluate-each-hop'),
      maxHops: z.number().int().min(0).max(10).default(5),
      allowSchemeDowngrade: z.boolean().default(false),
    })
    .prefault({}),
  dns: z
    .strictObject({
      /** Every resolved address of an in-scope name must also be inside `networks`. */
      requireResolvedInNetworks: z.boolean().default(false),
    })
    .prefault({}),
  testingWindow: TestingWindow.nullable().default(null),
  /** Requested limits; the policy profile's ceilings always apply on top. */
  limits: ExecutionLimits.partial().prefault({}),
  permissions: z
    .strictObject({
      /** Requested risk classes; omitted → the profile's defaults for the environment. */
      riskClasses: z.array(RiskClass).max(5).optional(),
      mutationClasses: z.array(MutationClass).max(4).optional(),
      externalIntegrations: z.enum(['deny', 'allow']).default('deny'),
    })
    .prefault({}),
})
export type ScopeManifest = z.infer<typeof ScopeManifest>
export type ScopeManifestInput = z.input<typeof ScopeManifest>

/** Starting scope for a new engagement: exactly the target's host, scheme and port — nothing implied. */
export function defaultScopeManifest(targetUrl: string): ScopeManifest {
  const target = normalizeTargetUrl(targetUrl)
  if (!target.ok) throw new Error(target.error)
  const url = new URL(target.url)
  const scheme = url.protocol.replace(':', '') as WebScheme
  const port = url.port ? Number(url.port) : null
  return ScopeManifest.parse({
    hosts: [{ host: url.hostname, ...(port ? { ports: [port] } : {}) }],
    protocols: [scheme],
  })
}

export function scopeTargetCount(manifest: ScopeManifest): number {
  return manifest.hosts.length + manifest.networks.addresses.length + manifest.networks.cidrs.length
}

// ── Scope evaluation results ────────────────────────────────────────────────────────────────────────

/**
 * primary: an engagement target · dependency: an explicitly included third party · third-party: anything
 * else (never authorized) · excluded: matched an exclusion · invalid: not a usable destination.
 */
export const SCOPE_CLASSIFICATIONS = ['primary', 'dependency', 'third-party', 'excluded', 'invalid'] as const
export const ScopeClassification = z.enum(SCOPE_CLASSIFICATIONS)
export type ScopeClassification = z.infer<typeof ScopeClassification>

export const ScopeEvaluation = z.object({
  decision: z.enum(['allow', 'deny']),
  /** Stable rule identifier, e.g. `scope.host-not-listed`. */
  rule: z.string(),
  reason: z.string(),
  kind: z.enum(['target', 'url', 'redirect', 'network']),
  classification: ScopeClassification,
  destination: z.object({
    url: z.string().nullable(),
    scheme: z.string().nullable(),
    host: z.string().nullable(),
    port: z.number().nullable(),
    path: z.string().nullable(),
    addresses: z.array(z.object({ address: z.string(), category: z.enum(ADDRESS_CATEGORIES) })),
  }),
  /** For redirects: the URL that redirected here. */
  from: z.string().nullable(),
  matched: z.object({ kind: z.enum(['host', 'address', 'cidr', 'dependency']), value: z.string() }).nullable(),
  /** What this evaluation could not check (e.g. name-only checks without DNS resolution). */
  limitations: z.array(z.string()),
})
export type ScopeEvaluation = z.infer<typeof ScopeEvaluation>
