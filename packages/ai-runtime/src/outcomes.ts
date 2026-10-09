import { AI_OUTCOMES, isRefusal, isTransientOutcome, type AiOutcome } from '@audivra/contracts'
import type { AgentRunResult } from './provider.ts'

/*
 * Normalizes a provider run into one Audivra outcome, so the rest of the product never branches on raw
 * provider error strings. A provider adapter may set `terminationReason` to an explicit normalized
 * outcome (the fake test provider does this); otherwise the reason/error text is classified. The one
 * classification that must never be guessed loosely is a policy refusal — it is terminal for that
 * provider and is never rerouted elsewhere to evade it.
 */

const OUTCOME_SET: ReadonlySet<string> = new Set(AI_OUTCOMES)

export function classifyOutcome(result: Pick<AgentRunResult, 'status' | 'terminationReason' | 'error'>): AiOutcome {
  if (result.status === 'completed') return 'succeeded'
  if (result.status === 'cancelled') return 'cancelled'
  // An adapter may hand us an already-normalized outcome via the termination reason.
  if (OUTCOME_SET.has(result.terminationReason)) return result.terminationReason as AiOutcome

  const text = `${result.terminationReason} ${result.error ?? ''}`.toLowerCase()
  if (/refus|declin|cannot assist|can'?t help|won'?t help|not able to help|against (its|our|the) policy/.test(text)) return 'provider-refused'
  if (/rate.?limit|\b429\b|overloaded|too many requests/.test(text)) return 'rate-limited'
  if (/unauthor|\b401\b|\b403\b|not logged in|credential|forbidden|authentication/.test(text)) return 'auth-failed'
  if (/context (window|limit)|token limit|too long|maximum context|\b413\b/.test(text)) return 'context-limit'
  if (result.terminationReason === 'timeout' || result.terminationReason === 'max-turns' || /timed out|timeout/.test(text)) return 'provider-timeout'
  if (/ended without a result|enoent|spawn|not found|unavailable|econnrefused|connection refused|crash|socket hang up/.test(text)) return 'provider-unavailable'
  if (result.terminationReason === 'tool-budget') return 'tool-failure'
  return 'internal-error'
}

/** Transient outcomes may follow a bounded retry / configured fallback; refusals and permanent errors must not. */
export function isRetryableOutcome(outcome: AiOutcome): boolean {
  return isTransientOutcome(outcome)
}

export { isRefusal, isTransientOutcome }
