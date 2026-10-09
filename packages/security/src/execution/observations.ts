import type { ObservationScopeClass, ScopeManifest } from '@audivra/contracts'
import { evaluateUrl } from '../scope.ts'

/*
 * Normalization helpers for observations. The dedup key is `type:asset:subject` on normalized values, so
 * the same fact reported by different tools or runs collapses to one observation while provenance accrues.
 */

/** Normalizes an asset for a stable key: a URL has its host lower-cased and its fragment and trailing slash dropped; a bare host is lower-cased. */
export function normalizeAsset(asset: string): string {
  const trimmed = asset.trim()
  try {
    const url = new URL(trimmed)
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    let text = url.toString()
    if (text.endsWith('/') && url.pathname === '/') text = text.slice(0, -1)
    return text.slice(0, 2048)
  } catch {
    return trimmed.toLowerCase().slice(0, 2048)
  }
}

/** Normalizes a subject (technology/header/route/rule id): collapsed whitespace, lower-cased, bounded. */
export function normalizeSubject(subject: string): string {
  return subject.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 1024)
}

export function observationDedupeKey(type: string, asset: string, subject: string): string {
  return `${type}:${normalizeAsset(asset)}:${normalizeSubject(subject)}`
}

/**
 * Classifies a discovered destination against the engagement scope using the Phase 1 scope engine — the
 * one authority. A discovered target is never authorized by being observed; this is only a label.
 */
export function classifyDiscovered(manifest: ScopeManifest, url: string): ObservationScopeClass {
  const evaluation = evaluateUrl(manifest, url)
  if (evaluation.decision === 'allow') return 'in-scope' // a primary target or an explicitly included dependency
  if (evaluation.classification === 'third-party') return 'third-party'
  if (evaluation.classification === 'invalid') return 'unknown'
  return 'out-of-scope' // excluded, or a disallowed port/path/subdomain of a scoped host
}
