import { z } from 'zod'
import { ObservationScopeClass, ObservationType } from './security-observation.ts'

/*
 * The Security Graph (Phase 4): Audivra's persistent, provenance-carrying model of what it knows about an
 * engagement's application. It is reasoning state, not a picture.
 *
 *   SecurityObservation ─► deterministic graph projector ─► node / edge upsert ─► provenance link
 *                                                        ─► derivations (template match, conflicts, staleness)
 *                                                        ─► knowledge gaps (what is explicitly unknown)
 *
 * Every fact answers "why does Audivra believe this?" through its provenance, carries an explicit knowledge
 * basis (observed / derived / inferred / declared) and confidence, and keeps its history (first/last
 * observed, stale, superseded, contradicted). Nothing is deleted because a later run differs. Observations
 * and evidence are not duplicated as nodes: OBSERVED_BY / SUPPORTED_BY are the provenance rows.
 */

/**
 * Entity kinds. Phase 4 kinds come from sensor observations; the Phase 5 application-semantics kinds
 * (identity … invariant) come from declarations/source/AI and are projected by the domain projector. A
 * `session` is produced at runtime once authenticated sessions exist (Phase 5, Step 3); its kind is
 * declared here so the vocabulary is stable for the phase.
 */
export const GRAPH_ENTITY_KINDS = [
  /** An origin (scheme + host + port) serving the application. */
  'host',
  /** A concrete path on an origin (query and fragment stripped); methods are attributes. */
  'endpoint',
  /** An API operation (method + path template) known from a schema or contract test. */
  'api-operation',
  /** An input an endpoint reads (form field, query parameter, path parameter). */
  'parameter',
  /** A technology, framework or server, engagement-wide (versions are attributes). */
  'technology',
  /** A security signal (a finding placeholder): a scanner/contract/source signal that is NOT a verified finding. */
  'signal',
  /** A source file a static analyser reported on. */
  'source-file',
  // ── Phase 5: application semantics (declared / source / AI-derived, never a secret) ──────────────────
  /** A test principal available to the authorized assessment (anonymous, a tenant member/admin, …). */
  'identity',
  /** A role a principal can hold. */
  'role',
  /** A tenant / organization / workspace boundary. */
  'tenant',
  /** An authenticated session bound to an identity (produced at runtime in Step 3; no Step-1 producer). */
  'session',
  /** An application resource instance (an invoice, project, ticket …), typed by the application. */
  'resource',
  /** A meaningful application operation (view, create, approve, transfer …). */
  'business-action',
  /** A resource lifecycle state (draft, pending, approved …). */
  'business-state',
  /** A security/business invariant: an expected rule (never a verified finding). */
  'invariant',
  /** A verified/supported Security Finding (Phase 6A); minimal attributes, full data in the finding store. */
  'finding',
] as const
export const GraphEntityKind = z.enum(GRAPH_ENTITY_KINDS)
export type GraphEntityKind = z.infer<typeof GraphEntityKind>

/**
 * Stable relationship types. OBSERVED_BY / SUPPORTED_BY are provenance rows rather than edges. The Phase 5
 * relations are produced by the domain projector from declarations (except AUTHENTICATES_AS, which needs a
 * runtime session — Step 3; it is declared here to keep the vocabulary stable for the phase).
 */
