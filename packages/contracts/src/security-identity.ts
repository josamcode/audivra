import { z } from 'zod'
import { INFERRED_CONFIDENCE_CAP, type GraphEntityKind, type KnowledgeBasis, type ProvenanceSource, type SourceTrust } from './security-graph.ts'
import { SecurityActor } from './security.ts'

/*
 * Phase 5 Step 1 — the application-semantics domain model: identities, roles, tenants, resources, business
 * actions, business states and invariants. These are *declared* (or source/observation/AI-derived) records
 * an authorized engagement holds about the application it is assessing. They are not a second graph: a
 * declaration is a deterministic source that projects into the Phase 4 Security Graph (new entity kinds and
 * relationships) with `user-declaration` provenance, exactly as a sensor observation projects with
 * `observation` provenance.
 *
 *   SecurityDomainDeclaration ─► deterministic domain projector ─► graph node/edge upsert ─► provenance link
 *
 * No secrets live here. An identity carries a `credentialRef` (an opaque pointer, resolved by a later
 * credential vault — Step 2), never credential material; the projector never puts even that pointer on a
 * graph node. `UNKNOWN != FALSE`: an unknown role, tenant, owner or state is simply an absent relationship,
 * never an invented value.
 */

// ── Source classification (how Audivra came to hold a domain fact) ───────────────────────────────────

/**
 * The source of a domain declaration. An AI-inferred rule is a hypothesis, never an established fact: it is
 * capped in confidence and projected as `inferred`, never replacing an observed or declared fact.
 */
export const DOMAIN_SOURCES = ['declared', 'code-derived', 'observed', 'ai-inferred'] as const
export const DomainSource = z.enum(DOMAIN_SOURCES)
export type DomainSource = z.infer<typeof DomainSource>

/** Maps a domain source onto the Phase 4 graph provenance vocabulary (source, trust, basis, confidence cap). */
export function domainSourceMapping(source: DomainSource): { provenanceSource: ProvenanceSource; trust: SourceTrust; basis: KnowledgeBasis; confidenceCap: number } {
  switch (source) {
    case 'declared':
      return { provenanceSource: 'user-declaration', trust: 'user-declaration', basis: 'declared', confidenceCap: 1 }
    case 'observed':
      return { provenanceSource: 'observation', trust: 'runtime-observation', basis: 'observed', confidenceCap: 1 }
    case 'code-derived':
      return { provenanceSource: 'observation', trust: 'source-analysis', basis: 'observed', confidenceCap: 1 }
    case 'ai-inferred':
      return { provenanceSource: 'ai-inference', trust: 'ai-inference', basis: 'inferred', confidenceCap: INFERRED_CONFIDENCE_CAP }
  }
}

// ── Kinds (a subset of the Phase 4 graph entity kinds that a declaration can create) ─────────────────

export const DOMAIN_DECLARATION_KINDS = ['identity', 'role', 'tenant', 'resource', 'business-action', 'business-state', 'invariant'] as const satisfies readonly GraphEntityKind[]
export const DomainDeclarationKind = z.enum(DOMAIN_DECLARATION_KINDS)
export type DomainDeclarationKind = z.infer<typeof DomainDeclarationKind>

// ── Enumerations describing what an application exposes (never assumed; always declared) ──────────────

export const IDENTITY_TYPES = ['anonymous', 'user', 'service', 'admin', 'other'] as const
export const IdentityType = z.enum(IDENTITY_TYPES)
export type IdentityType = z.infer<typeof IdentityType>

/** How a test identity authenticates. Unsupported flows (e.g. generic SSO/MFA) stay `unknown` — a coverage limit. */
export const IDENTITY_AUTH_METHODS = ['none', 'form', 'api-token', 'session', 'preauthenticated', 'browser', 'unknown'] as const
export const IdentityAuthMethod = z.enum(IDENTITY_AUTH_METHODS)
export type IdentityAuthMethod = z.infer<typeof IdentityAuthMethod>

/** Lifecycle of a declared identity. Step 1 declares them; establishing/expiring sessions is Step 3. */
export const IDENTITY_LIFECYCLE_STATES = ['declared', 'active', 'expired', 'revoked'] as const
export const IdentityLifecycle = z.enum(IDENTITY_LIFECYCLE_STATES)
export type IdentityLifecycle = z.infer<typeof IdentityLifecycle>

export const TENANT_TYPES = ['organization', 'workspace', 'account', 'project', 'other'] as const
export const TenantType = z.enum(TENANT_TYPES)
export type TenantType = z.infer<typeof TenantType>

