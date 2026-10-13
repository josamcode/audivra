import { createHash } from 'node:crypto'
import type { GraphEntityKind, GraphRelationType } from '@audivra/contracts'

/*
 * Deterministic identity for Security Graph facts. Two sensors that report the same entity produce the same
 * key, so the projector merges them onto one fact while keeping each one's provenance. No AI is involved in
 * identity: an AI may suggest that two things are the same, but only these rules merge facts.
 *
 *   host           host:<origin>                                   http://127.0.0.1:4331
 *   endpoint       endpoint:<origin><path>                         query, fragment and trailing slash dropped
 *   api-operation  api-operation:<origin><basePath>|<METHOD> <template>
 *   parameter      parameter:<owner key>|<location>:<name>
 *   technology     technology:<name>                               lower-cased, version stripped
 *   signal         signal:<observation type>:<subject>@<asset key>
 *   source-file    source-file:<path>
 *   edge           <TYPE>|<from key>|<to key>
 */

export interface UrlParts {
  origin: string
  /** Normalized path: always starts with `/`, no trailing slash except the root. */
  path: string
  /** Query parameter names (sorted, unique). */
  query: string[]
}

/** Parses an absolute http(s) URL into identity parts; null for anything else (file paths, garbage). */
export function urlParts(value: string): UrlParts | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  let path = url.pathname || '/'
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '') || '/'
  const query = [...new Set([...url.searchParams.keys()].map((k) => k.slice(0, 80)))].sort()
  return { origin: url.origin.toLowerCase(), path: path.slice(0, 1024), query }
}

export const hostKey = (origin: string) => `host:${origin}`
export const endpointKey = (origin: string, path: string) => `endpoint:${origin}${path}`
export const endpointUrl = (origin: string, path: string) => `${origin}${path}`
export const technologyKey = (name: string) => `technology:${name}`
export const sourceFileKey = (path: string) => `source-file:${path}`
export const parameterKey = (ownerKey: string, location: ParameterLocation, name: string) => `parameter:${ownerKey}|${location}:${name}`
export const signalKey = (type: string, subject: string, assetKey: string) => `signal:${type}:${subject}@${assetKey}`
export const edgeKey = (type: GraphRelationType, fromKey: string, toKey: string) => `${type}|${fromKey}|${toKey}`

export type ParameterLocation = 'query' | 'form' | 'path'

export function apiOperationKey(origin: string, basePath: string, method: string, template: string): string {
  const base = basePath === '/' ? '' : basePath
  return `api-operation:${origin}${base}|${method.toUpperCase()} ${template}`
}

/** Kind of an identity key (its prefix). */
export function keyKind(key: string): GraphEntityKind {
  return key.slice(0, key.indexOf(':')) as GraphEntityKind
}

// ── Phase 5: deterministic identity for declared application-semantics entities ──────────────────────

/** A stable, filesystem-/key-safe slug of a handle: lower-cased, non-alphanumerics collapsed to a dash. */
export function slug(value: string): string {
  const s = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return s || 'x'
}

export const identityKey = (ref: string) => `identity:${slug(ref)}`
export const tenantKey = (ref: string, externalId?: string | null) => `tenant:${slug(externalId ?? ref)}`
export const roleKey = (ref: string, scopeTenantRef?: string | null) => `role:${scopeTenantRef ? `${slug(scopeTenantRef)}/` : ''}${slug(ref)}`
export const businessActionKey = (verb: string, resourceType?: string | null) => `business-action:${slug(verb)}${resourceType ? `@${slug(resourceType)}` : ''}`
export const businessStateKey = (name: string, resourceType?: string | null) => `business-state:${resourceType ? `${slug(resourceType)}:` : ''}${slug(name)}`

/** A resource's stable identity: its external id, else its canonical URL (origin+path), else its handle. */
export function resourceKey(resourceType: string, opts: { externalId?: string | null; canonicalUrl?: string | null; ref: string }): string {
  let id: string
  if (opts.externalId) id = slug(opts.externalId)
  else {
    const parts = opts.canonicalUrl ? urlParts(opts.canonicalUrl) : null
    id = parts ? `${parts.origin}${parts.path}` : slug(opts.ref)
  }
  return `resource:${slug(resourceType)}:${id.slice(0, 200)}`
}

