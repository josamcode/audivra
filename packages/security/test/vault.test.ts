import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { redact, redactSensitive, sensitive, SensitiveValue } from '@audivra/contracts'
import { keyFingerprint, keyringFromKeys, open, parseKeyMaterial, seal, sealedKeyId, VaultError } from '../src/index.ts'

/*
 * The vault cryptography: authenticated encryption round trips, tamper and wrong-key detection, the
 * versioned envelope, key rotation, and the redaction guarantees that keep resolved secrets out of logs and
 * serialized state.
 */

const keyA = randomBytes(32)
const keyB = randomBytes(32)
const ringA = keyringFromKeys([{ key: keyA }])

describe('envelope cryptography', () => {
  it('seals and opens with the active key, using the versioned format', () => {
    const sealed = seal(ringA, 'hunter2-the-secret')
    expect(sealed.startsWith('av1.')).toBe(true)
    expect(sealed).not.toContain('hunter2-the-secret')
    expect(sealedKeyId(sealed)).toBe(keyFingerprint(keyA))
    expect(open(ringA, sealed)).toBe('hunter2-the-secret')
  })

  it('refuses the wrong key and detects tampering', () => {
    const sealed = seal(ringA, 'top-secret-token')
    // A keyring with a different key under the SAME id (impossible in practice) still fails the GCM tag.
    const forged = keyringFromKeys([{ key: keyB, id: keyFingerprint(keyA) }])
    expect(() => open(forged, sealed)).toThrow(VaultError)
    expect(() => open(forged, sealed)).toThrow(/wrong key or tampered/)

    // A key the keyring does not hold at all.
    expect(() => open(keyringFromKeys([{ key: keyB }]), sealed)).toThrow(/No key .* available/)

    // Flip one ciphertext byte → authentication fails, never a partial/garbage decrypt.
    const parts = sealed.split('.')
    const ct = Buffer.from(parts[4]!, 'base64')
    ct[0] = (ct[0] ?? 0) ^ 0xff
    parts[4] = ct.toString('base64')
    expect(() => open(ringA, parts.join('.'))).toThrow(/tampered/)

    // Tamper the bound key id (AAD) → also fails.
    const swapped = [parts[0], 'deadbeefdead', ...sealed.split('.').slice(2)].join('.')
    expect(() => open(ringA, swapped)).toThrow(VaultError)

    expect(() => open(ringA, 'not-an-envelope')).toThrow(/Malformed/)
    expect(() => open(ringA, 'xx.1.2.3.4')).toThrow(/Malformed/)
  })

  it('refuses to seal when no key is available', () => {
    const empty = keyringFromKeys([])
    expect(empty.state).toBe('unavailable')
    expect(() => seal(empty, 'x')).toThrow(/unavailable/)
  })

  it('parses 32-byte keys from hex and base64, and rejects others', () => {
    expect(parseKeyMaterial(keyA.toString('hex'))).toEqual(keyA)
    expect(parseKeyMaterial(keyA.toString('base64'))).toEqual(keyA)
    expect(parseKeyMaterial('too-short')).toBeNull()
    expect(parseKeyMaterial(randomBytes(16).toString('base64'))).toBeNull()
  })

  it('supports rotation: a new active key seals while an old key still decrypts', () => {
    const old = seal(ringA, 'old-value')
    // Rotate: B is active, A kept for decryption of existing values.
    const rotated = keyringFromKeys([{ key: keyB }, { key: keyA }], keyFingerprint(keyB))
    expect(rotated.activeKeyId).toBe(keyFingerprint(keyB))
    expect(open(rotated, old)).toBe('old-value') // old still decryptable
    const fresh = seal(rotated, 'new-value')
    expect(sealedKeyId(fresh)).toBe(keyFingerprint(keyB)) // new values use the active key
    expect(open(rotated, fresh)).toBe('new-value')
  })
})

describe('secret redaction guarantees', () => {
  it('a wrapped secret never serializes or logs its value', () => {
    const wrapped = sensitive({ type: 'bearer-token', token: 'abcdef-canary-123' }, 'cred:alice')
    expect(wrapped).toBeInstanceOf(SensitiveValue)
    expect(JSON.stringify({ secret: wrapped })).not.toContain('abcdef-canary-123')
    expect(`${wrapped}`).toBe('[REDACTED]')
    expect(redact({ resolved: wrapped })).toEqual({ resolved: '[REDACTED]' })
    // Only reveal() returns the value, at the point of use.
    expect(wrapped.reveal()).toMatchObject({ token: 'abcdef-canary-123' })
  })

  it('redacts credential-shaped fields and recognizable secrets', () => {
    const r = redactSensitive({ username: 'alice', password: 'p@ss-canary', token: 'tok-canary', cookies: [{ name: 's', value: 'sess-canary' }], header: 'Authorization: Bearer canarybearer123456' })
    const json = JSON.stringify(r.value)
    for (const marker of ['p@ss-canary', 'tok-canary', 'sess-canary', 'canarybearer123456']) expect(json, marker).not.toContain(marker)
    expect(r.value).toMatchObject({ username: 'alice' })
  })
})
