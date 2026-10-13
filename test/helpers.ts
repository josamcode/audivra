import type { Server } from 'node:http'
import { createDb, type DbHandle } from '../packages/database/src/index.ts'

/** Connects to the integration-test database (DATABASE_URL is pointed at it by vitest.config.ts). */
export function testDb(): DbHandle {
  const url = process.env.DATABASE_URL!
  if (!url.includes('test')) throw new Error('Integration tests must use the test database')
  return createDb(url, 5)
}

export async function resetDb(handle: DbHandle): Promise<void> {
  await handle.pool.query('truncate audits cascade')
}

export async function startFixture(): Promise<{ server: Server; url: string }> {
  // @ts-expect-error -- plain JS fixture module without type declarations
  const mod = (await import('../fixtures/site/server.mjs')) as {
    startFixtureServer(port: number): Promise<{ server: Server; url: string }>
  }
  return mod.startFixtureServer(0)
}

export interface ScopeFixture {
  server: Server
  port: number
  url: string
  hits: Map<string, number>
  total(): number
  close(): Promise<void>
}

/** The scope fixture (fixtures/scope/server.mjs) on a free port of 127.0.0.1. */
export async function startScopeFixture(label = 'primary'): Promise<ScopeFixture> {
  // @ts-expect-error -- plain JS fixture module without type declarations
  const mod = (await import('../fixtures/scope/server.mjs')) as { startScopeFixture(options: { port: number; label: string }): Promise<ScopeFixture> }
  return mod.startScopeFixture({ port: 0, label })
}

export interface IdentityFixtureRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  authenticatedAs: string | null
}

export interface IdentityFixture {
  server: Server
  label: string
  port: number
  url: string
  hits: Map<string, number>
  /** Every request the fixture received, in order (with the identity it was recognized as). */
  requests: IdentityFixtureRequest[]
  /** sid cookie value → identity. */
  sessions: Map<string, string>
  /** bearer token value → identity. */
  tokens: Map<string, string>
  /** "header-name: value" (lower-cased name) → identity. */
  headerSecrets: Map<string, string>
  /** username → { password, sid, who } for the form-login routes. */
  users: Map<string, { password: string; sid: string; who: string }>
  /** who → { tenant, role } — the multi-tenant principal model (Phase 5 Step 4). */
  principals: Map<string, { tenant: string; role: 'user' | 'admin' }>
  /** resource id → { tenant, owner, state, enforce } for the resource API. */
  resources: Map<string, { tenant: string; owner: string; state: string; enforce: 'strict' | 'tenant' | 'leaky' }>
  close(): Promise<void>
}

/** The identity fixture (fixtures/identity/server.mjs): tells authenticated requests apart from anonymous ones. */
export async function startIdentityFixture(label = 'identity'): Promise<IdentityFixture> {
  // @ts-expect-error -- plain JS fixture module without type declarations
  const mod = (await import('../fixtures/identity/server.mjs')) as { startIdentityFixture(options: { port: number; label: string }): Promise<IdentityFixture> }
  return mod.startIdentityFixture({ port: 0, label })
}
