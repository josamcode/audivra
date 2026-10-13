/**
 * Sensitive-value handling shared by the security layer, persistence and the API.
 *
 * Two mechanisms, both deterministic:
 * - `SensitiveValue` wraps a secret so it cannot be serialized, logged or interpolated by accident
 *   (JSON, string conversion and Node's inspector all print a placeholder; only `reveal()` returns it).
 * - `redactSensitive()` deep-copies a value and replaces sensitive fields (by key) and recognizable
 *   secrets inside strings (bearer/basic credentials, JWTs, URL user-info, private keys, common API key
 *   formats, secret query parameters). It is applied where security records leave the engine: event and
 *   decision persistence, evidence, error messages, API responses and model context.
 *
 * Redaction is a safety net, not a vault: values that look like ordinary text are not detected.
 */

export const REDACTED = '[REDACTED]'

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

export class SensitiveValue<T = string> {
  readonly #value: T

  constructor(
    value: T,
    readonly label = 'secret',
  ) {
    this.#value = value
  }

  /** The only way to read the wrapped value. Call it at the point of use, never to log or store. */
  reveal(): T {
    return this.#value
  }

  toJSON(): string {
    return REDACTED
  }

  toString(): string {
    return REDACTED
  }

  [INSPECT](): string {
    return `SensitiveValue<${this.label}>(${REDACTED})`
  }
}

export function sensitive<T>(value: T, label?: string): SensitiveValue<T> {
  return new SensitiveValue(value, label)
}

/**
 * Field names whose string values are always redacted. Compared after removing separators and case,
 * against the end of the name: `x-api-key`, `db_password`, `Set-Cookie` and `refreshToken` match, while
 * structured fields such as `authorizationIds` or `tokenCount` do not.
 */
const SENSITIVE_KEY_SUFFIXES = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'secrets',
  'secretkey',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'authorization',
  'cookie',
  'cookies',
  'sessionid',
  'credential',
  'credentials',
  'bearer',
  'otp',
]

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

/**
 * Keys that hold raw secret *material* (not just a sensitive string): their whole subtree is redacted, so a
 * cookie object's `value` or a token field nested under them cannot slip through. Structural containers that
 * merely match a suffix — `authorization` (`{ state, authorizationIds }`), `sessionId` — are deliberately
 * excluded so their non-secret fields survive; a secret *string* directly under them is still redacted.
 */
const DEEP_SENSITIVE_KEY_SUFFIXES = ['password', 'passwd', 'passphrase', 'secret', 'secrets', 'secretkey', 'token', 'apikey', 'accesskey', 'privatekey', 'cookie', 'cookies', 'credential', 'credentials', 'bearer', 'otp']

function isDeepSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return DEEP_SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

const VALUE_PATTERNS: { pattern: RegExp; replace: string }[] = [
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replace: REDACTED },
  { pattern: /\b(Bearer|Basic|Digest)\s+[A-Za-z0-9\-._~+/]{6,}=*/gi, replace: `$1 ${REDACTED}` },
  { pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, replace: REDACTED },
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replace: `$1${REDACTED}@` },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, replace: REDACTED },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  {
    pattern: /([?&;](?:access_token|refresh_token|id_token|token|api_key|apikey|password|passwd|secret|client_secret|signature|sig)=)(?!\[REDACTED\])[^&#\s"']+/gi,
    replace: `$1${REDACTED}`,
  },
  {
    pattern: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)(["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"',;}&]+/gi,
    replace: `$1$2${REDACTED}`,
  },
]

export interface RedactionResult<T> {
  value: T
  /** Number of values replaced; recorded as redaction metadata on security records. */
  redactions: number
}

/** Redacts recognizable secrets inside a string. */
export function redactText(text: string): RedactionResult<string> {
  let redactions = 0
  let value = text
  for (const { pattern, replace } of VALUE_PATTERNS) {
    value = value.replace(pattern, (...args: unknown[]) => {
      redactions++
      const groups = args.slice(1, -2) as (string | undefined)[]
      return replace.replace(/\$(\d)/g, (_, index: string) => groups[Number(index) - 1] ?? '')
    })
  }
  return { value, redactions }
}

const MAX_DEPTH = 24

/** Deep copy of `input` with sensitive keys and recognizable secrets replaced by `[REDACTED]`. */
export function redactSensitive<T>(input: T): RedactionResult<T> {
  let redactions = 0
  /** Objects on the current path: a shared (non-cyclic) reference is copied, only a real cycle is cut. */
  const ancestors = new WeakSet<object>()

  /** `secretField`: the value sits under a sensitive key, so any string in it is a secret. */
  const visit = (value: unknown, depth: number, secretField = false): unknown => {
    if (value instanceof SensitiveValue) {
      redactions++
      return REDACTED
    }
    if (typeof value === 'string') {
      if (secretField && value !== '') {
        redactions++
        return REDACTED
      }
      const result = redactText(value)
      redactions += result.redactions
      return result.value
    }
    if (value === null || typeof value !== 'object') return value
    if (value instanceof Date) return value
    if (depth >= MAX_DEPTH) return '[Truncated]'
    if (ancestors.has(value)) return '[Circular]'
    if (value instanceof Error) return { name: value.name, message: visit(value.message, depth + 1) }
    ancestors.add(value)
    try {
      if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1, secretField))
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        // A secret string is redacted under any sensitive key; a whole subtree is redacted only under a
        // material-bearing key (so `cookies[].value` goes, but `authorization.authorizationIds` survives).
        out[key] = typeof item === 'string' ? visit(item, depth + 1, secretField || isSensitiveKey(key)) : visit(item, depth + 1, secretField || isDeepSensitiveKey(key))
      }
      return out
    } finally {
      ancestors.delete(value)
    }
  }

  return { value: visit(input, 0) as T, redactions }
}

/** `redactSensitive` without the count. */
export function redact<T>(input: T): T {
  return redactSensitive(input).value
}
