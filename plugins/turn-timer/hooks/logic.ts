import type { SessionTotals } from '../types'

/** Turns at or past this length raise a toast when they end. */
export const LONG_TURN_MS = 10 * 60 * 1000

export const EMPTY_TOTALS: SessionTotals = {
  turns: 0,
  totalMs: 0,
  tools: 0,
  lastMs: 0,
  lastTools: 0,
}

/** 42s · 1m 24s · 1h 03m */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function toolsLabel(n: number): string {
  return `${n} ${n === 1 ? 'tool' : 'tools'}`
}

/** The line while a turn runs: ⏱ 1m 24s · 7 tools */
export function liveText(elapsedMs: number, tools: number): string {
  return `⏱ ${formatDuration(elapsedMs)} · ${toolsLabel(tools)}`
}

/** Totals after one more finished turn. */
export function addTurn(t: SessionTotals, ms: number, tools: number): SessionTotals {
  return {
    turns: t.turns + 1,
    totalMs: t.totalMs + ms,
    tools: t.tools + tools,
    lastMs: ms,
    lastTools: tools,
  }
}

/** The line between turns: last turn 3m 10s · 12 tools · session 18m 02s, avg 2m 15s */
export function idleText(t: SessionTotals): string | undefined {
  if (t.turns === 0) return undefined
  const last = `last turn ${formatDuration(t.lastMs)} · ${toolsLabel(t.lastTools)}`
  if (t.turns === 1) return last
  const avg = formatDuration(t.totalMs / t.turns)
  return `${last} · session ${formatDuration(t.totalMs)}, avg ${avg} (${t.turns} turns)`
}

export function isLongTurn(ms: number): boolean {
  return ms >= LONG_TURN_MS
}
