export interface Summary {
  n: number
  avg: number
  min: number
  max: number
  p95: number
  /** Mean absolute difference between consecutive samples: how unsteady the values are. */
  jitter: number
}

export function summarize(values: number[]): Summary | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const sum = values.reduce((a, b) => a + b, 0)
  let jit = 0
  for (let i = 1; i < values.length; i++) jit += Math.abs(values[i] - values[i - 1])
  return {
    n: values.length,
    avg: sum / values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)],
    jitter: values.length > 1 ? jit / (values.length - 1) : 0,
  }
}

/** Plain-words rating of a round-trip time in milliseconds. */
export function quality(rttMs: number | null): 'good' | 'fair' | 'poor' | 'unknown' {
  if (rttMs === null) return 'unknown'
  return rttMs < 50 ? 'good' : rttMs < 150 ? 'fair' : 'poor'
}
