import { CreateDomainDeclarationInput, domainSourceMapping, UpdateDomainDeclarationInput, type DomainDeclarationKind, type DomainDeclarationStatus, type SecurityActor, type SecurityDomainDeclaration } from '@audivra/contracts'
import {
  createDomainDeclaration,
  findDomainDeclarationByRef,
  getDomainDeclarationRow,
  getEngagementRow,
  listDomainDeclarationRows,
  newDomainDeclarationId,
  patchDomainDeclaration,
  toDomainDeclaration,
  type Db,
} from '@audivra/database'
import type { z } from 'zod'
import { declarationKey } from '../graph/project-domain.ts'
import { assertConfigurationActor, LOCAL_USER, SecurityRequestError } from '../service.ts'

/*
 * Phase 5 domain declarations for the API: declaring, listing and reading the identities, roles, tenants,
 * resources, business actions/states and invariants an engagement holds. Declaring is a configuration
 * action — only a person or Audivra may do it; an agent is refused, so a model can never invent an identity,
 * tenant, role or credential. Keys are computed deterministically here so the same declaration always
 * projects to the same graph entity. No secret ever enters a declaration (the spec is redacted on write).
 */

const ENGAGEMENT_ID = /^[0-9a-z]{6,32}$/
const DECLARATION_ID = /^dom_[0-9a-z]{14}$/
const CLOSED = new Set(['completed', 'cancelled'])

export class DomainService {
  readonly #db: Db

  constructor(options: { db: Db }) {
    this.#db = options.db
  }