/** An invariant's stable identity: category + the entities it governs + its rule (order-independent). */
export function invariantKey(category: string, affects: readonly string[], rule: string): string {
  const basis = `${[...affects].sort().join(',')}|${rule.trim().replace(/\s+/g, ' ').toLowerCase()}`
  return `invariant:${category}:${createHash('sha256').update(basis).digest('hex').slice(0, 20)}`
}

/**
 * Parses a technology string the way sensors report it ("Nginx:1.18.0", "nginx/1.18.0 (Ubuntu)",
 * "Express", "PHP 8.1") into a normalized name and an optional version.
 */
export function parseTechnology(raw: string): { name: string; version: string | null; display: string } | null {
  const text = raw.trim().replace(/\s+/g, ' ')
  if (!text) return null
  const match = text.match(/^(.+?)(?:[:/ ]v?(\d[\w.+-]*))?(?:\s*\(.*\))?$/)
  const display = (match?.[1] ?? text).trim()
  const name = display.toLowerCase().slice(0, 80)
  if (!name) return null
  return { name, version: match?.[2]?.slice(0, 40) ?? null, display: display.slice(0, 80) }
}

/**
 * A Server header is a list of product tokens (`product[/version]`, then comments in parentheses or more
 * products): the server is the first token. "Apache/2.4.41 (Ubuntu) OpenSSL/1.1" → apache 2.4.41.
 */
export function parseServerHeader(raw: string): ReturnType<typeof parseTechnology> {
  const first = raw.trim().split(/\s+/)[0]
  return first ? parseTechnology(first) : null
}

/** "GET /widgets/{id}" (any case) → method + template; null when not an operation label. */
export function parseOperation(subject: string): { method: string; template: string } | null {
  const match = subject.trim().match(/^([a-z]+)\s+(\/\S*)$/i)
  if (!match) return null
  const method = match[1]!.toUpperCase()
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'QUERY'].includes(method)) return null
  let template = match[2]!
  if (template.length > 1 && template.endsWith('/')) template = template.replace(/\/+$/, '') || '/'
  return { method, template: template.slice(0, 512) }
}

/** Path parameters of a template (`/widgets/{id}` → ["id"]). */
export function templateParameters(template: string): string[] {
  return [...template.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!.slice(0, 80))
}

/**
 * Whether a concrete path matches an API path template under a base path: `/api/widgets/7` matches
 * `/widgets/{id}` with base `/api`. Literal segments must match exactly; a `{param}` segment matches one
 * non-empty segment.
 */
export function matchesTemplate(path: string, basePath: string, template: string): boolean {
  const base = basePath === '/' ? '' : basePath
  if (base && !path.startsWith(`${base}/`) && path !== base) return false
  const rest = base ? path.slice(base.length) || '/' : path
  const a = rest.split('/').filter(Boolean)
  const b = template.split('/').filter(Boolean)
  if (a.length !== b.length) return false
  return b.every((segment, i) => (/^\{[^}]+\}$/.test(segment) ? a[i]!.length > 0 : segment === a[i]))
}

/** The concrete URL of a parameterless operation (for inspection); null when the template has parameters. */
export function concreteOperationUrl(origin: string, basePath: string, template: string): string | null {
  if (templateParameters(template).length) return null
  const base = basePath === '/' ? '' : basePath
  return `${origin}${base}${template === '/' && base ? '' : template}`
}

/** Mutually exclusive technologies per layer: two of these on one host is a contradiction to resolve. */
export const EXCLUSIVE_TECHNOLOGY_GROUPS: Record<string, readonly string[]> = {
  'web-server': ['nginx', 'apache', 'apache http server', 'microsoft-iis', 'iis', 'caddy', 'lighttpd', 'litespeed', 'openresty', 'tengine', 'cherokee'],
}

export function exclusiveGroupOf(technology: string): string | null {
  for (const [group, members] of Object.entries(EXCLUSIVE_TECHNOLOGY_GROUPS)) if (members.includes(technology)) return group
  return null
}
