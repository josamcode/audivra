import pino, { type Logger } from 'pino'
import { getConfig } from './env.ts'

let root: Logger | undefined

export function getLogger(): Logger {
  if (root) return root
  const { LOG_LEVEL } = getConfig()
  const pretty = process.env.LOG_FORMAT !== 'json' && process.env.NODE_ENV !== 'production'
  root = pino({
    level: LOG_LEVEL,
    base: { service: process.env.AUDIVRA_SERVICE ?? 'audivra' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  })
  return root
}

export type { Logger }
