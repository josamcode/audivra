import { createHash } from 'node:crypto'

/** Deep copy with object keys sorted and undefined members dropped (key order independent JSON). */
export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/** SHA-256 of the canonical JSON of a value; equal for values that survive a JSON(B) round trip unchanged. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}
