import { fetchUrl } from './http.ts'

export interface LinkCheck {
  url: string
  kind: 'page' | 'resource'
  internal: boolean
  status: number | null
  error: string | null
  /** broken: 4xx/5xx or network error on an internal link; blocked: likely bot protection (401/403/429 on external). */
  verdict: 'ok' | 'broken' | 'blocked' | 'redirect-loop'
  sources: string[]
  text: string
}

export interface LinkCheckSummary {
  checked: number
  totalTargets: number
  broken: LinkCheck[]
  blocked: LinkCheck[]
  skipped: number
}

function isInternal(url: string, origin: string): boolean {
  const strip = (h: string) => h.replace(/^www\./, '')
  try {
    return strip(new URL(url).hostname) === strip(new URL(origin).hostname)
  } catch {
    return false
  }
}

async function checkOne(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number | null; error: string | null }> {
  // HEAD first; many servers mishandle HEAD so fall back to GET (body discarded).
  const head = await fetchUrl(url, { method: 'HEAD', signal, timeoutMs: 12000, readBody: false })
  if (head.status !== null && ![403, 404, 405, 429, 500, 501, 503].includes(head.status)) return head
  const get = await fetchUrl(url, { method: 'GET', signal, timeoutMs: 15000, readBody: false })
  return get.status !== null || !head.status ? get : head
}

/** Checks unique link and resource targets (internal first), bounded by `maxChecks`. */
export async function checkLinks(
  targets: Map<string, { kind: 'page' | 'resource'; sources: Set<string>; text: string }>,
  origin: string,
  options: { maxChecks: number; concurrency?: number; signal?: AbortSignal },
): Promise<LinkCheckSummary> {
  const entries = [...targets.entries()].filter(([url]) => /^https?:/.test(url))
  entries.sort(([a], [b]) => Number(isInternal(b, origin)) - Number(isInternal(a, origin)))
  const selected = entries.slice(0, options.maxChecks)
  const results: LinkCheck[] = []
  let index = 0
  const worker = async () => {
    while (index < selected.length && !options.signal?.aborted) {
      const [url, meta] = selected[index++]!
      const internal = isInternal(url, origin)
      const { status, error } = await checkOne(url, options.signal)
      let verdict: LinkCheck['verdict'] = 'ok'
      if (error && /redirect/i.test(error)) verdict = 'redirect-loop'
      else if (status === null)
        verdict =
          internal || /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|CERT|certificate/i.test(error ?? '')
            ? 'broken'
            : 'blocked'
      else if (status >= 400)
        verdict = !internal && [401, 403, 429, 999].includes(status) ? 'blocked' : 'broken'
      results.push({
        url,
        kind: meta.kind,
        internal,
        status,
        error,
        verdict,
        sources: [...meta.sources].slice(0, 5),
        text: meta.text,
      })
    }
  }
  await Promise.all(Array.from({ length: options.concurrency ?? 6 }, worker))
  return {
    checked: results.length,
    totalTargets: entries.length,
    broken: results.filter((r) => r.verdict === 'broken' || r.verdict === 'redirect-loop'),
    blocked: results.filter((r) => r.verdict === 'blocked'),
    skipped: Math.max(0, entries.length - results.length),
  }
}
