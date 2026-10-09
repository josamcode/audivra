import { createReadStream, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact, type ObservationFamily, type ObservationScopeClass, type ObservationType } from '@audivra/contracts'
import type { Db } from '@audivra/database'
import { authorizationMethods, createDefaultRegistry, ExecutionService, LOCAL_USER, SecurityRequestError, SecurityService } from '@audivra/security'

interface Deps {
  db: Db
  /** Injected by tests (e.g. with a fixed resolver); built from the database otherwise. */
  security?: SecurityService
}

/** Small text artifacts are shown inline (redacted); everything else is a download. */
const TEXT_ARTIFACT = /\.(txt|json|log|md|csv)$/i
const INLINE_TEXT_LIMIT = 256 * 1024

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/**
 * Security engagements: configuration, readiness and the inspection and control of durable executions.
 * Deliberately absent: any endpoint that creates or runs an execution, or that takes a command, an
 * executable or an image. Executions come into being only through the CapabilityBroker, from platform
 * code, never from a generic HTTP request; the API can list, read and cancel them.
 *
 * Every response passes through redaction; configuration changes are made as the local user.
 */
export function registerSecurityRoutes(app: App, deps: Deps): void {
  const service = deps.security ?? new SecurityService({ db: deps.db })
  const executions = new ExecutionService({ db: deps.db })
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

  // ── Observations: read-only, normalized, evidence-backed sensor signals ────────────────────────────

  app.get<{ Params: { id: string }; Querystring: { type?: ObservationType; asset?: string; scopeClass?: ObservationScopeClass; family?: ObservationFamily; tool?: string; minConfidence?: string } }>(
    '/api/security/engagements/:id/observations',
    (request, reply) =>
      respond(reply, () =>
        service.listObservations(request.params.id, {
          type: request.query.type,
          asset: request.query.asset,
          scopeClass: request.query.scopeClass,
          family: request.query.family,
          tool: request.query.tool,
          minConfidence: request.query.minConfidence !== undefined ? Number(request.query.minConfidence) : undefined,
        }),
      ),
  )

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/observations/summary', (request, reply) => respond(reply, () => service.observationSummary(request.params.id)))

  /** Cross-sensor correlation: observations grouped by normalized asset, most-corroborated first. */
  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/observations/correlate', (request, reply) => respond(reply, () => service.correlateByAsset(request.params.id)))

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/sensor-coverage', (request, reply) => respond(reply, () => service.sensorCoverage(request.params.id)))

  // ── Executions: inspect and control (never create) ───────────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/executions', (request, reply) => respond(reply, () => executions.list(request.params.id)))

  app.get<{ Params: { executionId: string } }>('/api/security/executions/:executionId', (request, reply) => respond(reply, () => executions.get(request.params.executionId)))

  app.get<{ Params: { executionId: string } }>('/api/security/executions/:executionId/events', (request, reply) =>
    respond(reply, () => executions.events(request.params.executionId)),
  )

  app.get<{ Params: { executionId: string } }>('/api/security/executions/:executionId/evidence', (request, reply) =>
    respond(reply, () => executions.evidence(request.params.executionId)),
  )

  app.get<{ Params: { executionId: string } }>('/api/security/executions/:executionId/observations', (request, reply) =>
    respond(reply, () => executions.observations(request.params.executionId)),
  )

  /** Idempotent: a queued execution is cancelled at once; a running one is stopped by its worker. */
  app.post<{ Params: { executionId: string } }>('/api/security/executions/:executionId/cancel', (request, reply) =>
    respond(reply, () => executions.cancel(request.params.executionId, LOCAL_USER), 202),
  )

  /** Files the execution registered as evidence (only those), resolved inside its workspace. */
  app.get<{ Params: { executionId: string; '*': string } }>('/api/security/executions/:executionId/artifacts/*', async (request, reply) => {
    try {
      const { file, name } = await executions.artifact(request.params.executionId, request.params['*'])
      void reply.header('X-Content-Type-Options', 'nosniff')
      if (TEXT_ARTIFACT.test(name) && statSync(file).size <= INLINE_TEXT_LIMIT) {
        return reply.type('text/plain; charset=utf-8').send(redact(readFileSync(file, 'utf8')))
      }
      void reply.header('Content-Disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`)
      return reply.type('application/octet-stream').send(createReadStream(file))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  })

  /** Capability catalog (policy metadata only — what exists, not a way to run it). */
  app.get('/api/security/capabilities', (_request, reply) => respond(reply, async () => registry.list()))

  app.get('/api/security/policy-profiles', (_request, reply) => respond(reply, async () => service.policyProfiles()))

  app.get('/api/security/authorization-methods', (_request, reply) => respond(reply, async () => authorizationMethods()))
}
