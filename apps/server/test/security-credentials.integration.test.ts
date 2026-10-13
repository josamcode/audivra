import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, resetConfig } from '@audivra/config'
import type { CredentialMetadata, SessionMetadata, VaultHealth } from '@audivra/contracts'
import { createBoss, ensureQueues, type PgBoss } from '@audivra/database'
import {
  createRuntimeRegistry,
  DomainService,
  GraphService,
  keyringFromKeys,
  loadKnowledge,
  researcherContext,
  SecretVault,
  SecurityService,
  VaultError,
  type Resolver,
} from '@audivra/security'
import { buildApp } from '../src/app.ts'
import { resetDb, testDb } from '../../../test/helpers.ts'

/*
 * Phase 5 Step 2 on the real database: credentials are encrypted at rest, referenced opaquely, resolvable
 * only by trusted code, and never leak. The required canary test proves a distinctive secret marker reaches
 * none of the model-/user-/log-facing surfaces. Wrong/missing keys fail safely; the same key across a
 * "restart" still decrypts.
 */

const KEY = randomBytes(32)
const handle = testDb()
const { db, pool } = handle
const user = { kind: 'user' as const, id: 'local-user', agentRunId: null }
const resolver: Resolver = async () => ['127.0.0.1']
const service = new SecurityService({ db, resolver })
const domain = new DomainService({ db })
const graph = new GraphService({ db })
/** A vault with the known key, for trusted-resolution assertions (the API uses the same key via env). */
const vault = new SecretVault({ db, keyring: keyringFromKeys([{ key: KEY }]) })
const registry = createRuntimeRegistry()
const ORIGIN = 'http://127.0.0.1:4788'

let boss: PgBoss
let app: Awaited<ReturnType<typeof buildApp>>
const logs: string[] = []

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; body: T; text: string }> {
  const r = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) })
  return { status: r.statusCode, body: (r.headers['content-type']?.includes('json') ? r.json() : null) as T, text: r.body }
}

async function engagement(name: string): Promise<string> {
  return (await service.createEngagement({ name, targetUrl: `${ORIGIN}/`, environment: 'staging' }, user)).id
}

beforeAll(async () => {
  // The API vault and the test vault must share one key. Set it in the env before the app is built.
  process.env.AUDIVRA_SECRET_KEY = KEY.toString('base64')
  resetConfig()
  boss = createBoss(process.env.DATABASE_URL!)
  await boss.start()
  await ensureQueues(boss)
  // A capturing logger so we can prove no secret ever reaches the logs.
  const log = createLogger({ write: (chunk: string) => void logs.push(chunk) })
  app = await buildApp({ db, boss, hub: null, log, security: service })
})

afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: false })
  await handle.close()
  delete process.env.AUDIVRA_SECRET_KEY
  resetConfig()
})

beforeEach(async () => {
  await resetDb(handle)
  await pool.query('truncate security_engagements cascade')
})

