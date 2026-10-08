import { redact, type ExecutionFailure, type ExecutionFailureKind } from '@audivra/contracts'
import { BudgetExceededError, ScopeViolationError } from '../http-client.ts'

/**
 * A classified runtime failure. Platform code throws it with a stable rule; anything else a capability
 * throws is classified by `classifyFailure`.
 */
export class ExecutionError extends Error {
  constructor(
    readonly kind: ExecutionFailureKind,
    readonly rule: string,
    message: string,
  ) {
    super(message)
    this.name = 'ExecutionError'
  }
}

/** Error messages are redacted and bounded before they are stored or shown. */
export function failureMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 1000)
}

export function failure(kind: ExecutionFailureKind, rule: string, message: string): ExecutionFailure {
  return { kind, rule, message: redact(message).slice(0, 1000) }
}

/**
 * Maps an error to a failure classification. Runtime errors keep their own kind and rule; the scoped
 * HTTP client's refusals are named; everything else a capability raises is an executor failure.
 */
export function classifyFailure(error: unknown): ExecutionFailure {
  if (error instanceof ExecutionError) return failure(error.kind, error.rule, error.message)
  if (error instanceof ScopeViolationError) return failure('executor-failed', 'http.scope-violation', error.message)
  if (error instanceof BudgetExceededError) return failure('executor-failed', 'http.budget-exceeded', error.message)
  return failure('executor-failed', 'executor.error', failureMessage(error))
}
