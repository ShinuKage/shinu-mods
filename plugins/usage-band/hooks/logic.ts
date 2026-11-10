// Pure logic for usage-band: thresholds, cache timing, formatting.
// No `$` here, so the tests exercise it directly.

export type Ttl = '5m' | '1h'
export type AlertMark = { window: string; level: number }

export const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

/** Auto-reheat fires once the cache has this much time left, or less... */
export const AUTO_LEAD_MS = 45_000
/** ...but not with less than this, when the request might land too late. */
export const AUTO_MIN_LEAD_MS = 5_000

export const LEVELS = [80, 90] as const

export function levelFor(percent: number | undefined): number {
  if (percent === undefined || !Number.isFinite(percent)) return 0
  if (percent >= 90) return 90
  if (percent >= 80) return 80
  return 0
}

/**
 * One measurement against the last alert mark. `alert` is the level to toast
 * (80 or 90) or 0. A new window, or a fall below a level, re-arms it.
 */
export function stepAlert(
  prev: AlertMark | null | undefined,
  window: string,
  percent: number | undefined,
): { mark: AlertMark; alert: number } {
  const base = prev && prev.window === window ? prev.level : 0
  const level = levelFor(percent)
  return { mark: { window, level }, alert: level > base ? level : 0 }
}

/** A window id that ignores jitter in `resetsAt` (rounded to 10 minutes). */
export function windowId(kind: string, resetsAt: string | undefined): string {
  if (!resetsAt) return kind
  const t = Date.parse(resetsAt)
  if (!Number.isFinite(t)) return `${kind}:${resetsAt}`
  return `${kind}:${Math.round(t / 600_000)}`
}

export type CacheState = { isWarm: boolean; remainingMs: number; expiresAt: number | null }

export function cacheState(now: number, lastWarmAt: number | null, ttl: Ttl): CacheState {
  if (lastWarmAt === null) return { isWarm: false, remainingMs: 0, expiresAt: null }
  const expiresAt = lastWarmAt + TTL_MS[ttl]
  const remainingMs = Math.max(0, expiresAt - now)
  return { isWarm: remainingMs > 0, remainingMs, expiresAt }
}

export type AutoInput = {
  now: number
  lastWarmAt: number | null
  ttl: Ttl
  autoReheat: boolean
  isBusy: boolean
  isReheating: boolean
  firedFor: number | null
}

/** Whether the auto-reheat should fire now: once per warm period, idle only. */
export function shouldAutoReheat(i: AutoInput): boolean {
  if (!i.autoReheat || i.isBusy || i.isReheating || i.lastWarmAt === null) return false
  if (i.firedFor === i.lastWarmAt) return false
  const { isWarm, remainingMs } = cacheState(i.now, i.lastWarmAt, i.ttl)
  return isWarm && remainingMs <= AUTO_LEAD_MS && remainingMs > AUTO_MIN_LEAD_MS
}

/** Whether a manual reheat may run: idle, warm, and none in flight. */
export function canReheat(now: number, lastWarmAt: number | null, ttl: Ttl, isBusy: boolean, isReheating: boolean): boolean {
  return !isBusy && !isReheating && cacheState(now, lastWarmAt, ttl).isWarm
}

/** `1h 40m`, `3d 4h`, `12m`, `45s`. */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** `4:05` or `59:12` or `1:00:00`: a ticking countdown. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function formatUsd(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '$—'
  return usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`
}

export function resetsIn(now: number, resetsAt: string | undefined): string | undefined {
  if (!resetsAt) return undefined
  const t = Date.parse(resetsAt)
  if (!Number.isFinite(t)) return undefined
  return formatSpan(t - now)
}

/** Orange while low, amber from 80%, red from 90%: the alert levels. */
export const ORANGE = '#F97316'
export const AMBER = '#F59E0B'
export const RED = '#EF4444'

export function meterColor(percent: number | undefined): string {
  const l = levelFor(percent)
  return l >= 90 ? RED : l >= 80 ? AMBER : ORANGE
}

/** A slim text bar: `filled` cells of ━ and the rest of the track. */
export function barCells(percent: number | undefined, width: number): { filled: number; empty: number } {
  const w = Math.max(4, Math.floor(width))
  const p = Math.min(100, Math.max(0, percent ?? 0))
  const filled = p > 0 ? Math.max(1, Math.round((p / 100) * w)) : 0
  return { filled, empty: w - filled }
}

/** Bar width in px for a meter `cells` wide: well inside its column, never wrapping. */
export function barPx(cells: number): number {
  return Math.max(48, Math.min(220, Math.floor(cells * 5.5)))
}

/** Text bar length for the terminal: a little short of the column. */
export function barTextCells(cells: number): number {
  return Math.max(4, Math.min(40, cells - 2))
}

/**
 * A slim rounded bar as wide as its section: a faint track and the colored
 * fill, in percentages of the drawn width (no viewBox, so the ends stay round).
 */
export function barSvg(percent: number | undefined, color: string, heightPx = 5): string {
  const p = Math.min(100, Math.max(0, percent ?? 0))
  const r = heightPx / 2
  const fill = p > 0 ? Math.max(1.5, Math.round(p * 10) / 10) : 0
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${heightPx}" preserveAspectRatio="none">` +
    `<rect x="0" y="0" width="100%" height="${heightPx}" rx="${r}" fill="#9CA3AF" fill-opacity="0.28"/>` +
    (fill > 0 ? `<rect x="0" y="0" width="${fill}%" height="${heightPx}" rx="${r}" fill="${color}"/>` : '') +
    `</svg>`
  )
}

export const LIMIT_LABEL: Record<string, string> = {
  five_hour: '5h limit',
  seven_day: 'Weekly limit',
}
