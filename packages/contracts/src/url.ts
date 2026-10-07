export type NormalizedUrl =
  { ok: true; url: string; origin: string; domain: string } | { ok: false; error: string }

/**
 * Validates and normalizes a user-supplied audit target.
 * Accepts bare domains ("example.com"), only allows http(s), strips credentials and fragments.
 */
export function normalizeTargetUrl(input: string): NormalizedUrl {
  const raw = input.trim()
  if (!raw) return { ok: false, error: 'URL is empty' }
  if (raw.length > 2048) return { ok: false, error: 'URL is too long' }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return { ok: false, error: 'URL is not valid' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https URLs can be audited' }
  }
  if (!parsed.hostname || /\s/.test(parsed.hostname)) return { ok: false, error: 'URL has no valid host' }
  const isIp = /^[\d.]+$/.test(parsed.hostname) || parsed.hostname.includes(':')
  if (!isIp && parsed.hostname !== 'localhost' && !parsed.hostname.includes('.')) {
    return { ok: false, error: 'URL host must be a domain name' }
  }
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  return { ok: true, url: parsed.toString(), origin: parsed.origin, domain: parsed.host }
}