describe('credential vault', () => {
  it('encrypts at rest, exposes metadata only, and resolves only through trusted code', async () => {
    const e = await engagement('vault basics')
    const secret = `CANARY-${randomBytes(8).toString('hex')}`
    const created = await api<CredentialMetadata>('POST', `/api/security/engagements/${e}/credentials`, { ref: 'alice-cred', identityRef: 'alice', secret: { type: 'username-password', username: 'alice', password: secret } })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ ref: 'alice-cred', type: 'username-password', status: 'active', configured: true })
    expect(created.text).not.toContain(secret)

    // At rest: the row holds only a sealed envelope, never the plaintext.
    const row = (await pool.query('select * from security_credentials where engagement_id = $1', [e])).rows[0]
    expect(JSON.stringify(row)).not.toContain(secret)
    expect(row.sealed).toMatch(/^av1\./)
    expect(row.sealed).not.toContain(secret)

    // The read API returns metadata only.
    expect((await api(`GET` as const, `/api/security/engagements/${e}/credentials`)).text).not.toContain(secret)
    expect((await api<CredentialMetadata[]>('GET', `/api/security/engagements/${e}/credentials`)).body[0]).not.toHaveProperty('sealed')
    expect((await api<CredentialMetadata>('GET', `/api/security/credentials/${created.body.id}`)).body.configured).toBe(true)

    // There is no endpoint that returns a plaintext secret.
    expect((await api('GET', `/api/security/credentials/${created.body.id}/plaintext`)).status).toBe(404)
    expect((await api('GET', `/api/security/credentials/${created.body.id}/secret`)).status).toBe(404)

    // Trusted resolution returns the real secret, wrapped so it cannot be logged by accident.
    const resolved = await vault.resolveCredentialByRef(e, 'alice-cred')
    expect(resolved?.secret.reveal()).toMatchObject({ username: 'alice', password: secret })
    expect(JSON.stringify(resolved)).not.toContain(secret)
    expect(await vault.resolveCredentialByRef(e, 'does-not-exist')).toBeNull()
  })

  it('replaces (old value gone), revokes and deletes (blocking resolution), leaving the identity intact', async () => {
    const e = await engagement('lifecycle')
    await domain.declare(e, { kind: 'identity', ref: 'alice', spec: { credentialRef: 'alice-cred' } }, user)
    const first = `CANARY-${randomBytes(6).toString('hex')}`
    const created = await api<CredentialMetadata>('POST', `/api/security/engagements/${e}/credentials`, { ref: 'alice-cred', identityRef: 'alice', secret: { type: 'bearer-token', token: first } })
    expect((await vault.resolveCredentialByRef(e, 'alice-cred'))?.secret.reveal()).toMatchObject({ token: first })

    const second = `CANARY-${randomBytes(6).toString('hex')}`
    await api('PUT', `/api/security/credentials/${created.body.id}`, { secret: { type: 'bearer-token', token: second } })
    const afterReplace = await vault.resolveCredentialByRef(e, 'alice-cred')
    expect(afterReplace?.secret.reveal()).toMatchObject({ token: second }) // old value is gone

    expect((await api<CredentialMetadata>('POST', `/api/security/credentials/${created.body.id}/revoke`)).body.status).toBe('revoked')
    expect(await vault.resolveCredentialByRef(e, 'alice-cred')).toBeNull() // revoked → no resolution

    expect((await api<{ deleted: boolean }>('DELETE', `/api/security/credentials/${created.body.id}`)).body.deleted).toBe(true)
    expect(await vault.resolveCredentialByRef(e, 'alice-cred')).toBeNull()
    // The identity declaration is untouched.
    const identities = await domain.list(e, 'identity')
    expect(identities.map((d) => d.ref)).toEqual(['alice'])
  })

  it('refuses agents, and never resolves an expired credential', async () => {
    const e = await engagement('guards')
    await expect(vault.setCredential(e, { ref: 'x', secret: { type: 'bearer-token', token: 't' } }, { kind: 'agent', id: 'a', agentRunId: 'r' })).rejects.toThrow(/Agents cannot/)
    await vault.setCredential(e, { ref: 'expired', secret: { type: 'bearer-token', token: 'CANARY-expired' }, expiresAt: new Date(Date.now() - 1000).toISOString() }, user)
    expect(await vault.resolveCredentialByRef(e, 'expired')).toBeNull()
  })

  it('fails safely with a wrong key and keeps decryptability across a restart with the same key', async () => {
    const e = await engagement('keys')
    const secret = `CANARY-${randomBytes(6).toString('hex')}`
    await vault.setCredential(e, { ref: 'k', secret: { type: 'bearer-token', token: secret } }, user)

    // Wrong key → a safe explicit error, never a garbage/partial decrypt.
    const wrong = new SecretVault({ db, keyring: keyringFromKeys([{ key: randomBytes(32) }]) })
    await expect(wrong.resolveCredentialByRef(e, 'k')).rejects.toThrow(VaultError)

    // A fresh vault configured with the SAME key (a "restart") decrypts the stored value.
    const restarted = new SecretVault({ db, keyring: keyringFromKeys([{ key: KEY }]) })
    expect((await restarted.resolveCredentialByRef(e, 'k'))?.secret.reveal()).toMatchObject({ token: secret })

    // A vault with no key is unavailable and refuses to seal — it never resets stored data.
    const empty = new SecretVault({ db, keyring: keyringFromKeys([]) })
    const health: VaultHealth = empty.health()
    expect(health.state).toBe('unavailable')
    await expect(empty.setCredential(e, { ref: 'z', secret: { type: 'bearer-token', token: 't' } }, user)).rejects.toThrow(/unavailable/)
    // The non-secret data is still readable, and the stored credential survives.
    expect((await service.getEngagement(e)).id).toBe(e)
    expect((await restarted.resolveCredentialByRef(e, 'k'))?.secret.reveal()).toMatchObject({ token: secret })
  })

  it('separates session metadata from sealed session material', async () => {
    const e = await engagement('sessions')
    const marker = `CANARY-${randomBytes(6).toString('hex')}`
    const session = await vault.createSession(e, { identityRef: 'alice', environment: 'staging', authMethod: 'form', material: { bearerToken: marker, cookies: [{ name: 'sid', value: `${marker}-cookie` }] } }, user)
    expect(session.material).toBe(true)
    expect(JSON.stringify(session)).not.toContain(marker)

    const rows = (await api<SessionMetadata[]>('GET', `/api/security/engagements/${e}/sessions`)).body
    expect(rows[0]).toMatchObject({ identityRef: 'alice', status: 'pending', material: true })
    const row = (await pool.query('select * from security_sessions where engagement_id = $1', [e])).rows[0]
    expect(JSON.stringify(row)).not.toContain(marker)

    expect((await vault.resolveSessionMaterial(session.id))?.reveal()).toMatchObject({ bearerToken: marker })
    await vault.revokeSession(session.id, user)
    expect(await vault.resolveSessionMaterial(session.id)).toBeNull() // revoked drops the material
  })

  it('CANARY: a stored secret reaches no model-, user- or log-facing surface', async () => {
    const start = logs.length
    const e = await engagement('canary')
    const pwd = `CANARY-${randomBytes(12).toString('hex')}`
    const cookie = `CANARY-${randomBytes(12).toString('hex')}`

    await domain.declare(e, { kind: 'identity', ref: 'alice', spec: { identityType: 'admin', credentialRef: 'alice-cred' } }, user)
    await api('POST', `/api/security/engagements/${e}/credentials`, { ref: 'alice-cred', identityRef: 'alice', secret: { type: 'username-password', username: 'alice', password: pwd } })
    await vault.createSession(e, { identityRef: 'alice', environment: 'staging', authMethod: 'form', material: { cookies: [{ name: 'sid', value: cookie }] } }, user)
    // A deliberately malformed write, to be sure a validation error never echoes a secret.
    await api('POST', `/api/security/engagements/${e}/credentials`, { ref: 'bad', secret: { type: 'username-password', username: 'x' } })
    await graph.project(e)

    // Build the model-facing context for this engagement.
    const view = await loadKnowledge(db, e, registry)
    const ctx = researcherContext(view)
    const identityNode = (await graph.nodes(e, { kind: 'identity' }))[0]!
    expect(identityNode.attributes).toMatchObject({ credentialConfigured: true }) // the graph shows configured, not the secret

    // Collect every surface and assert neither marker appears anywhere.
    const surfaces = {
      apiCredentials: (await api('GET', `/api/security/engagements/${e}/credentials`)).text,
      apiSessions: (await api('GET', `/api/security/engagements/${e}/sessions`)).text,
      apiEngagement: (await api('GET', `/api/security/engagements/${e}`)).text,
      events: JSON.stringify(await service.listEvents(e)),
      evidence: JSON.stringify(await service.listEvidence(e)),
      observations: JSON.stringify(await service.listObservations(e)),
      declarations: JSON.stringify(await domain.list(e)),
      graphNodes: JSON.stringify(await graph.nodes(e)),
      graphRows: JSON.stringify((await pool.query('select * from security_graph_nodes where engagement_id = $1', [e])).rows),
      aiContext: JSON.stringify(ctx.context) + ctx.instruction,
      logs: logs.slice(start).join(''),
    }
    for (const [name, text] of Object.entries(surfaces)) {
      expect(text, `${name} must not contain the password marker`).not.toContain(pwd)
      expect(text, `${name} must not contain the cookie marker`).not.toContain(cookie)
    }
    // Sanity: the markers really are recoverable through the trusted path (so the test is meaningful).
    expect((await vault.resolveCredentialByRef(e, 'alice-cred'))?.secret.reveal()).toMatchObject({ password: pwd })
    // The security events do record the lifecycle (by id), just never the secret.
    expect((await service.listEvents(e)).map((ev) => ev.type)).toContain('credential.created')
  })
})
