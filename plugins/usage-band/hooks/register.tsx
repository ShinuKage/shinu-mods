import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  UsageBandAlertMark,
  UsageBandReheat,
  UsageBandSnapshot,
  UsageBandTokens,
  UsageBandTtl,
} from '../types'
import {
  AUTO_LEAD_MS,
  LIMIT_LABEL,
  ORANGE,
  barCells,
  barSvg,
  barTextCells,
  cacheState,
  canReheat,
  formatClock,
  formatTokens,
  formatUsd,
  meterColor,
  resetsIn,
  shouldAutoReheat,
  stepAlert,
  windowId,
} from './logic'

// ---- session state (survives hot reloads) ---------------------------------

const ttlRef = { plugin: 'usage-band', key: 'ttl' } as const

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null as UsageBandSnapshot | null)
const lastWarmAt = atom({ plugin: 'usage-band', key: 'lastWarmAt' } as const, null as number | null)
const isBusy = atom({ plugin: 'usage-band', key: 'isBusy' } as const, false)
const autoReheat = atom({ plugin: 'usage-band', key: 'autoReheat' } as const, false)
const ttl = atom(ttlRef, '1h' as UsageBandTtl)
const reheat = atom({ plugin: 'usage-band', key: 'reheat' } as const, { phase: 'idle', at: 0, note: '' } as UsageBandReheat)
const contextAlert = atom({ plugin: 'usage-band', key: 'contextAlert' } as const, null as UsageBandAlertMark | null)
const tokens = atom({ plugin: 'usage-band', key: 'tokens' } as const, { input: 0, output: 0 } as UsageBandTokens)
const now = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
const autoFiredFor = atom({ plugin: 'usage-band', key: 'autoFiredFor' } as const, null as number | null)

/** Rate-limit alert marks are account-wide, so they live in `$.store`. */
const ALERTS_KEY = 'rateLimitAlerts'
const TTL_KEY = 'ttl'

const REHEAT_PROMPT =
  '[usage-band cache keep-alive] This is an automated request to keep the prompt cache warm. Reply with exactly: ok'

/** How long a reheat's result note stays on the band. */
const NOTE_MS = 12_000

type $ = EngineInterface

// ---- helpers -----------------------------------------------------------------

function toSnapshot(e: {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  context: { tokens?: number; window: number; percent?: number }
  cost?: { usd: number }
}): UsageBandSnapshot {
  return {
    rateLimits: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    context: { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent },
    costUsd: e.cost?.usd,
  }
}

let alertChain: Promise<void> = Promise.resolve()

/** Serialized, so two measurements in a row never toast the same crossing twice. */
function checkAlerts($: $, snap: UsageBandSnapshot): Promise<void> {
  alertChain = alertChain.then(() => runAlerts($, snap)).catch(() => undefined)
  return alertChain
}

async function runAlerts($: $, snap: UsageBandSnapshot): Promise<void> {
  const t = await $.clock.now()
  const stored = ((await $.store.get(ALERTS_KEY)) ?? {}) as Record<string, UsageBandAlertMark>
  let isChanged = false

  for (const limit of snap.rateLimits) {
    const label = LIMIT_LABEL[limit.kind]
    if (!label) continue
    const prev = stored[limit.kind]
    const { mark, alert } = stepAlert(prev, windowId(limit.kind, limit.resetsAt), limit.percentUsed)
    if (!prev || prev.level !== mark.level || prev.window !== mark.window) {
      stored[limit.kind] = mark
      isChanged = true
    }
    if (alert > 0) {
      const reset = resetsIn(t, limit.resetsAt)
      $.ui.toast(`${label} past ${alert}% (${Math.round(limit.percentUsed)}%)${reset ? ` · resets in ${reset}` : ''}`, {
        timeoutMs: 8000,
      })
    }
  }
  if (isChanged) await $.store.set(ALERTS_KEY, stored)

  const percent = snap.context.percent
  if (percent !== undefined) {
    const prev = await read($, contextAlert)
    const { mark, alert } = stepAlert(prev, 'context', percent)
    if (!prev || prev.level !== mark.level) await update($, contextAlert, () => mark)
    if (alert > 0) {
      $.ui.toast(`Context past ${alert}% (${formatTokens(snap.context.tokens)} / ${formatTokens(snap.context.window)} tokens)`, {
        timeoutMs: 8000,
      })
    }
  }
}

let isReheatingLocal = false

/**
 * Re-sends the main thread's last request (same model, system prompt, tools
 * and messages) with one tiny user message after it, via `$.model.fork`. The
 * API reads the whole prefix from the prompt cache, which resets its TTL.
 */
