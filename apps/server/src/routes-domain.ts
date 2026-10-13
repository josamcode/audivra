import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact, type DomainDeclarationKind } from '@audivra/contracts'
import type { Db } from '@audivra/database'
import { DomainService, SecurityRequestError } from '@audivra/security'

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/*
 * Phase 5 Step 1: read-only inspection of an engagement's declared application-semantics domain (identities,
 * roles, tenants, resources, business actions/states, invariants). Responses are redacted and never carry
 * credential material (a declaration's `credentialRef` is an opaque pointer, resolved only at execution time
 * by the later credential vault). Declaring is a configuration action done by a person/Audivra; the write
 * surface arrives with the Identities area in a later step — the projected entities are already inspectable
 * through the existing Security Graph endpoints (`…/graph/nodes?kind=identity`, etc.).
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

  app.get<{ Params: { id: string }; Querystring: { kind?: DomainDeclarationKind } }>('/api/security/engagements/:id/domain/declarations', (request, reply) =>
    respond(reply, () => service.list(request.params.id, request.query.kind)),
  )

  app.get<{ Params: { declarationId: string } }>('/api/security/domain/declarations/:declarationId', (request, reply) => respond(reply, () => service.get(request.params.declarationId)))
}
