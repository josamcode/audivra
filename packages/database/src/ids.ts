import { customAlphabet } from 'nanoid'

const alphabet = '0123456789abcdefghijkmnpqrstuvwxyz'
const shortId = customAlphabet(alphabet, 10)

/** Audit IDs appear in URLs and directory names, so they are short and filesystem-safe. */
export function newAuditId(): string {
  return shortId()
}

export function newId(prefix: string): string {
  return `${prefix}_${customAlphabet(alphabet, 14)()}`
}