export const GRAPH_RELATION_TYPES = [
  /** host → endpoint */
  'HOSTS',
  /** host → api-operation */
  'EXPOSES',
  /** endpoint | api-operation → parameter */
  'READS',
  /** endpoint (page) → endpoint (form action / submission target) */
  'CALLS',
  /** endpoint → api-operation whose path template it matches */
  'BELONGS_TO',
  /** host → technology */
  'DEPENDS_ON',
  /** endpoint → endpoint (a redirect; functional: a newer destination supersedes an older one) */
  'REDIRECTS_TO',
  /** signal → endpoint | api-operation | source-file | host */
  'AFFECTS',
  // ── Phase 5: application semantics ───────────────────────────────────────────────────────────────────
  /** identity → role */
  'HAS_ROLE',
  /** identity | resource | role → tenant */
  'BELONGS_TO_TENANT',
  /** session → identity (produced at runtime in Step 3; no Step-1 producer) */
  'AUTHENTICATES_AS',
  /** identity → resource */
  'OWNS',
  /** role → business-action */
  'PERMITS',
  /** business-action → resource */
  'ACTS_ON',
  /** resource → business-state */
  'HAS_STATE',
  /** business-state → business-state */
  'TRANSITIONS_TO',
  /** <any entity> → invariant (the entity is governed by the invariant) */
  'GOVERNED_BY',
  /** identity → resource: an identity was observed to obtain access to a resource (differential comparison, Step 5). */
  'CAN_ACCESS',
  /** finding → endpoint | resource | host | api-operation | identity (the finding affects this entity; Phase 6A). */
  'FINDING_AFFECTS',
  /** finding → invariant (the finding contradicts this invariant; Phase 6A). */
  'CONTRADICTS',
] as const
export const GraphRelationType = z.enum(GRAPH_RELATION_TYPES)
export type GraphRelationType = z.infer<typeof GraphRelationType>

/** Relationship types an AI may propose (validated, stored as `inferred`, never replacing observed facts). */
export const AI_RELATION_TYPES = ['CALLS', 'BELONGS_TO', 'DEPENDS_ON', 'READS'] as const satisfies readonly GraphRelationType[]
export const AiRelationType = z.enum(AI_RELATION_TYPES)
export type AiRelationType = z.infer<typeof AiRelationType>

/**
 * Why Audivra holds a fact. The strongest basis among a fact's provenance wins and never silently degrades:
 * an AI inference added to an observed fact leaves it `observed`.
 *
 *   observed  reported by a deterministic sensor (an observation)
 *   declared  stated by a person
 *   derived   computed by Audivra from other facts by a deterministic rule
 *   inferred  proposed by an AI and validated, but not observed
 */
export const KNOWLEDGE_BASES = ['observed', 'declared', 'derived', 'inferred'] as const
export const KnowledgeBasis = z.enum(KNOWLEDGE_BASES)
export type KnowledgeBasis = z.infer<typeof KnowledgeBasis>

/** Strength order used to aggregate a fact's basis (lower index = stronger). */
export function strongestBasis(bases: readonly KnowledgeBasis[]): KnowledgeBasis {
  for (const basis of KNOWLEDGE_BASES) if (bases.includes(basis)) return basis
  return 'inferred'
}

/** An inferred (AI-only) fact never carries more confidence than this. */
export const INFERRED_CONFIDENCE_CAP = 0.6

/**
 * Temporal state of a fact. Facts are never deleted: `stale` = the latest run of every sensor that reported
 * it ran again on the same target and did not report it; `superseded` = replaced by a newer fact of a
 * functional relation (a redirect now goes elsewhere); `contradicted` = in an unresolved conflict with
 * another active fact (both are kept; later reasoning resolves it).
 */
export const FACT_STATUSES = ['active', 'stale', 'superseded', 'contradicted'] as const
export const FactStatus = z.enum(FACT_STATUSES)
export type FactStatus = z.infer<typeof FactStatus>

/** Where a provenance row's support comes from. `comparison-derivation` is a deterministic fact derived from
 * a controlled differential comparison (Phase 5 Step 5) — distinct from a sensor observation, a declaration,
 * a rule-based derivation and an AI inference, and never promoted to a universal rule. */
export const PROVENANCE_SOURCES = ['observation', 'derivation', 'comparison-derivation', 'ai-inference', 'user-declaration'] as const
export const ProvenanceSource = z.enum(PROVENANCE_SOURCES)
export type ProvenanceSource = z.infer<typeof ProvenanceSource>

/** Source trust: deterministic sensing is never silently replaced by inference. A `differential-comparison`
 * fact is evidence-backed (executions + controls) but remains distinguishable from direct sensing. */
export const SOURCE_TRUSTS = ['runtime-observation', 'source-analysis', 'deterministic-derivation', 'differential-comparison', 'user-declaration', 'ai-inference'] as const
export const SourceTrust = z.enum(SOURCE_TRUSTS)
export type SourceTrust = z.infer<typeof SourceTrust>

