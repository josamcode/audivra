import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact, type DomainDeclarationKind, type DomainDeclarationStatus } from '@audivra/contracts'
import type { Db } from '@audivra/database'
import { DomainService, LOCAL_USER, SecurityRequestError } from '@audivra/security'

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/*
 * Phase 5: management of an engagement's declared application-semantics domain (identities, roles, tenants,
 * resources, business actions/states, invariants). Declaring/updating/retiring is a configuration action a
 * person/Audivra performs — an agent is refused in the service, so a model can never invent an identity,
 * tenant, role or ownership. Responses are redacted and never carry credential material (a declaration's
 * `credentialRef` is an opaque pointer, resolved only by the credential vault). Updates preserve history: the
 * active version is superseded and a new one created, so earlier assessments' beliefs are never rewritten.
 */
export function registerDomainRoutes(app: App, deps: { db: Db }): void {
  const service = new DomainService({ db: deps.db })

  async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send(redact(await work()))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  }

  app.get<{ Params: { id: string }; Querystring: { kind?: DomainDeclarationKind; status?: DomainDeclarationStatus | 'all' } }>('/api/security/engagements/:id/domain/declarations', (request, reply) =>
    respond(reply, () => service.list(request.params.id, request.query.kind, request.query.status ?? 'active')),
  )

  // Declare a new domain record (strict per-kind contract; no secret material).
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/domain/declarations', (request, reply) => respond(reply, () => service.declare(request.params.id, request.body, LOCAL_USER), 201))

  app.get<{ Params: { declarationId: string } }>('/api/security/domain/declarations/:declarationId', (request, reply) => respond(reply, () => service.get(request.params.declarationId)))

  // Update a declaration (supersedes the active version; history is preserved).
  app.put<{ Params: { declarationId: string } }>('/api/security/domain/declarations/:declarationId', (request, reply) => respond(reply, () => service.update(request.params.declarationId, request.body, LOCAL_USER)))

  // Retire a declaration (kept for history; no longer projected or resolvable).
  app.post<{ Params: { declarationId: string } }>('/api/security/domain/declarations/:declarationId/retire', (request, reply) => respond(reply, () => service.retire(request.params.declarationId, LOCAL_USER)))
}
