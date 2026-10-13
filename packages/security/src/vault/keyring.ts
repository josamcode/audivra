import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getConfig, securityDir, type Logger } from '@audivra/config'
import type { VaultHealth, VaultState } from '@audivra/contracts'

/*
 * The vault keyring and envelope cryptography. Secrets are sealed with AES-256-GCM (authenticated
 * encryption): the GCM tag detects tampering, and the format version + key id are bound as additional
 * authenticated data so neither can be altered. The envelope is a versioned string
 * `av1.<keyId>.<iv>.<tag>.<ciphertext>` (all base64) — the only secret-bearing value Audivra persists, and
 * it is useless without the key, which lives OUTSIDE the database. A keyring can hold several keys (each by
 * its non-secret fingerprint) so an old key still decrypts after rotation while a new active key seals.
 */

const FORMAT = 'av1'
const KEY_BYTES = 32
const IV_BYTES = 12

export class VaultError extends Error {
  constructor(
    readonly code: 'unavailable' | 'unknown-key' | 'tampered' | 'malformed',
    message: string,
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

export interface Keyring {
  state: VaultState
  source: VaultHealth['source']
  activeKeyId: string | null
  /** keyId → raw 32-byte key. Never logged or serialized. */
  keys: Map<string, Buffer>
  detail: string | null
}

/** Non-secret fingerprint of a key (first 12 hex of its SHA-256), used as the stored key id. */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

/** Parses a 32-byte key from hex (64 chars) or base64; null when it is not exactly 32 bytes. */
export function parseKeyMaterial(text: string): Buffer | null {
  const t = text.trim()
  if (/^[0-9a-f]{64}$/i.test(t)) return Buffer.from(t, 'hex')
  try {
    const b = Buffer.from(t, 'base64')
    if (b.length === KEY_BYTES) return b
  } catch {
    /* not base64 */
  }
  return null
}

/** Builds a keyring from explicit key material (used by tests and by key rotation). */
export function keyringFromKeys(entries: { key: Buffer; id?: string }[], activeId?: string): Keyring {
  const keys = new Map<string, Buffer>()
  for (const e of entries) keys.set(e.id ?? keyFingerprint(e.key), e.key)
  const active = activeId ?? (entries[0] ? (entries[0].id ?? keyFingerprint(entries[0].key)) : null)
  return { state: active ? 'ready' : 'unavailable', source: 'env', activeKeyId: active, keys, detail: active ? null : 'No encryption key provided' }
}

function readKeyFile(file: string): { keys: Map<string, Buffer>; active: string | null } {
  const json = JSON.parse(readFileSync(file, 'utf8')) as { active?: string; keys?: Record<string, string> }
  const keys = new Map<string, Buffer>()
  for (const [id, material] of Object.entries(json.keys ?? {})) {
    const key = parseKeyMaterial(material)
    if (key) keys.set(id, key)
  }
  return { keys, active: json.active && keys.has(json.active) ? json.active : (keys.keys().next().value ?? null) }
}

/**
 * Loads the keyring from configuration. Priority: a key file (for rotation), then `AUDIVRA_SECRET_KEY`
 * (the active key in production), then — only when neither is set (local development) — a persisted dev key
 * file under the data directory. The dev key is generated once and never regenerated, so stored secrets stay
 * recoverable. A missing/invalid key yields an `unavailable`/`misconfigured` keyring, never a silent reset.
 */
export function loadKeyring(options: { log?: Logger; allowDevKey?: boolean } = {}): Keyring {
  const config = getConfig()
  const keys = new Map<string, Buffer>()
  let active: string | null = null
  let source: VaultHealth['source'] = 'none'

  if (config.AUDIVRA_SECRET_KEY_FILE) {
    try {
      const loaded = readKeyFile(config.AUDIVRA_SECRET_KEY_FILE)
      for (const [id, key] of loaded.keys) keys.set(id, key)
      active = loaded.active
      source = 'key-file'
    } catch (error) {
      return { state: 'misconfigured', source: 'key-file', activeKeyId: null, keys: new Map(), detail: `Could not read AUDIVRA_SECRET_KEY_FILE: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  if (config.AUDIVRA_SECRET_KEY) {
    const key = parseKeyMaterial(config.AUDIVRA_SECRET_KEY)
    if (!key) return { state: 'misconfigured', source: 'env', activeKeyId: null, keys, detail: 'AUDIVRA_SECRET_KEY must be 32 bytes as base64 or hex' }
    const id = keyFingerprint(key)
    keys.set(id, key)
    active = id
    if (source !== 'key-file') source = 'env'
  }

  if (!active && !config.AUDIVRA_SECRET_KEY && !config.AUDIVRA_SECRET_KEY_FILE) {
    const devFile = path.join(securityDir(), '.vault-key.json')
    try {
      if (existsSync(devFile)) {
        const loaded = readKeyFile(devFile)
        for (const [id, key] of loaded.keys) keys.set(id, key)
        active = loaded.active
        source = 'dev-file'
      } else if (options.allowDevKey !== false) {
        const key = randomBytes(KEY_BYTES)
        const id = keyFingerprint(key)
        mkdirSync(path.dirname(devFile), { recursive: true })
        writeFileSync(devFile, JSON.stringify({ active: id, keys: { [id]: key.toString('base64') } }, null, 2), 'utf8')
        try {
          chmodSync(devFile, 0o600)
        } catch {
          /* best effort on platforms without POSIX modes */
        }
        keys.set(id, key)
        active = id
        source = 'dev-file'
        options.log?.warn({ devFile }, 'generated a development vault key; set AUDIVRA_SECRET_KEY from a real secrets source in production')
      }
    } catch (error) {
      return { state: 'misconfigured', source: 'dev-file', activeKeyId: null, keys: new Map(), detail: `Could not prepare a development vault key: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  if (!active) return { state: 'unavailable', source, activeKeyId: null, keys, detail: 'No encryption key is configured (set AUDIVRA_SECRET_KEY)' }
  return { state: 'ready', source, activeKeyId: active, keys, detail: null }
}

export function keyringHealth(keyring: Keyring): VaultHealth {
  return { state: keyring.state, activeKeyId: keyring.activeKeyId, keyIds: [...keyring.keys.keys()], source: keyring.source, detail: keyring.detail }
}

/** Seals plaintext with the active key. Throws `VaultError('unavailable')` when no key is ready. */
export function seal(keyring: Keyring, plaintext: string): string {
  if (keyring.state !== 'ready' || !keyring.activeKeyId) throw new VaultError('unavailable', 'The credential vault is unavailable (no encryption key)')
  const key = keyring.keys.get(keyring.activeKeyId)!
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${FORMAT}.${keyring.activeKeyId}`))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${FORMAT}.${keyring.activeKeyId}.${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`
}

/** Opens a sealed value. Throws on an unknown key, a malformed envelope, or any tampering (GCM auth). */
export function open(keyring: Keyring, sealed: string): string {
  const parts = sealed.split('.')
  if (parts.length !== 5 || parts[0] !== FORMAT) throw new VaultError('malformed', 'Malformed sealed value')
  const [, keyId, ivB64, tagB64, ctB64] = parts
  const key = keyring.keys.get(keyId!)
  if (!key) throw new VaultError('unknown-key', `No key ${keyId} is available to decrypt this value`)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64!, 'base64'))
  decipher.setAAD(Buffer.from(`${FORMAT}.${keyId}`))
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64!, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new VaultError('tampered', 'Sealed value failed authentication (wrong key or tampered ciphertext)')
  }
}

/** The key id a sealed value was encrypted under (for rotation reporting); null when malformed. */
export function sealedKeyId(sealed: string): string | null {
  const parts = sealed.split('.')
  return parts.length === 5 && parts[0] === FORMAT ? (parts[1] ?? null) : null
}