  /** Declares a domain record. People and Audivra only — agents are refused. Immutable in Step 1. */
  async declare(engagementId: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<SecurityDomainDeclaration> {
    assertConfigurationActor(actor)
    const data = parseOrThrow(CreateDomainDeclarationInput, input)
    const engagement = ENGAGEMENT_ID.test(engagementId) ? await getEngagementRow(this.#db, engagementId) : undefined
    if (!engagement) throw new SecurityRequestError(404, 'Engagement not found')
    if (CLOSED.has(engagement.status)) throw new SecurityRequestError(409, `The engagement is ${engagement.status} and can no longer be changed`)
    if (await findDomainDeclarationByRef(this.#db, engagementId, data.kind, data.ref)) {
      throw new SecurityRequestError(409, `A ${data.kind} declaration "${data.ref}" already exists for this engagement`)
    }
    await this.#validateReferences(engagementId, data.kind, data.spec as Record<string, unknown>)
    const mapping = domainSourceMapping(data.source)
    // Continue the version series if this handle was retired/superseded before.
    const history = (await listDomainDeclarationRows(this.#db, engagementId, { kind: data.kind, status: 'all' })).filter((r) => r.ref === data.ref)
    const version = history.length ? Math.max(...history.map((r) => r.version)) + 1 : 1
    const row = await createDomainDeclaration(this.#db, {
      id: newDomainDeclarationId(),
      engagementId,
      kind: data.kind,
      ref: data.ref,
      key: declarationKey(data.kind, data.ref, data.spec as Record<string, unknown>),
      label: data.label ?? data.ref,
      source: data.source,
      confidence: Math.min(data.confidence ?? mapping.confidenceCap, mapping.confidenceCap),
      spec: data.spec as Record<string, unknown>,
      createdBy: actor,
      version,
    })
    return toDomainDeclaration(row)
  }

  /** Updates a declaration: supersedes the active version and creates a new one (history is preserved). */
  async update(id: string, input: unknown, actor: SecurityActor = LOCAL_USER): Promise<SecurityDomainDeclaration> {
    assertConfigurationActor(actor)
    const current = await this.#activeDeclaration(id)
    const patch = parseOrThrow(UpdateDomainDeclarationInput, input)
    // Validate the new spec strictly against the declaration's kind (kind and handle are fixed).
    const data = parseOrThrow(CreateDomainDeclarationInput, { kind: current.kind, ref: current.ref, label: patch.label, source: patch.source ?? current.source, confidence: patch.confidence, spec: patch.spec })
    await this.#validateReferences(current.engagementId, data.kind, data.spec as Record<string, unknown>)
    const mapping = domainSourceMapping(data.source)
    const newId = newDomainDeclarationId()
    // Supersede the active version FIRST, so only one active row per handle ever exists (the partial unique index).
    await patchDomainDeclaration(this.#db, current.id, { status: 'superseded', supersededBy: newId })
    const row = await createDomainDeclaration(this.#db, {
      id: newId,
      engagementId: current.engagementId,
      kind: data.kind,
      ref: data.ref,
      key: declarationKey(data.kind, data.ref, data.spec as Record<string, unknown>),
      label: data.label ?? current.label,
      source: data.source,
      confidence: Math.min(data.confidence ?? mapping.confidenceCap, mapping.confidenceCap),
      spec: data.spec as Record<string, unknown>,
      createdBy: actor,
      version: current.version + 1,
    })
    return toDomainDeclaration(row)
  }

  /** Retires a declaration (its history is kept; it is no longer projected or resolvable). */
  async retire(id: string, actor: SecurityActor = LOCAL_USER): Promise<SecurityDomainDeclaration> {
    assertConfigurationActor(actor)
    const current = await this.#activeDeclaration(id)
    const row = await patchDomainDeclaration(this.#db, current.id, { status: 'retired', retiredAt: new Date() })
    return toDomainDeclaration(row ?? { ...current, status: 'retired' as DomainDeclarationStatus })
  }

  async list(engagementId: string, kind?: DomainDeclarationKind, status: DomainDeclarationStatus | 'all' = 'active'): Promise<SecurityDomainDeclaration[]> {
    await this.#engagement(engagementId)
    return (await listDomainDeclarationRows(this.#db, engagementId, { kind, status })).map(toDomainDeclaration)
  }

  async get(id: string): Promise<SecurityDomainDeclaration> {
    const row = DECLARATION_ID.test(id) ? await getDomainDeclarationRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Declaration not found')
    return toDomainDeclaration(row)
  }

  /**
   * Rejects dangling relationship references: a resource's owner must be a declared identity, an identity's
   * roles must be declared roles, an action's resources must exist, and an invariant's affected entities must
   * exist. Tenant/state handles stay opaque labels, and the (commonly circular) role↔action permission links
   * are projected leniently (`UNKNOWN != FALSE`), so declaration order is not forced for them.
   */
  async #validateReferences(engagementId: string, kind: DomainDeclarationKind, spec: Record<string, unknown>): Promise<void> {
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
    const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    const refs: { kind: DomainDeclarationKind; ref: string }[] = []
    // The acyclic ownership/role relationships (a resource's owner, an identity's roles) must resolve. The
    // commonly circular role↔action links and the forward invariant `affects` refs are projected leniently.
    if (kind === 'identity') for (const r of strList(spec.roleRefs)) refs.push({ kind: 'role', ref: r })
    if (kind === 'resource' && str(spec.ownerRef)) refs.push({ kind: 'identity', ref: str(spec.ownerRef)! })
    for (const r of refs) {
      if (!(await findDomainDeclarationByRef(this.#db, engagementId, r.kind, r.ref))) {
        throw new SecurityRequestError(400, `references ${r.kind} "${r.ref}", which is not declared for this engagement`)
      }
    }
  }

  async #activeDeclaration(id: string) {
    const row = DECLARATION_ID.test(id) ? await getDomainDeclarationRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Declaration not found')
    if (row.status !== 'active') throw new SecurityRequestError(409, `This declaration version is ${row.status}; update or retire the active version`)
    const engagement = await getEngagementRow(this.#db, row.engagementId)
    if (engagement && CLOSED.has(engagement.status)) throw new SecurityRequestError(409, `The engagement is ${engagement.status} and can no longer be changed`)
    return row
  }

  async #engagement(id: string) {
    const row = ENGAGEMENT_ID.test(id) ? await getEngagementRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Engagement not found')
    return row
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SecurityRequestError(400, parsed.error.issues.slice(0, 5).map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; '))
  }
  return parsed.data
}
