import { z } from 'zod'

/**
 * Explicit audit coverage: every capability states whether it ran and, if not, why.
 * Nothing is silently omitted.
 */
export const CAPABILITIES = [
  { id: 'crawl', label: 'Crawl & discovery' },
  { id: 'links', label: 'Broken links & resources' },
  { id: 'performance', label: 'Performance (Lighthouse)' },
  { id: 'seo', label: 'Technical SEO' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'browser', label: 'Real-browser review' },
  { id: 'mobile', label: 'Mobile layout' },
  { id: 'tracking', label: 'Tracking & analytics' },
  { id: 'localization', label: 'Localization (lang/dir/hreflang)' },
  { id: 'technology', label: 'Technology detection' },
  { id: 'security-headers', label: 'HTTP security headers' },
  { id: 'tls', label: 'TLS / certificate' },
  { id: 'passive-scan', label: 'Passive security scan (ZAP)' },
  { id: 'ai-investigation', label: 'AI investigation' },
  { id: 'ai-review', label: 'AI review & verification' },
  { id: 'visuals', label: 'Visual report artifacts' },
] as const
export type CapabilityId = (typeof CAPABILITIES)[number]['id']
export const CAPABILITY_IDS = CAPABILITIES.map((c) => c.id) as [CapabilityId, ...CapabilityId[]]

export const COVERAGE_STATUSES = ['ran', 'partial', 'skipped', 'failed', 'unavailable', 'not-applicable'] as const
export const CoverageStatus = z.enum(COVERAGE_STATUSES)
export type CoverageStatus = z.infer<typeof CoverageStatus>

export const CoverageItem = z.object({
  capability: z.enum(CAPABILITY_IDS),
  label: z.string(),
  status: CoverageStatus,
  /** Tools that contributed (e.g. "lighthouse", "zap"). */
  tools: z.array(z.string()),
  /** Why it did not fully run; null when it ran. */
  reason: z.string().nullable(),
  /** Short scope note, e.g. "4 pages, desktop + mobile". */
  detail: z.string().nullable(),
})
export type CoverageItem = z.infer<typeof CoverageItem>

export function capabilityLabel(id: CapabilityId): string {
  return CAPABILITIES.find((c) => c.id === id)?.label ?? id
}