async function doReheat($: $, origin: 'manual' | 'auto'): Promise<void> {
  if (isReheatingLocal) return
  const t0 = await $.clock.now()
  const [warmAt, curTtl, busy, state] = await Promise.all([read($, lastWarmAt), read($, ttl), read($, isBusy), read($, reheat)])
  if (!canReheat(t0, warmAt, curTtl, busy, state.phase === 'running')) return

  isReheatingLocal = true
  try {
    await update($, reheat, () => ({ phase: 'running', at: t0, note: 'Reheating…' }))
    const r = await $.model.fork({ prompt: REHEAT_PROMPT })
    const t1 = await $.clock.now()

    if (r.isAnswered) {
      const u = r.usage
      await update($, lastWarmAt, () => t0)
      await update($, tokens, prev => ({
        input: prev.input + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        output: prev.output + u.output_tokens,
      }))
      const hit = u.cache_read_input_tokens > 0
      const note = hit
        ? `Reheated · ${formatTokens(u.cache_read_input_tokens)} read from cache`
        : `Re-cached · ${formatTokens(u.cache_creation_input_tokens)} written (cache had gone cold)`
      await update($, reheat, () => ({ phase: 'done', at: t1, note }))
      $.ui.toast(`${origin === 'auto' ? 'Auto-reheat: ' : ''}${note}`)
    } else {
      const why =
        r.reason === 'nothing-to-fork'
          ? 'nothing to reheat yet (no finished turn)'
          : r.reason === 'api-error'
            ? `API error ${r.status ?? ''}`.trim()
            : r.reason
      await update($, reheat, () => ({ phase: 'failed', at: t1, note: `Reheat failed: ${why}` }))
      $.ui.toast(`${origin === 'auto' ? 'Auto-reheat' : 'Reheat'} failed: ${why}`)
    }
  } finally {
    isReheatingLocal = false
  }
}

async function tick($: $): Promise<void> {
  const t = await $.clock.now()
  await update($, now, () => t)

  const [warmAt, curTtl, auto, busy, state, fired] = await Promise.all([
    read($, lastWarmAt),
    read($, ttl),
    read($, autoReheat),
    read($, isBusy),
    read($, reheat),
    read($, autoFiredFor),
  ])

  if (state.phase !== 'running' && state.phase !== 'idle' && t - state.at > NOTE_MS) {
    await update($, reheat, () => ({ phase: 'idle', at: t, note: '' }))
  }

  const go = shouldAutoReheat({
    now: t,
    lastWarmAt: warmAt,
    ttl: curTtl,
    autoReheat: auto,
    isBusy: busy,
    isReheating: state.phase === 'running' || isReheatingLocal,
    firedFor: fired,
  })
  if (go) {
    await update($, autoFiredFor, () => warmAt)
    await doReheat($, 'auto')
  }
}