export const GraphConflict = z.object({
  /** Conflict group, e.g. `web-server@host:http://127.0.0.1:4331` or `version:nginx@host:…`. */
  group: z.string(),
  reason: z.string(),
  /** Keys of the other facts in the conflict. */
  with: z.array(z.string()),
  detectedAt: z.string(),
})
export type GraphConflict = z.infer<typeof GraphConflict>

const FactFields = {
  id: z.string(),
  engagementId: z.string(),
  /** Deterministic identity key, unique per engagement (see `graph/identity.ts`). */
  key: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  basis: KnowledgeBasis,
  confidence: z.number().min(0).max(1),
  /** Distinct sensors (tools) that reported it — corroboration, not confidence. */
  corroboration: z.number().int().min(0),
  tools: z.array(z.string()),
  status: FactStatus,
  statusReason: z.string().nullable(),
  conflicts: z.array(GraphConflict),
  firstObservedAt: z.string(),
  lastObservedAt: z.string(),
  firstExecutionId: z.string().nullable(),
  lastExecutionId: z.string().nullable(),
  updatedAt: z.string(),
}

export const SecurityGraphNode = z.object({
  ...FactFields,
  kind: GraphEntityKind,
  label: z.string(),
  /** Scope classification for URL-like entities; null for technologies and source files. */
  scopeClass: ObservationScopeClass.nullable(),
})
export type SecurityGraphNode = z.infer<typeof SecurityGraphNode>

export const SecurityGraphEdge = z.object({
  ...FactFields,
  type: GraphRelationType,
  fromId: z.string(),
  toId: z.string(),
  fromKey: z.string(),
  toKey: z.string(),
})
export type SecurityGraphEdge = z.infer<typeof SecurityGraphEdge>

export const SecurityGraphProvenance = z.object({
  id: z.string(),
  subjectType: z.enum(['node', 'edge']),
  subjectId: z.string(),
  source: ProvenanceSource,
  trust: SourceTrust,
  /** Observation id, derivation rule id, AI proposal ref or declaration ref. */
  sourceRef: z.string(),
  observationId: z.string().nullable(),
  evidenceRefs: z.array(z.string()),
  executionIds: z.array(z.string()),
  capabilityIds: z.array(z.string()),
  tools: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  /** Concise, auditable rationale (derivation rule or AI rationale) — never hidden reasoning. */
  rationale: z.string().nullable(),
  reasoningRunId: z.string().nullable(),
  firstAt: z.string(),
  lastAt: z.string(),
})
export type SecurityGraphProvenance = z.infer<typeof SecurityGraphProvenance>

// ── Knowledge gaps: what Audivra explicitly does not know ─────────────────────────────────────────────

/**
 * Unknown is not false. A gap names a question the graph cannot answer yet and which observation types
 * would answer it. Ownership/tenant gaps need identities (Phase 5) and are not raised yet.
 */
export const GAP_KINDS = [
  /** A discovered in-scope endpoint has never been inspected (no response observed). */
  'endpoint-behavior-unknown',
  /** A technology reported by a single sensor only. */
  'technology-uncorroborated',
  /** A schema/contract operation never seen on the running application's discovered surface. */
  'api-operation-unobserved',
  /** A heuristic security signal awaiting independent confirmation. */
  'signal-unconfirmed',
  /** Two active facts conflict (e.g. two web servers on one host). */
  'contradiction-unresolved',
  /** An input-accepting endpoint/operation whose authentication requirement is not known. */
  'authentication-requirement-unknown',
  // ── Phase 5: application-semantics unknowns (feed the comparison planner's ranking) ──────────────────
  /** A declared identity holds no role (its privileges are unknown). */
  'identity-role-unknown',
  /** A declared identity belongs to no tenant (its tenant membership is unknown). */
  'tenant-membership-unknown',
  /** A declared resource has no owner (its ownership is unknown). */
  'resource-ownership-unknown',
  /** A resource/action boundary has no declared or observed authorization expectation. */
  'authorization-expectation-unknown',
  /** A business action's required role/permission is not known. */
  'function-permission-unknown',
  /** Which fields an identity should see on a resource is not known. */
  'field-visibility-unknown',
  /** Whether a resource enforces a session boundary is not known. */
  'session-behavior-unknown',
  /** A business state's transition rule has not been observed. */
  'state-transition-rule-unknown',
] as const
export const GapKind = z.enum(GAP_KINDS)
export type GapKind = z.infer<typeof GapKind>

