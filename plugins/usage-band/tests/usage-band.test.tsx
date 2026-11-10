import { expect, mock, test } from 'claude-code/testing'

import {
  AUTO_LEAD_MS,
  TTL_MS,
  barCells,
  barPx,
  barSvg,
  barTextCells,
  cacheState,
  canReheat,
  formatClock,
  formatSpan,
  meterColor,
  shouldAutoReheat,
  stepAlert,
  windowId,
} from '../hooks/logic'

// ---- threshold logic -----------------------------------------------------------

test('alerts fire once at 80 and once at 90, per window', async () => {
  let mark = null as { window: string; level: number } | null
  const seen: number[] = []
  for (const p of [10, 79.9, 80, 82, 85, 89.9, 90, 95, 99]) {
    const r = stepAlert(mark, 'w1', p)
    mark = r.mark
    if (r.alert) seen.push(r.alert)
  }
  expect(seen).toEqual([80, 90])
})

test('a jump straight past 90 alerts once, at 90', async () => {
  const r = stepAlert(null, 'w1', 93)
  expect(r.alert).toBe(90)
  expect(stepAlert(r.mark, 'w1', 94).alert).toBe(0)
})

test('a new window or a drop below re-arms the alert', async () => {
  const at90 = { window: 'w1', level: 90 }
  expect(stepAlert(at90, 'w2', 85).alert).toBe(80)
  // context after a compaction falls to 40%, then climbs again
  const dropped = stepAlert(at90, 'context', 40)
  expect(dropped.alert).toBe(0)
  expect(stepAlert(dropped.mark, 'context', 81).alert).toBe(80)
})

test('a persisted mark stops a repeat after a reload', async () => {
  // what the code stored before the reload
  const stored = { window: windowId('five_hour', '2026-11-09T15:00:00Z'), level: 80 }
  const again = stepAlert(stored, windowId('five_hour', '2026-11-09T15:00:03Z'), 84)
  expect(again.alert).toBe(0)
})

test('window ids ignore seconds of jitter in resetsAt but not a new window', async () => {
  expect(windowId('five_hour', '2026-11-09T15:00:00Z')).toBe(windowId('five_hour', '2026-11-09T15:00:20Z'))
  expect(windowId('five_hour', '2026-11-09T15:00:00Z')).not.toBe(windowId('five_hour', '2026-11-09T20:00:00Z'))
})

test('meters go orange, then amber at 80, then red at 90', async () => {
  expect(meterColor(50)).toBe('#F97316')
  expect(meterColor(80)).toBe('#F59E0B')
  expect(meterColor(90)).toBe('#EF4444')
  expect(barCells(50, 20)).toEqual({ filled: 10, empty: 10 })
  expect(barCells(0.4, 20).filled).toBe(1)
})

// ---- reheat timing -------------------------------------------------------------

const base = {
  lastWarmAt: 1_000_000,
  ttl: '5m' as const,
  autoReheat: true,
  isBusy: false,
  isReheating: false,
  firedFor: null as number | null,
}
const at = (remainingMs: number, ttl: '5m' | '1h' = '5m') => base.lastWarmAt + TTL_MS[ttl] - remainingMs

test('auto-reheat waits until 45s are left, then fires', async () => {
  expect(shouldAutoReheat({ ...base, now: at(120_000) })).toBe(false)
  expect(shouldAutoReheat({ ...base, now: at(AUTO_LEAD_MS + 1000) })).toBe(false)
  expect(shouldAutoReheat({ ...base, now: at(AUTO_LEAD_MS) })).toBe(true)
  expect(shouldAutoReheat({ ...base, now: at(30_000) })).toBe(true)
})

test('auto-reheat honours the 1h TTL', async () => {
  expect(shouldAutoReheat({ ...base, ttl: '1h', now: at(10 * 60_000, '1h') })).toBe(false)
  expect(shouldAutoReheat({ ...base, ttl: '1h', now: at(40_000, '1h') })).toBe(true)
})

test('auto-reheat never fires mid-turn, when off, or once cold', async () => {
  const now = at(30_000)
  expect(shouldAutoReheat({ ...base, now, isBusy: true })).toBe(false)
  expect(shouldAutoReheat({ ...base, now, autoReheat: false })).toBe(false)
  expect(shouldAutoReheat({ ...base, now, isReheating: true })).toBe(false)
  expect(shouldAutoReheat({ ...base, now: at(3_000) })).toBe(false)
  expect(shouldAutoReheat({ ...base, now: at(-1_000) })).toBe(false)
  expect(shouldAutoReheat({ ...base, now, lastWarmAt: null })).toBe(false)
})

test('auto-reheat fires once per warm period', async () => {
  const now = at(30_000)
  expect(shouldAutoReheat({ ...base, now, firedFor: base.lastWarmAt })).toBe(false)
  // a successful reheat moves lastWarmAt: the next period is armed again
  expect(shouldAutoReheat({ ...base, now: now + 270_000, lastWarmAt: now, firedFor: base.lastWarmAt })).toBe(true)
})

