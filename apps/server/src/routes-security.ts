import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact } from '@audivra/contracts'
import type { Db } from '@audivra/database'
import { authorizationMethods, createDefaultRegistry, LOCAL_USER, SecurityRequestError, SecurityService } from '@audivra/security'

interface Deps {
  db: Db
  /** Injected by tests (e.g. with a fixed resolver); built from the database otherwise. */
  security?: SecurityService
}

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/**
 * Security engagements (Phase 1: configuration and readiness). Deliberately absent: any endpoint that
 * executes a capability. Capability execution goes through the CapabilityBroker only, from platform
 * code, never from a generic HTTP request.
 *
 * Every response passes through redaction; configuration changes are made as the local user.
 */
export function registerSecurityRoutes(app: App, deps: Deps): void {
  const service = deps.security ?? new SecurityService({ db: deps.db })
  const registry = createDefaultRegistry()

  async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
    try {
      const body = await work()
      return reply.status(status).send(redact(body))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  }

  app.get('/api/security/engagements', (_request, reply) => respond(reply, () => service.listEngagements()))

  app.post('/api/security/engagements', (request, reply) => respond(reply, () => service.createEngagement(request.body, LOCAL_USER), 201))

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id', (request, reply) => respond(reply, () => service.getEngagement(request.params.id)))

  app.patch<{ Params: { id: string } }>('/api/security/engagements/:id', (request, reply) =>
    respond(reply, () => service.updateEngagement(request.params.id, request.body, LOCAL_USER)),
  )

  app.put<{ Params: { id: string } }>('/api/security/engagements/:id/scope', (request, reply) =>
    respond(reply, () => service.updateScope(request.params.id, request.body, LOCAL_USER)),
  )

  /** Evaluates a URL against the stored or a draft scope (name and resolved addresses). Records nothing. */
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/scope/validate', (request, reply) =>
    respond(reply, () => service.validateScope(request.params.id, request.body)),
  )

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/policy', (request, reply) =>
    respond(reply, async () => (await service.getEngagement(request.params.id)).policy),
  )

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/readiness', (request, reply) =>
    respond(reply, async () => (await service.getEngagement(request.params.id)).readiness),
  )

  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/authorizations', (request, reply) =>
    respond(reply, () => service.requestAuthorization(request.params.id, request.body, LOCAL_USER), 201),
  )

  app.post<{ Params: { id: string; authorizationId: string } }>('/api/security/engagements/:id/authorizations/:authorizationId/revoke', (request, reply) =>
    respond(reply, () => service.revokeAuthorization(request.params.id, request.params.authorizationId, LOCAL_USER)),
  )

  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/lifecycle', (request, reply) =>
    respond(reply, () => service.applyLifecycle(request.params.id, request.body, LOCAL_USER)),
  )

  app.get<{ Params: { id: string }; Querystring: { after?: string; execution?: string } }>('/api/security/engagements/:id/events', (request, reply) =>
    respond(reply, () =>
      service.listEvents(request.params.id, {
        afterId: request.query.after ? Number(request.query.after) || undefined : undefined,
        executionId: request.query.execution || undefined,
      }),
    ),
  )

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/evidence', (request, reply) => respond(reply, () => service.listEvidence(request.params.id)))

  /** Capability catalog (policy metadata only — what exists, not a way to run it). */
  app.get('/api/security/capabilities', (_request, reply) => respond(reply, async () => registry.list()))

  app.get('/api/security/policy-profiles', (_request, reply) => respond(reply, async () => service.policyProfiles()))

  app.get('/api/security/authorization-methods', (_request, reply) => respond(reply, async () => authorizationMethods()))
}