/** How much Audivra trusts that a resource is safe to mutate in a later state-changing test. */
export const TEST_DATA_CLASSES = ['test-owned', 'synthetic', 'production-like', 'unknown'] as const
export const TestDataClass = z.enum(TEST_DATA_CLASSES)
export type TestDataClass = z.infer<typeof TestDataClass>

/** Descriptive effect class of a business action (metadata, not a policy decision — capability policy is Phase 1). */
export const ACTION_EFFECT_CLASSES = ['read-only', 'test-data-mutation', 'reversible-state-change', 'unknown'] as const
export const ActionEffectClass = z.enum(ACTION_EFFECT_CLASSES)
export type ActionEffectClass = z.infer<typeof ActionEffectClass>

export const INVARIANT_CATEGORIES = ['object-boundary', 'function-level', 'role-boundary', 'tenant-boundary', 'field-access', 'session-boundary', 'state-transition', 'ownership', 'other'] as const
export const InvariantCategory = z.enum(INVARIANT_CATEGORIES)
export type InvariantCategory = z.infer<typeof InvariantCategory>

/** Lifecycle of an invariant. Consistent with the Phase 4 hypothesis vocabulary; the engine that moves it is later. */
export const INVARIANT_STATUSES = ['candidate', 'supported', 'contradicted', 'established', 'unknown'] as const
export const InvariantStatus = z.enum(INVARIANT_STATUSES)
export type InvariantStatus = z.infer<typeof InvariantStatus>

// ── Per-kind declaration specs (strict: unknown fields — including anything secret-looking — are rejected) ──

/** A handle for an entity within an engagement (used to reference other declarations); never a secret. */
const Ref = z.string().trim().min(1).max(120)

export const IdentitySpec = z.strictObject({
  identityType: IdentityType.default('user'),
  authMethod: IdentityAuthMethod.default('unknown'),
  /** An OPAQUE pointer the credential vault (Step 2) resolves at execution time — never credential material. */
  credentialRef: z.string().trim().max(200).nullable().default(null),
  /** Role handles this identity is expected to hold. */
  roleRefs: z.array(Ref).max(50).default([]),
  /** Tenant handle this identity belongs to (null: unknown or not tenant-scoped). */
  tenantRef: Ref.nullable().default(null),
  lifecycle: IdentityLifecycle.default('declared'),
  notes: z.string().trim().max(1000).nullable().default(null),
})
export type IdentitySpec = z.infer<typeof IdentitySpec>

export const RoleSpec = z.strictObject({
  /** Tenant handle this role is scoped to (null: a global/application-wide role). */
  scopeTenantRef: Ref.nullable().default(null),
  /** Business-action handles this role is expected to permit. */
  permits: z.array(Ref).max(100).default([]),
  notes: z.string().trim().max(1000).nullable().default(null),
})
export type RoleSpec = z.infer<typeof RoleSpec>

export const TenantSpec = z.strictObject({
  tenantType: TenantType.default('organization'),
  /** The application's own id for the tenant, when known (used for stable identity). */
  externalId: z.string().trim().max(200).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
})
export type TenantSpec = z.infer<typeof TenantSpec>

export const ResourceSpec = z.strictObject({
  /** Application-specific type (invoice, project, ticket …). Platform logic never hard-codes these. */
  resourceType: z.string().trim().min(1).max(80),
  /** The application's own id for the resource (used for stable identity). */
  externalId: z.string().trim().max(200).nullable().default(null),
  /** A canonical URL identifying the resource (used for stable identity when there is no external id). */
  canonicalUrl: z.string().trim().max(2048).nullable().default(null),
  tenantRef: Ref.nullable().default(null),
  /** Identity handle that owns the resource (null: unknown). */
  ownerRef: Ref.nullable().default(null),
  /** A technical endpoint URL the resource is reached through (kept as an attribute; no edge in Step 1). */
  endpointUrl: z.string().trim().max(2048).nullable().default(null),
  testData: TestDataClass.default('unknown'),
  /** Current business-state handle (null: unknown). */
  currentStateRef: Ref.nullable().default(null),
  /** Business-state handles this resource can be in. */
  stateRefs: z.array(Ref).max(50).default([]),
  notes: z.string().trim().max(1000).nullable().default(null),
})
export type ResourceSpec = z.infer<typeof ResourceSpec>

