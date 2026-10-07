import type { EvidenceItem } from '@audivra/contracts'

/** Extracts every finite number appearing in an evidence item's title, summary and metadata. */
export function evidenceNumbers(item: EvidenceItem): number[] {
  const text = `${item.title}\n${item.summary}\n${JSON.stringify(item.metadata)}`
  const numbers: number[] = []
  // Thousands separators ("1,590") are joined before parsing; scientific notation is rare in evidence.
  for (const match of text.replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/-?\d+(?:\.\d+)?/g)) {
    const value = Number(match[0])
    if (Number.isFinite(value)) numbers.push(value)
  }
  return numbers
}

// Plausible presentation conversions between what was recorded and what is shown
// (ms ↔ s, bytes ↔ KB, ratio ↔ percent).
const FACTORS = [1, 1000, 0.001, 1024, 1 / 1024, 100, 0.01]

/**
 * True when `value` is grounded in the evidence: equal (within rounding tolerance) to a number found
 * in it, possibly after a unit conversion. Tolerance is 5% to allow rounded display ("~3.0 s").
 */
export function isGrounded(value: number, numbers: number[]): boolean {
  if (!Number.isFinite(value)) return false
  for (const recorded of numbers) {
    for (const factor of FACTORS) {
      const shown = value * factor
      const tolerance = Math.max(Math.abs(recorded) * 0.05, 0.051)
      if (Math.abs(recorded - shown) <= tolerance) return true
    }
  }
  return false
}