// ---- hooks -------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // The TTL choice is kept across sessions; seed it when this session has none.
    const held = await $.state.get(ttlRef)
    if (held.version === 0) {
      const stored = await $.store.get(TTL_KEY)
      if (stored === '5m' || stored === '1h') await update($, ttl, () => stored)
    }

    const usage = await $.session.usage()
    await update($, snapshot, () => toSnapshot(usage))
    await update($, now, () => Date.now())

    $.clock.every(1000, () => {
      void tick($).catch(() => undefined)
    })

    return result
  })

  // Every main-thread request reads and refreshes the cached prefix: note when.
  // The time it is sent is the conservative start of the TTL.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const t = await $.clock.now()
      await update($, lastWarmAt, () => t)
    }
    return yield* next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, isBusy, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, isBusy, () => false)
    const u = e.usage
    if (u) {
      await update($, tokens, prev => ({
        input: prev.input + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        output: prev.output + u.output_tokens,
      }))
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const snap = toSnapshot(e)
    await update($, snapshot, () => snap)
    await checkAlerts($, snap)
    return next(e)
  })

  // A model switch reports the real TTL, and forfeits the old model's cache.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const real = e.cache_ttl
    if (real === '5m' || real === '1h') {
      await update($, ttl, () => real)
      await $.store.set(TTL_KEY, real)
    }
    await update($, lastWarmAt, () => null)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, lastWarmAt, () => null)
      await update($, contextAlert, () => null)
      await update($, tokens, () => ({ input: 0, output: 0 }))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const [snap, warmAt, curTtl, auto, busyState, state, tok, tNow] = await Promise.all([
      read($, snapshot),
      read($, lastWarmAt),
      read($, ttl),
      read($, autoReheat),
      read($, isBusy),
      read($, reheat),
      read($, tokens),
      read($, now),
    ])
    const t = tNow || Date.now()
    const busy = busyState || e.props.isWorking
    const cols = Math.max(30, e.props.bodyColumns)
    const gap = 3
    const meterW = Math.max(10, Math.floor((cols - gap * 2) / 3))

    const meter = (id: string, label: string, percent: number | undefined, detail: string) => {
      const color = meterColor(percent)
      const alt = percent === undefined ? `${label}: no reading` : `${label}: ${Math.round(percent)}%`
      let bar
      if (e.surface === 'terminal') {
        const { filled, empty } = barCells(percent, barTextCells(meterW))
        bar = (
          <Text wrap="truncate-end">
            <Text color={color}>{'━'.repeat(filled)}</Text>
            <Text dimColor>{'━'.repeat(empty)}</Text>
          </Text>
        )
      } else {
        const { Svg } = $.ui.resolve(e)
        bar = <Svg source={barSvg(percent, color)} alt={alt} height={5} />
      }
      return (
        <Box key={id} flexDirection="column" width={meterW} flexShrink={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor size="footnote" wrap="truncate-end">{label}</Text>
            <Text size="footnote" tabular wrap="truncate-start">
              <Text color={percent === undefined ? undefined : color} weight="semibold">
                {percent === undefined ? '—' : `${Math.round(percent)}%`}
              </Text>
              <Text dimColor>{detail ? ` · ${detail}` : ''}</Text>
            </Text>
          </Box>
          {bar}
        </Box>
      )
    }

    const limit = (kind: string) => snap?.rateLimits.find(r => r.kind === kind)
    const fiveH = limit('five_hour')
    const week = limit('seven_day')
    const limitDetail = (l: typeof fiveH) => {
      if (!l) return 'no reading yet'
      const r = resetsIn(t, l.resetsAt)
      return r ? `resets in ${r}` : ''
    }
    const ctx = snap?.context
    const ctxDetail = ctx ? `${formatTokens(ctx.tokens)} / ${formatTokens(ctx.window)}` : 'no reading yet'

    const cache = cacheState(t, warmAt, curTtl)
    const isRunning = state.phase === 'running'
    const reheatable = canReheat(t, warmAt, curTtl, busy, isRunning)
    const soon = cache.isWarm && cache.remainingMs <= AUTO_LEAD_MS
    const cacheDetail = cache.isWarm
      ? `cold in ${formatClock(cache.remainingMs)}`
      : warmAt === null
        ? 'no request yet'
        : 'expired'

    return (
      <Box flexDirection="column" gap={0} paddingX={1}>
        <Box flexDirection="row" gap={gap}>
          {meter('m-5h', '5h limit', fiveH?.percentUsed, limitDetail(fiveH))}
          {meter('m-week', 'Weekly limit', week?.percentUsed, limitDetail(week))}
          {meter('m-ctx', 'Context', ctx?.percent, ctxDetail)}
        </Box>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
          <Box flexDirection="row" alignItems="center" gap={2} flexShrink={1}>
            <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
              <Text size="footnote" tabular wrap="truncate-end">
                <Text color={cache.isWarm ? (soon ? '#EF4444' : ORANGE) : undefined} dimColor={!cache.isWarm}>
                  ●
                </Text>
                <Text weight="semibold">{cache.isWarm ? ' Cache warm' : ' Cache cold'}</Text>
                <Text dimColor>{` · ${cacheDetail}`}</Text>
              </Text>
              {reheatable ? (
                <Button key="reheat" plain onPress={() => void doReheat($, 'manual')}>
                  <Text color={ORANGE} weight="bold">
                    ↻
                  </Text>
                </Button>
              ) : (
                <Text dimColor size="footnote">
                  {isRunning ? '↻ reheating…' : '↻'}
                </Text>
              )}
            </Box>
            <Button
              key="ttl"
              plain
              dimColor
              onPress={async () => {
                const nextTtl: UsageBandTtl = (await read($, ttl)) === '1h' ? '5m' : '1h'
                await update($, ttl, () => nextTtl)
                await $.store.set(TTL_KEY, nextTtl)
              }}
            >
              {`TTL ${curTtl}`}
            </Button>
            <Button key="auto" plain onPress={() => update($, autoReheat, v => !v)}>
              <Text color={auto ? ORANGE : undefined} dimColor={!auto}>
                {auto ? '◉' : '○'}
              </Text>
              {auto ? ' Auto-reheat on' : ' Auto-reheat off'}
            </Button>
            {state.note && !isRunning ? (
              <Text dimColor size="footnote" wrap="truncate-end">
                {state.note}
              </Text>
            ) : null}
          </Box>
          <Text dimColor size="footnote" tabular wrap="truncate-start">
            {`${formatUsd(snap?.costUsd)} · ${formatTokens(tok.input)} in · ${formatTokens(tok.output)} out`}
          </Text>
        </Box>
      </Box>
    )
  })
}
