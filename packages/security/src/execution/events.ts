import type { SecurityActor, SecurityEventType } from '@audivra/contracts'
import type { SecurityStore } from '../store.ts'
import type { ExecutionRecord } from './store.ts'

/** Actor of lifecycle events the runtime records on its own. */
export const RUNTIME_ACTOR: SecurityActor = { kind: 'system', id: 'execution-runtime', agentRunId: null }

export type ExecutionEventType = Extract<SecurityEventType, `execution.${string}`>

/**
 * Records one concise lifecycle event of an execution in the append-only security events (redacted at
 * the persistence boundary). Events carry identifiers, states and small summaries — never raw logs.
 */
export function executionEvent(
  store: Pick<SecurityStore, 'recordEvent'>,
  execution: Pick<ExecutionRecord, 'id' | 'engagementId' | 'capabilityId' | 'configVersion'>,
  type: ExecutionEventType,
  message: string,
  data: Record<string, unknown> = {},
  level: 'info' | 'warn' | 'error' = 'info',
  actor: SecurityActor = RUNTIME_ACTOR,
) {
  return store.recordEvent({
    engagementId: execution.engagementId,
    type,
    level,
    message: message.slice(0, 500),
    actor,
    executionId: execution.id,
    capabilityId: execution.capabilityId,
    configVersion: execution.configVersion,
    data,
  })
}
