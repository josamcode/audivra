import pino, { type Logger, type LoggerOptions } from 'pino'
import { getConfig } from './env.ts'

let root: Logger | undefined

const SECRET_FIELDS = ['password', 'passwd', 'secret', 'token', 'apiKey', 'api_key', 'accessToken', 'refreshToken', 'authorization', 'cookie', 'credentials', 'privateKey']

/**
 * Structured fields never written to logs, at the top level and up to two levels deep (e.g.
 * `headers.authorization`, `request.headers.cookie`). Security records are additionally redacted by
 * value before they are logged or stored (`redactSensitive` in @audivra/contracts).
 */
const HEADER_FIELDS = ['set-cookie', 'proxy-authorization', 'x-api-key']

export const LOG_REDACT_PATHS = [
  ...SECRET_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]),
  ...HEADER_FIELDS.flatMap((field) => [`headers["${field}"]`, `*.headers["${field}"]`]),
]

/** Logger options shared by the app logger and tests (no transport). */
export function loggerOptions(): LoggerOptions {
  return {
    level: getConfig().LOG_LEVEL,
    base: { service: process.env.AUDIVRA_SERVICE ?? 'audivra' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
  }
}

export function getLogger(): Logger {
  if (root) return root
  const pretty = process.env.LOG_FORMAT !== 'json' && process.env.NODE_ENV !== 'production'
  root = pino({
    ...loggerOptions(),
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  })
  return root
}

export type { Logger }
