import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { loggerOptions } from '../src/index.ts'

describe('logger redaction', () => {
  it('never writes credential fields to logs', () => {
    const lines: string[] = []
    const log = pino(loggerOptions(), { write: (line: string) => lines.push(line) })
    log.warn(
      {
        password: 'p@ss',
        headers: { authorization: 'Bearer abc', 'set-cookie': ['sid=1'], 'x-api-key': 'k1' },
        request: { headers: { cookie: 'sid=2' } },
        target: { apiKey: 'k2', token: 't1' },
        status: 401,
      },
      'request failed',
    )
    const output = lines.join('')
    for (const secret of ['p@ss', 'Bearer abc', 'sid=1', 'sid=2', 'k1', 'k2', 't1']) expect(output).not.toContain(secret)
    expect(JSON.parse(output)).toMatchObject({ status: 401, msg: 'request failed', password: '[REDACTED]' })
  })
})
