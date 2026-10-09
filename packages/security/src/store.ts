import type { EngagementStatus, ScopeManifest, SecurityAuthorizationItem, SecurityEnvironment, SecurityEventItem, SecurityEvidenceItem, SecurityObservation } from '@audivra/contracts'
import {
  createSecurityEvidence,
  getEngagementRow,
  recordSecurityObservation,
  type RecordObservationInput,
  listAuthorizationRows,
  recordSecurityEvent,
  type CreateSecurityEvidenceInput,
  type Db,
  type RecordSecurityEventInput,
} from '@audivra/database'
import { toAuthorizationItem } from './authorization.ts'

/** The persisted engagement state the broker trusts (and nothing else). */
export interface EngagementSnapshot {
  id: string
  status: EngagementStatus
  environment: SecurityEnvironment | null
  policyProfileKey: string
  policyProfileVersion: number
  scope: ScopeManifest
  scopeVersion: number
  scopeHash: string
  configVersion: number
}

/** Persistence port of the broker. The PostgreSQL implementation is below; tests use an in-memory one. */
export interface SecurityStore {
  loadEngagement(id: string): Promise<{ engagement: EngagementSnapshot; authorizations: SecurityAuthorizationItem[] } | null>
  recordEvent(input: RecordSecurityEventInput): Promise<SecurityEventItem>
  recordEvidence(input: CreateSecurityEvidenceInput): Promise<SecurityEvidenceItem>
  recordObservation(input: RecordObservationInput): Promise<SecurityObservation>
}

export function createDbSecurityStore(db: Db, now: () => Date = () => new Date()): SecurityStore {
  return {
    async loadEngagement(id) {
      const row = await getEngagementRow(db, id)
      if (!row) return null
      const authorizations = (await listAuthorizationRows(db, [id])).map((a) => toAuthorizationItem(a, now()))
      return {
        engagement: {
          id: row.id,
          status: row.status,
          environment: row.environment,
          policyProfileKey: row.policyProfileKey,
          policyProfileVersion: row.policyProfileVersion,
          scope: row.scope,
          scopeVersion: row.scopeVersion,
          scopeHash: row.scopeHash,
          configVersion: row.configVersion,
        },
        authorizations,
      }
    },
    recordEvent: (input) => recordSecurityEvent(db, input),
    recordEvidence: (input) => createSecurityEvidence(db, input),
    recordObservation: (input) => recordSecurityObservation(db, input),
  }
}
