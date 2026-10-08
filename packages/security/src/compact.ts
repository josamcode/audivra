const OUTPUT_LIMIT = 20_000

/** Keeps stored outputs small: values whose JSON exceeds the limit are replaced by their size. */
export function compact(value: unknown): unknown {
  const json = JSON.stringify(value ?? null)
  return json.length > OUTPUT_LIMIT ? { truncated: true, size: json.length } : value
}