export const GAP_STATUSES = ['open', 'resolved', 'not-applicable'] as const
export const GapStatus = z.enum(GAP_STATUSES)
export type GapStatus = z.infer<typeof GapStatus>

export const KnowledgeGap = z.object({
  id: z.string(),
  engagementId: z.string(),
  kind: GapKind,
  subjectType: z.enum(['node', 'edge']),
  subjectId: z.string(),
  subjectKey: z.string(),
  /** The open question, in plain words. */
  question: z.string(),
  status: GapStatus,
  resolution: z.string().nullable(),
  resolvedBy: z.object({ observationId: z.string().nullable(), executionId: z.string().nullable() }).nullable(),
  /** Observation types that would answer the question (planning input). */
  answeredBy: z.array(ObservationType),
  firstDetectedAt: z.string(),
  resolvedAt: z.string().nullable(),
  updatedAt: z.string(),
})
export type KnowledgeGap = z.infer<typeof KnowledgeGap>

// ── Read views ─────────────────────────────────────────────────────────────────────────────────────────

export const SecurityGraphSummary = z.object({
  entities: z.number().int(),
  relationships: z.number().int(),
  byKind: z.record(z.string(), z.number().int()),
  byRelation: z.record(z.string(), z.number().int()),
  byBasis: z.record(z.string(), z.number().int()),
  byStatus: z.record(z.string(), z.number().int()),
  gaps: z.object({ open: z.number().int(), resolved: z.number().int(), byKind: z.record(z.string(), z.object({ open: z.number().int(), resolved: z.number().int() })) }),
  /** When a graph fact last changed (null: nothing projected yet). A no-op projection changes nothing. */
  lastChangedAt: z.string().nullable(),
})
export type SecurityGraphSummary = z.infer<typeof SecurityGraphSummary>

/** One relationship as seen from an entity, with the entity on the other side. */
export const GraphNeighbor = z.object({ edge: SecurityGraphEdge, direction: z.enum(['out', 'in']), node: SecurityGraphNode })
export type GraphNeighbor = z.infer<typeof GraphNeighbor>

export const SecurityGraphNodeDetail = z.object({
  node: SecurityGraphNode,
  neighbors: z.array(GraphNeighbor),
  provenance: z.array(SecurityGraphProvenance),
  gaps: z.array(KnowledgeGap),
  /** The observations behind the provenance rows (so each source can be named). */
  observations: z.array(z.object({ id: z.string(), type: ObservationType, title: z.string(), asset: z.string() })),
  /** Ids of hypotheses that involve this entity. */
  hypothesisIds: z.array(z.string()),
  /** The neighbor list was cut to stay bounded. */
  truncated: z.boolean(),
})
export type SecurityGraphNodeDetail = z.infer<typeof SecurityGraphNodeDetail>

export const SecurityGraphNeighborhood = z.object({
  focus: z.string(),
  depth: z.number().int().min(1).max(2),
  nodes: z.array(SecurityGraphNode),
  edges: z.array(SecurityGraphEdge),
  truncated: z.boolean(),
})
export type SecurityGraphNeighborhood = z.infer<typeof SecurityGraphNeighborhood>

/** What one projection changed (idempotent: a repeated projection over the same observations changes nothing). */
export const GraphProjectionResult = z.object({
  observations: z.number().int(),
  nodes: z.object({ added: z.number().int(), updated: z.number().int(), unchanged: z.number().int() }),
  edges: z.object({ added: z.number().int(), updated: z.number().int(), unchanged: z.number().int() }),
  provenance: z.object({ added: z.number().int(), updated: z.number().int() }),
  gaps: z.object({ opened: z.number().int(), resolved: z.number().int() }),
  contradictions: z.number().int(),
  stale: z.number().int(),
  addedByKind: z.record(z.string(), z.number().int()),
  durationMs: z.number().int(),
})
export type GraphProjectionResult = z.infer<typeof GraphProjectionResult>
