/** Event types persisted to the activity log and streamed to the UI over SSE. */
export const EVENT_TYPES = [
  'audit.created',
  'audit.started',
  'stage.started',
  'stage.completed',
  'stage.failed',
  'stage.skipped',
  'baseline.started',
  'baseline.completed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'tool.skipped',
  'agent.started',
  'agent.activity',
  'agent.note',
  'agent.completed',
  'agent.budget',
  'agent.failed',
  'evidence.created',
  'finding.created',
  'artifact.created',
  'report.ready',
  'review.started',
  'review.completed',
  'journeys.recorded',
  'changes.analyzed',
  'brief.generated',
  'audit.completed',
  'audit.failed',
  'audit.cancelled',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

/** Lightweight payload pushed over SSE; clients refetch details through the REST API. */
export interface StreamEvent {
  id: number
  auditId: string
  type: EventType
  level: 'info' | 'warn' | 'error'
  message: string
  data: Record<string, unknown> | null
  createdAt: string
}
