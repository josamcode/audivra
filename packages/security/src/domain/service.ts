import { CreateDomainDeclarationInput, domainSourceMapping, type DomainDeclarationKind, type SecurityActor, type SecurityDomainDeclaration } from '@audivra/contracts'
import {
  createDomainDeclaration,
  findDomainDeclarationByRef,
  getDomainDeclarationRow,
  getEngagementRow,
  listDomainDeclarationRows,
  newDomainDeclarationId,
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
    const mapping = domainSourceMapping(data.source)
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
    })
    return toDomainDeclaration(row)
  }

  async list(engagementId: string, kind?: DomainDeclarationKind): Promise<SecurityDomainDeclaration[]> {
    await this.#engagement(engagementId)
    return (await listDomainDeclarationRows(this.#db, engagementId, { kind })).map(toDomainDeclaration)
  }

  async get(id: string): Promise<SecurityDomainDeclaration> {
    const row = DECLARATION_ID.test(id) ? await getDomainDeclarationRow(this.#db, id) : undefined
    if (!row) throw new SecurityRequestError(404, 'Declaration not found')
    return toDomainDeclaration(row)
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
