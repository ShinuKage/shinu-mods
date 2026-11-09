import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { EMPTY_TOTALS, addTurn, formatDuration, idleText, isLongTurn, liveText } from '../hooks/logic'

describe('formatting', () => {
  test('durations', async () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(42_900)).toBe('42s')
    expect(formatDuration(84_000)).toBe('1m 24s')
    expect(formatDuration(3_780_000)).toBe('1h 03m')
  })

  test('live and idle lines', async () => {
    expect(liveText(84_000, 7)).toBe('⏱ 1m 24s · 7 tools')
    expect(liveText(1_000, 1)).toBe('⏱ 1s · 1 tool')
    expect(idleText(EMPTY_TOTALS)).toBe(undefined)
    const one = addTurn(EMPTY_TOTALS, 190_000, 12)
    expect(idleText(one)).toBe('last turn 3m 10s · 12 tools')
    const two = addTurn(one, 80_000, 3)
    expect(two).toEqual({ turns: 2, totalMs: 270_000, tools: 15, lastMs: 80_000, lastTools: 3 })
    expect(idleText(two)).toBe('last turn 1m 20s · 3 tools · session 4m 30s, avg 2m 15s (2 turns)')
  })

  test('long-turn threshold is 10 minutes', async () => {
    expect(isLongTurn(599_999)).toBe(false)
    expect(isLongTurn(600_000)).toBe(true)
  })
})

/** The engine beneath the mod: records the status line and toasts. */
function engine(on: On) {
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // Typed loosely: the full tool union (MCP tools included) is too deep to infer.
  on('tool.call', (() => ({ result: {} })) as never)
  return { statuses, toasts, last: () => statuses[statuses.length - 1] }
}

/** A Bash call; typed loosely, as the full tool union is too deep to infer here. */
const bash = ($: Engine, command: string) =>
  ($ as unknown as LooseTool).tool.call({ tool: 'Bash', command })

type LooseTool = { tool: { call: (input: unknown) => Promise<unknown> } }

const done = (turnId: string, durationMs: number, agentId?: string) => ({
  turnId,
  durationMs,
  agentId,
  answer: '',
  isAborted: false,
  reason: 'answer' as const,
})

test('a turn ticks live, counts tools, then shows last-turn and session totals', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(seen.last()).toBe(undefined)

  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(seen.last()).toBe('⏱ 0s · 0 tools')

  await bash($, 'ls')
  await clock.advance(30_000)
  await bash($, 'pwd')
  // A subagent's turn neither restarts nor ends the main timer.
  await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'a1' })
  await $.turn.complete(done('s1', 5_000, 'a1'))
  await clock.advance(31_000)
  expect(seen.last()).toBe('⏱ 1m 01s · 2 tools')

  await $.turn.complete(done('t1', 61_000))
  expect(seen.last()).toBe('last turn 1m 01s · 2 tools')
  const after = seen.statuses.length
  await clock.advance(5_000)
  expect(seen.statuses.length).toBe(after) // the ticker stopped

  await $.turn.start({ text: 'again', turnId: 't2' })
  await clock.advance(29_000)
  await $.turn.complete(done('t2', 29_000))
  expect(seen.last()).toBe('last turn 29s · 0 tools · session 1m 30s, avg 45s (2 turns)')
  expect(seen.toasts).toEqual([])
})

test('a turn of 10 minutes or more raises one toast', async ($, on) => {
  mock.clock(on)
  const seen = engine(on)
  await $.turn.start({ text: 'long', turnId: 't1' })
  await bash($, 'ls')
  await $.turn.complete(done('t1', 612_000))
  expect(seen.toasts).toEqual(['Long turn: 10m 12s · 1 tool'])
})

test('a reload mid-turn keeps counting from the stored start', async ($, on) => {
  const clock = mock.clock(on, { now: 50_000 })
  on('state.get', (_, e) => ({
    value:
      e.key === 'active'
        ? { value: { shape: 'active-1', value: { turnId: 't1', startedAt: 20_000, tools: 4 } }, version: 1 }
        : { value: undefined, version: 0 },
  }))
  const seen = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(seen.last()).toBe('⏱ 30s · 4 tools')
  await clock.advance(1_000)
  expect(seen.last()).toBe('⏱ 31s · 4 tools')
})
