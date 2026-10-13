import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Logger } from '@audivra/config'
import { redact, type FactStatus, type GapStatus, type GraphEntityKind, type GraphRelationType, type HypothesisCategory, type KnowledgeBasis } from '@audivra/contracts'
import { enqueueSecurityReasoning, type Db, type PgBoss } from '@audivra/database'
import { createDurableBroker, GraphService, LOCAL_USER, ReasoningEngine, ReasoningService, SecurityRequestError } from '@audivra/security'

type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

/*
 * Phase 4: the Security Graph, hypotheses and reasoning runs.
 *
 * Reads are bounded (entity lists, neighbourhoods of at most two hops, capped neighbour lists); there is no
 * arbitrary graph query and no endpoint that runs a prompt. The only writes are a deterministic graph
 * rebuild (idempotent; it never runs a capability), starting a bounded reasoning run, and cancelling one.
 * A run is queued for the worker: its actions come only from the validated planner and are decided by the
 * Capability Broker — no request here carries a capability id, an input, an image or a command.
 */
export function registerReasoningRoutes(app: App, deps: { db: Db; boss: PgBoss }): void {
  const graph = new GraphService({ db: deps.db })
  // The API process only creates and cancels runs; the worker drives them (with AI, through the router).
  const engine = new ReasoningEngine({ db: deps.db, broker: createDurableBroker({ db: deps.db, boss: deps.boss }), ai: null, enqueue: async (runId) => void (await enqueueSecurityReasoning(deps.boss, runId)) })
  const reasoning = new ReasoningService({ db: deps.db, engine })

  async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send(redact(await work()))
    } catch (error) {
      if (error instanceof SecurityRequestError) return reply.status(error.status).send({ error: redact(error.message) })
      throw error
    }
  }
  const limit = (value: string | undefined) => (value ? Math.max(1, Math.min(1000, Number(value) || 500)) : undefined)

  // ── Security Graph (read-only, bounded) ─────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/graph/summary', (request, reply) => respond(reply, () => graph.summary(request.params.id)))

  app.get<{ Params: { id: string }; Querystring: { kind?: GraphEntityKind; status?: FactStatus; basis?: KnowledgeBasis; q?: string; limit?: string } }>('/api/security/engagements/:id/graph/nodes', (request, reply) =>
    respond(reply, () => graph.nodes(request.params.id, { kind: request.query.kind, status: request.query.status, basis: request.query.basis, q: request.query.q?.slice(0, 200), limit: limit(request.query.limit) })),
  )

  app.get<{ Params: { id: string }; Querystring: { type?: GraphRelationType; status?: FactStatus; basis?: KnowledgeBasis; limit?: string } }>('/api/security/engagements/:id/graph/edges', (request, reply) =>
    respond(reply, () => graph.edges(request.params.id, { type: request.query.type, status: request.query.status, basis: request.query.basis, limit: limit(request.query.limit) })),
  )

  /** Explicit unknowns ("unresolved relationships"): what the graph cannot answer yet. */
  app.get<{ Params: { id: string }; Querystring: { status?: GapStatus } }>('/api/security/engagements/:id/graph/gaps', (request, reply) => respond(reply, () => graph.gaps(request.params.id, request.query.status)))

  /** Deterministic, idempotent rebuild of the graph from stored observations. Runs no capability and no AI. */
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/graph/project', (request, reply) => respond(reply, () => graph.project(request.params.id)))

  app.get<{ Params: { nodeId: string } }>('/api/security/graph/nodes/:nodeId', (request, reply) => respond(reply, () => graph.node(request.params.nodeId)))

  app.get<{ Params: { nodeId: string }; Querystring: { depth?: string } }>('/api/security/graph/nodes/:nodeId/neighborhood', (request, reply) =>
    respond(reply, () => graph.neighborhood(request.params.nodeId, Number(request.query.depth ?? 1))),
  )

  app.get<{ Params: { nodeId: string } }>('/api/security/graph/nodes/:nodeId/observations', (request, reply) => respond(reply, () => graph.nodeObservations(request.params.nodeId)))

  app.get<{ Params: { nodeId: string } }>('/api/security/graph/nodes/:nodeId/evidence', (request, reply) => respond(reply, () => graph.nodeEvidence(request.params.nodeId)))

  // ── Hypotheses (read-only) ──────────────────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string }; Querystring: { status?: string; category?: HypothesisCategory } }>('/api/security/engagements/:id/hypotheses', (request, reply) =>
    respond(reply, () => reasoning.hypotheses(request.params.id, { status: request.query.status, category: request.query.category })),
  )

  app.get<{ Params: { hypothesisId: string } }>('/api/security/hypotheses/:hypothesisId', (request, reply) => respond(reply, () => reasoning.hypothesis(request.params.hypothesisId)))

  // ── Reasoning runs ──────────────────────────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/reasoning/runs', (request, reply) => respond(reply, () => reasoning.runs(request.params.id)))

  /** Starts a bounded run (`propose` by default). Body: `{ mode?, budget? }` — nothing else is accepted. */
  app.post<{ Params: { id: string } }>('/api/security/engagements/:id/reasoning/runs', (request, reply) => respond(reply, () => reasoning.start(request.params.id, request.body ?? {}, LOCAL_USER), 201))

  app.get<{ Params: { runId: string } }>('/api/security/reasoning/runs/:runId', (request, reply) => respond(reply, () => reasoning.run(request.params.runId)))

  app.post<{ Params: { runId: string } }>('/api/security/reasoning/runs/:runId/cancel', (request, reply) => respond(reply, () => reasoning.cancel(request.params.runId, LOCAL_USER), 202))

  app.get<{ Params: { id: string }; Querystring: { run?: string } }>('/api/security/engagements/:id/reasoning/actions', (request, reply) => respond(reply, () => reasoning.actions(request.params.id, request.query.run || undefined)))

  /** Reasoning coverage: graph, unknowns, hypotheses and actions — never an "AI security score". */
  app.get<{ Params: { id: string } }>('/api/security/engagements/:id/reasoning/coverage', (request, reply) => respond(reply, () => reasoning.coverage(request.params.id)))
}