export const BusinessActionSpec = z.strictObject({
  verb: z.string().trim().min(1).max(60),
  /** Resource type the action operates on (null: unknown or type-agnostic). */
  actsOnResourceType: z.string().trim().max(80).nullable().default(null),
  /** Specific resource handles the action operates on. */
  actsOnRefs: z.array(Ref).max(50).default([]),
  /** Role handles expected to be required to perform the action. */
  requiredRoleRefs: z.array(Ref).max(50).default([]),
  /** Required precondition state handle (null: unknown / none). */
  requiredStateRef: Ref.nullable().default(null),
  /** Resulting state handle after the action (null: unknown / none). */
  resultingStateRef: Ref.nullable().default(null),
  effectClass: ActionEffectClass.default('unknown'),
  notes: z.string().trim().max(1000).nullable().default(null),
})
export type BusinessActionSpec = z.infer<typeof BusinessActionSpec>

export const BusinessStateSpec = z.strictObject({
  /** Resource type this state applies to (null: application-wide). */
  resourceType: z.string().trim().max(80).nullable().default(null),
  name: z.string().trim().min(1).max(80),
  /** State handles this state can transition to. */
  transitionsToRefs: z.array(Ref).max(50).default([]),
  terminal: z.boolean().default(false),
  notes: z.string().trim().max(1000).nullable().default(null),
})
export type BusinessStateSpec = z.infer<typeof BusinessStateSpec>

/** An entity an invariant governs: a declared entity (by kind + handle) or a graph node (by its key). */
export const AffectedEntityRef = z.union([z.strictObject({ kind: DomainDeclarationKind, ref: Ref }), z.strictObject({ nodeKey: z.string().trim().min(1).max(512) })])
export type AffectedEntityRef = z.infer<typeof AffectedEntityRef>

export const InvariantSpec = z.strictObject({
  category: InvariantCategory,
  /** The expected rule, in plain words (e.g. "a resource's tenant should match the actor's tenant"). */
  rule: z.string().trim().min(5).max(400),
  /** Graph entities the invariant governs. */
  affects: z.array(AffectedEntityRef).max(20).default([]),
  status: InvariantStatus.default('candidate'),
  /** A concise statement of the expected behaviour (never turned into ground truth without evidence). */
  expectation: z.string().trim().max(600).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
})
export type InvariantSpec = z.infer<typeof InvariantSpec>

// ── Create input (strict, discriminated by kind) and the stored view ─────────────────────────────────

const base = {
  /** Stable handle, unique per (engagement, kind); other declarations reference this. */
  ref: Ref,
  label: z.string().trim().min(1).max(200).optional(),
  source: DomainSource.default('declared'),
  confidence: z.number().min(0).max(1).optional(),
}

export const CreateDomainDeclarationInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('identity'), ...base, spec: IdentitySpec }),
  z.strictObject({ kind: z.literal('role'), ...base, spec: RoleSpec }),
  z.strictObject({ kind: z.literal('tenant'), ...base, spec: TenantSpec }),
  z.strictObject({ kind: z.literal('resource'), ...base, spec: ResourceSpec }),
  z.strictObject({ kind: z.literal('business-action'), ...base, spec: BusinessActionSpec }),
  z.strictObject({ kind: z.literal('business-state'), ...base, spec: BusinessStateSpec }),
  z.strictObject({ kind: z.literal('invariant'), ...base, spec: InvariantSpec }),
])
export type CreateDomainDeclarationInput = z.input<typeof CreateDomainDeclarationInput>

export const DOMAIN_DECLARATION_STATUSES = ['active', 'superseded'] as const
export const DomainDeclarationStatus = z.enum(DOMAIN_DECLARATION_STATUSES)
export type DomainDeclarationStatus = z.infer<typeof DomainDeclarationStatus>

/** The stored declaration as the API returns it. `spec` is validated strictly on write; read back loosely. */
export const SecurityDomainDeclaration = z.object({
  id: z.string(),
  engagementId: z.string(),
  kind: DomainDeclarationKind,
  ref: z.string(),
  /** The deterministic graph key this declaration projects to. */
  key: z.string(),
  label: z.string(),
  source: DomainSource,
  /** Graph basis derived from the source (declared / observed / inferred). */
  basis: z.enum(['observed', 'declared', 'derived', 'inferred']),
  confidence: z.number().min(0).max(1),
  status: DomainDeclarationStatus,
  spec: z.record(z.string(), z.unknown()),
  createdBy: SecurityActor,
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SecurityDomainDeclaration = z.infer<typeof SecurityDomainDeclaration>