test('manual reheat is offered only while warm and idle', async () => {
  expect(canReheat(at(60_000), base.lastWarmAt, '5m', false, false)).toBe(true)
  expect(canReheat(at(60_000), base.lastWarmAt, '5m', true, false)).toBe(false)
  expect(canReheat(at(60_000), base.lastWarmAt, '5m', false, true)).toBe(false)
  expect(canReheat(at(-1), base.lastWarmAt, '5m', false, false)).toBe(false)
  expect(canReheat(0, null, '5m', false, false)).toBe(false)
  expect(cacheState(at(65_000), base.lastWarmAt, '5m').remainingMs).toBe(65_000)
})

test('bars are capped inside their column', async () => {
  expect(barPx(36)).toBe(198)
  expect(barPx(200)).toBe(220)
  expect(barTextCells(36)).toBe(34)
  const svg = barSvg(50, '#F97316')
  expect(svg).toContain('width="100%"')
  expect(svg).toContain('width="50%"')
  expect(svg).toContain('height="5"')
  expect(barSvg(0, '#F97316')).not.toContain('#F97316')
})

test('countdowns read naturally', async () => {
  expect(formatSpan(100 * 60_000)).toBe('1h 40m')
  expect(formatSpan((3 * 24 + 4) * 3_600_000)).toBe('3d 4h')
  expect(formatClock(245_000)).toBe('4:05')
  expect(formatClock(3_600_000)).toBe('1:00:00')
})

// ---- through the engine --------------------------------------------------------

const measure = (five: number, ctx: number) => ({
  context: { tokens: ctx * 2000, window: 200_000, percent: ctx },
  rateLimits: [
    { kind: 'five_hour', percentUsed: five, resetsAt: '2026-11-09T15:00:00Z' },
    { kind: 'seven_day', percentUsed: 20, resetsAt: '2026-11-12T09:00:00Z' },
  ],
  cost: { usd: 1.25 },
  changed: ['rateLimits' as const],
})

test('session.measure toasts each crossing once, and not again after a reload', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  mock.clock(on, { now: Date.parse('2026-11-09T13:20:00Z') })
  mock.store(on)

  await $.session.measure(measure(70, 50))
  await $.session.measure(measure(81, 50))
  await $.session.measure(measure(83, 50))
  await $.session.measure(measure(91, 85))
  await $.session.measure(measure(92, 86))

  expect(toasts).toHaveLength(3)
  expect(toasts[0]).toContain('5h limit past 80%')
  expect(toasts[0]).toContain('resets in 1h 40m')
  expect(toasts[1]).toContain('5h limit past 90%')
  expect(toasts[2]).toContain('Context past 80%')
})

test('a mark stored before a reload stops the repeat toast', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  mock.clock(on, { now: Date.parse('2026-11-09T13:20:00Z') })
  mock.store(on, {
    rateLimitAlerts: { five_hour: { window: windowId('five_hour', '2026-11-09T15:00:00Z'), level: 90 } },
  })

  await $.session.measure(measure(95, 10))
  expect(toasts).toHaveLength(0)
})

const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 110,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('the band draws three meters and the cache row, on every surface', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  mock.store(on)
  await $.session.measure(measure(62, 42))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /5h limit/ }))?.text).toContain('5h limit')
    expect((await ui.find({ type: 'Text', text: /Weekly limit/ }))?.text).toContain('Weekly limit')
    expect((await ui.find({ type: 'Text', text: /Context/ }))?.text).toContain('Context')
    expect((await ui.find({ type: 'Text', text: /Cache cold/ }))?.text).toContain('no request yet')
    // cold: Reheat is not offered as a button
    expect(await ui.find({ type: 'Button', key: 'reheat' })).toBe(undefined)
    expect(await ui.find({ type: 'Button', key: 'auto' })).not.toBe(undefined)
    await ui.unmount()
  }
})

test('pressing Reheat forks the main thread and restarts the countdown', async ($, on) => {
  const t0 = Date.now()
  mock.clock(on, { now: t0 })
  mock.store(on)
  const forks: string[] = []
  on('model.fork', (_, e) => {
    forks.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  // a main-thread request went out a minute ago
  // (seeded only while never written, so the plugin's own writes still land)
  on('state.get', { plugin: 'usage-band', key: 'lastWarmAt' }, async (_, e, next) => {
    const r = await next(e)
    const held = (r as { value?: { value?: unknown; version: number } }).value
    return held && held.version === 0 ? { value: { value: t0 - 60_000, version: 0 } } : r
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Cache warm/ }))?.text).toContain('cold in')
  await ui.press({ key: 'reheat' })

  expect(forks).toHaveLength(1)
  expect(toasts[0]).toContain('Reheated')
  expect(toasts[0]).toContain('120k')
  await ui.unmount()
})
