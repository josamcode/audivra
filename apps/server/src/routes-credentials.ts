import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact } from '@audivra/contracts'
import type { Db } from '@audivra/database'
import { createSecretVault, GraphProjector, identityCoverage, LOCAL_USER, SecretVault, SecurityRequestError, SessionEstablishmentService } from '@audivra/security'

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/*
 * Phase 5 Step 2: management of authorized test credentials and read-only session metadata. Writes are a
 * configuration action (the local user; agents are refused in the service). Secret material is sealed
 * immediately and NEVER returned — a successful write answers with metadata (`configured: true`). There is
 * deliberately NO endpoint that returns a plaintext secret: resolution happens only inside trusted
 * server/worker code (`SecretVault.resolveCredential…`), never over HTTP. Every response is redacted.
 */
export function registerCredentialRoutes(app: App, deps: { db: Db; vault?: SecretVault; log?: Logger }): void {
  const vault = deps.vault ?? createSecretVault(deps.db, { log: deps.log })
  // Establishing/revoking sessions re-projects the graph so `AUTHENTICATES_AS` reflects the live session set.
  const establishment = new SessionEstablishmentService({ db: deps.db, vault, projector: new GraphProjector({ db: deps.db, log: deps.log }), log: deps.log })

  async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send(redact(await work()))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  }

  // Vault health (no secrets): the System area can show whether the vault is ready/degraded.
  app.get('/api/security/vault', (_request, reply) => respond(reply, async () => vault.health()))

  // ── Credentials ────────────────────────────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/credentials', (request, reply) => respond(reply, () => vault.setCredential(request.params.id, request.body, LOCAL_USER), 201))

  app.get<{ Params: { id: string }; Querystring: { identityRef?: string } }>('/api/security/engagements/:id/credentials', (request, reply) =>
    respond(reply, () => vault.listCredentials(request.params.id, request.query.identityRef || undefined)),
  )

  app.get<{ Params: { credentialId: string } }>('/api/security/credentials/:credentialId', (request, reply) => respond(reply, () => vault.credential(request.params.credentialId)))

  app.put<{ Params: { credentialId: string } }>('/api/security/credentials/:credentialId', (request, reply) => respond(reply, () => vault.replaceCredential(request.params.credentialId, request.body, LOCAL_USER)))

  app.post<{ Params: { credentialId: string } }>('/api/security/credentials/:credentialId/revoke', (request, reply) => respond(reply, () => vault.revokeCredential(request.params.credentialId, LOCAL_USER)))

  app.delete<{ Params: { credentialId: string } }>('/api/security/credentials/:credentialId', (request, reply) => respond(reply, () => vault.deleteCredential(request.params.credentialId, LOCAL_USER)))

  // ── Sessions (read-only metadata; establishment is Step 3) ───────────────────────────────────────────

  app.get<{ Params: { id: string }; Querystring: { identityRef?: string } }>('/api/security/engagements/:id/sessions', (request, reply) =>
    respond(reply, () => vault.listSessions(request.params.id, request.query.identityRef || undefined)),
  )

  app.get<{ Params: { sessionId: string } }>('/api/security/sessions/:sessionId', (request, reply) => respond(reply, () => vault.session(request.params.sessionId)))

  // Establish (or reuse) an authenticated session for a declared identity. The AI never reaches this path.
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/sessions/establish', (request, reply) => respond(reply, () => establishment.establish(request.params.id, request.body, LOCAL_USER), 201))

  // Revoke a session: its sealed material is dropped and its graph edge goes inactive.
  app.post<{ Params: { sessionId: string } }>('/api/security/sessions/:sessionId/revoke', (request, reply) => respond(reply, () => establishment.revoke(request.params.sessionId, LOCAL_USER)))

  // Identity coverage: what the engagement can authenticate as (no secrets).
  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/identities/coverage', (request, reply) => respond(reply, () => identityCoverage(deps.db, request.params.id)))
}
