import type { Usage } from '../types'

/** The four counts an API response reports, as `turn.step` carries them. */
export type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** One response's usage; `null` (no usage reported) counts as a missing response. */
export function fromResponse(usage: ApiUsage | null | undefined): Usage {
  if (usage == null) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 1, missing: 1 }
  }

  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
    responses: 1,
    missing: 0,
  }
}

export function addUsage(a: Usage | null | undefined, b: Usage): Usage {
  if (a == null) return b

  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    responses: a.responses + b.responses,
    missing: a.missing + b.missing,
  }
}

/** All input the model read: fresh, from the cache, and written to it. */
export function totalIn(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite
}

/** Share of all input served from the cache, 0-100, rounded; null with no input. */
export function cachedPercent(u: Usage): number | null {
  const all = totalIn(u)
  if (all === 0) return null

  return Math.round((u.cacheRead / all) * 100)
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`

  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/**
 * `12.4k in · 820 out · 10.9k cached (88%) · 400 written`: `written` only when
 * the cache was written, `cached` only when there was input; `usage n/a` when
 * no response summed reported usage.
 */
export function footerLine(u: Usage): string {
  if (u.responses > 0 && u.missing === u.responses) return 'usage n/a'

  const parts = [`${formatTokens(totalIn(u))} in`, `${formatTokens(u.output)} out`]
  const pct = cachedPercent(u)
  if (pct !== null) parts.push(`${formatTokens(u.cacheRead)} cached (${pct}%)`)
  if (u.cacheWrite > 0) parts.push(`${formatTokens(u.cacheWrite)} written`)
  if (u.missing > 0) parts.push(`${u.missing} of ${u.responses} without usage`)

  return parts.join(' · ')
}
