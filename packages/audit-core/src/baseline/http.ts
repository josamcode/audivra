import tls from 'node:tls'

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Audivra/0.1'

export interface RedirectHop {
  url: string
  status: number
  location: string | null
}

export interface FetchResult {
  requestedUrl: string
  finalUrl: string
  status: number | null
  headers: Record<string, string>
  setCookies: string[]
  redirects: RedirectHop[]
  contentType: string | null
  body: string | null
  bytes: number
  timingMs: number
  error: string | null
}

export interface FetchOptions {
  method?: 'GET' | 'HEAD'
  timeoutMs?: number
  signal?: AbortSignal
  maxBytes?: number
  readBody?: boolean
  maxRedirects?: number
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause
    if (cause?.code) return `${error.message} (${cause.code})`
    if (cause?.message) return `${error.message}: ${cause.message}`
    return error.message
  }
  return String(error)
}

async function readLimited(response: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  if (!response.body) return { text: '', bytes: 0 }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes <= maxBytes) chunks.push(value)
    else {
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes }
}

/** Fetches a URL following redirects manually so the full redirect chain is recorded. */
export async function fetchUrl(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const started = Date.now()
  const redirects: RedirectHop[] = []
  const maxRedirects = options.maxRedirects ?? 10
  let current = url
  try {
    for (let hop = 0; ; hop++) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 20000)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      const response = await fetch(current, {
        method: options.method ?? 'GET',
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en,ar;q=0.8',
        },
      })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location && hop < maxRedirects) {
        redirects.push({ url: current, status: response.status, location })
        await response.body?.cancel().catch(() => undefined)
        current = new URL(location, current).toString()
        continue
      }
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') headers[key] = value
      })
      const contentType = response.headers.get('content-type')
      const wantBody =
        options.readBody !== false &&
        options.method !== 'HEAD' &&
        (!contentType || /text|html|xml|json/i.test(contentType))
      const body = wantBody ? await readLimited(response, options.maxBytes ?? 5_000_000) : null
      if (!wantBody) await response.body?.cancel().catch(() => undefined)
      return {
        requestedUrl: url,
        finalUrl: current,
        status: response.status,
        headers,
        setCookies: response.headers.getSetCookie(),
        redirects,
        contentType,
        body: body?.text ?? null,
        bytes: body?.bytes ?? Number(response.headers.get('content-length') ?? 0),
        timingMs: Date.now() - started,
        error: null,
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw error
    return {
      requestedUrl: url,
      finalUrl: current,
      status: null,
      headers: {},
      setCookies: [],
      redirects,
      contentType: null,
      body: null,
      bytes: 0,
      timingMs: Date.now() - started,
      error: errorMessage(error),
    }
  }
}

export interface TlsInfo {
  host: string
  protocol: string | null
  cipher: string | null
  authorized: boolean
  authorizationError: string | null
  subject: string | null
  issuer: string | null
  validFrom: string | null
  validTo: string | null
  daysRemaining: number | null
  altNames: string[]
}

/** Passive TLS handshake to read protocol, cipher and certificate details. */
export function getTlsInfo(host: string, port = 443, timeoutMs = 10000): Promise<TlsInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate()
        const cipher = socket.getCipher()
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null
        const info: TlsInfo = {
          host,
          protocol: socket.getProtocol(),
          cipher: cipher?.name ?? null,
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          subject: cert?.subject?.CN ? String(cert.subject.CN) : null,
          issuer: cert?.issuer ? [cert.issuer.O, cert.issuer.CN].filter(Boolean).join(' / ') : null,
          validFrom: cert?.valid_from ?? null,
          validTo: cert?.valid_to ?? null,
          daysRemaining: validTo ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000) : null,
          altNames: (cert?.subjectaltname ?? '')
            .split(',')
            .map((s) => s.trim().replace(/^DNS:/, ''))
            .filter(Boolean)
            .slice(0, 20),
        }
        socket.end()
        resolve(info)
      },
    )
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('TLS handshake timed out'))
    })
    socket.on('error', reject)
  })
}

const SECURITY_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
] as const

export interface CookieFacts {
  name: string
  secure: boolean
  httpOnly: boolean
  sameSite: string | null
}

export interface SecurityHeaderFacts {
  present: Record<string, string>
  missing: string[]
  disclosure: Record<string, string>
  cookies: CookieFacts[]
}

/** Records which security-relevant headers are present. Facts only — interpretation is left to the auditor. */
export function securityHeaderFacts(
  headers: Record<string, string>,
  setCookies: string[],
): SecurityHeaderFacts {
  const present: Record<string, string> = {}
  const missing: string[] = []
  for (const name of SECURITY_HEADERS) {
    if (headers[name]) present[name] = headers[name].slice(0, 500)
    else if (name !== 'content-security-policy-report-only' && name !== 'cross-origin-resource-policy')
      missing.push(name)
  }
  const disclosure: Record<string, string> = {}
  for (const name of ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator']) {
    if (headers[name]) disclosure[name] = headers[name]
  }
  const cookies = setCookies.map((raw) => {
    const parts = raw.split(';').map((p) => p.trim())
    const name = parts[0]?.split('=')[0] ?? ''
    const attrs = parts.slice(1).map((p) => p.toLowerCase())
    const sameSite = attrs.find((a) => a.startsWith('samesite='))?.split('=')[1] ?? null
    return { name, secure: attrs.includes('secure'), httpOnly: attrs.includes('httponly'), sameSite }
  })
  return { present, missing, disclosure, cookies }
}
