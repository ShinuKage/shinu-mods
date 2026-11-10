import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { fileKey } from '../hooks/shared/paths'
import { Classifier, EMPTY_RUN, LineSplitter, capLines, outputText, parseRunArgs } from '../hooks/run/logic'

const GODOT = 'C:/Godot/Godot_v4.6.3-stable_win64_console.exe'
const PROJECT = 'C:/game'
const OPTIONS = { options: { godotPath: GODOT } }
const OUTPUT_TOOL = 'mcp__godot-kit__godot_run_output'
const RUN_TOOL = 'mcp__godot-kit__godot_run'

/** Real Godot 4.6.3 output of a run, cut into pieces mid-line. */
const PIECES = [
  'Godot Engine v4.6.3.stable.official.7d41c59c4 - https://godotengine.org\n\ngame st',
  'arted\nWARNING: low ammo\n   at: push_warning (core/variant/variant_utility.cpp:1034)\n',
  '   GDScript backtrace (most recent call first):\n       [0] _ready (res://main.gd:7)\nERROR: enemy spawn failed\n',
  '   at: push_error (core/variant/variant_utility.cpp:1024)\n       [0] _ready (res://main.gd:8)\ntick 120',
]

describe('logic', () => {
  test('lines split across pieces', async () => {
    const s = new LineSplitter()
    expect(s.push('a\nb')).toEqual(['a'])
    expect(s.push('c\r\nd')).toEqual(['bc'])
    expect(s.flush()).toEqual(['d'])
  })

  test('errors and warnings with their res:// place', async () => {
    const c = new Classifier()
    const kinds: string[] = []
    const issues = []
    for (const line of PIECES.join('').split('\n')) {
      const { line: out, issue } = c.read(line, 'stderr')
      kinds.push(out.kind)
      if (issue) issues.push(issue)
    }
    expect(issues).toEqual([
      { kind: 'warning', message: 'low ammo', place: 'res://main.gd:7' },
      { kind: 'error', message: 'enemy spawn failed', place: 'res://main.gd:8' },
    ])
    expect(kinds.slice(3, 7)).toEqual(['warning', 'trace', 'trace', 'trace'])
    expect(kinds[kinds.length - 1]).toBe('err')
  })

  test('the buffer keeps the last lines', async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => ({ text: `l${i}`, kind: 'out' as const }))
    const capped = capLines([], lines, 0)
    expect(capped.lines.length).toBe(2000)
    expect(capped.lines[0]?.text).toBe('l500')
    expect(capped.dropped).toBe(500)
  })

  test('args and tool text', async () => {
    expect(parseRunArgs('')).toEqual({ scene: '', isHeadless: undefined })
    expect(parseRunArgs('scenes/level.tscn --headless')).toEqual({ scene: 'res://scenes/level.tscn', isHeadless: true })
    expect(parseRunArgs('res://a.tscn')).toEqual({ scene: 'res://a.tscn', isHeadless: undefined })
    expect(outputText(EMPTY_RUN, 10, false)).toContain('No game run yet')
  })
})

// ---- The mod in the engine -------------------------------------------------

type World = { pieces: string[]; code: number; isHanging: boolean; hasGodot: boolean }

function engine(on: On, world: World) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const spawned: (readonly string[])[] = []
  const runs: (readonly string[])[] = []
  const opened: string[] = []
  let release: () => void = () => {}
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__godot-kit__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: PROJECT }))
  on('fs.exists', (_, e) => ({ value: fileKey(e.path) === fileKey(`${PROJECT}/project.godot`) || (world.hasGodot && fileKey(e.path) === fileKey(GODOT)) }))
  on('process.run', (_, e) => {
    runs.push(e.argv)
    if (e.argv[0] === 'powershell') release()
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[] }) {
    spawned.push(e.argv)
    const gate = new Promise<void>(resolve => (release = resolve))
    for (const text of world.pieces) yield { stream: 'stderr' as const, text }
    if (world.isHanging) await gate
    return { value: { code: world.isHanging ? 1 : world.code, signal: null } }
  } as never)
  on('tool.call', (() => ({ result: {} })) as never)
  return { clock, spawned, runs, opened }
}

/** Moves the mocked clock until the call settles. */
async function drive<T>(clock: MockClock, call: Promise<T>): Promise<T> {
  let isDone = false
  void call.then(
    () => (isDone = true),
    () => (isDone = true),
  )
  for (let i = 0; i < 400 && !isDone; i++) await clock.advance(50)
  return call
}

type Loose = { tool: { call: (input: unknown) => Promise<{ result?: unknown; text?: string }> } }
const callTool = async ($: Engine, input: Record<string, unknown>) => {
  const ran = await ($ as unknown as Loose).tool.call(input)
  return String(ran.text ?? ran.result ?? '')
}
const output = ($: Engine, lines = 80) => callTool($, { tool: OUTPUT_TOOL, lines })
const start = ($: Engine, extra: Record<string, unknown> = {}) => callTool($, { tool: RUN_TOOL, action: 'start', waitSec: 1, ...extra })

const world = (over: Partial<World> = {}): World => ({ pieces: PIECES, code: 0, isHanging: false, hasGodot: true, ...over })
const boot = ($: Engine) => $.session.start({ cwd: PROJECT, surface: 'desktop', isInteractive: true })

test('a run streams its output, errors and warnings to Claude', OPTIONS, async ($, on) => {
  const eng = engine(on, world())
  await boot($)
  await drive(eng.clock, start($))
  await eng.clock.advance(500)

  expect(eng.spawned[0]).toEqual([GODOT, '--path', PROJECT, '--', eng.spawned[0]?.[4] ?? ''])
  expect(eng.spawned[0]?.[4]).toMatch(/^--godot-kit-run=1-\d+$/)
  const text = await output($)
  expect(text).toContain('Exited, code 0')
  expect(text).toContain('1 error, 1 warning')
  expect(text).toContain('ERROR: enemy spawn failed (res://main.gd:8)')
  expect(text).toContain('WARNING: low ammo (res://main.gd:7)')
  expect(text).toContain('game started')
  expect(text).toContain('tick 120')
  expect(eng.opened).toContain('godot-run')
})

test('a crash is called a crash and opens the pane', OPTIONS, async ($, on) => {
  const eng = engine(on, world({ code: 3 }))
  await boot($)
  await drive(eng.clock, start($, { headless: true, scene: 'scenes/level.tscn' }))
  await eng.clock.advance(500)
  expect(eng.spawned[0]).toContain('--headless')
  expect(eng.spawned[0]).toContain('res://scenes/level.tscn')
  expect(await output($)).toContain('Crashed, code 3')
})

test('Stop ends a game that keeps running, with no process left', OPTIONS, async ($, on) => {
  const eng = engine(on, world({ isHanging: true }))
  await boot($)
  await drive(eng.clock, start($))
  expect(await output($)).toContain('Running')

  expect(await drive(eng.clock, callTool($, { tool: RUN_TOOL, action: 'stop' }))).toBe('Stopped the game.')
  await eng.clock.advance(500)
  expect(await output($)).toContain('Stopped')
})

test('running again restarts: the old run is stopped first', OPTIONS, async ($, on) => {
  const eng = engine(on, world({ isHanging: true }))
  await boot($)
  await drive(eng.clock, start($))
  await drive(eng.clock, start($))
  expect(eng.spawned.length).toBe(2)
  const text = await output($)
  expect(text).toContain('Godot run #2')
  expect(text).toContain('Running')
})

test('the buffer is capped at 2,000 lines', OPTIONS, async ($, on) => {
  const many = Array.from({ length: 2500 }, (_, i) => `line ${i}\n`)
  const eng = engine(on, world({ pieces: [many.slice(0, 1200).join(''), many.slice(1200).join('')] }))
  await boot($)
  await drive(eng.clock, start($))
  await eng.clock.advance(500)
  const text = await output($, 400)
  expect(text).toContain('(2100 earlier not shown)')
  expect(text).toContain('line 2499')
  expect(text).not.toContain('line 2099\n')
})

test('a missing Godot fails softly', OPTIONS, async ($, on) => {
  const eng = engine(on, world({ hasGodot: false }))
  await boot($)
  expect(await drive(eng.clock, start($))).toContain('Godot not found')
  expect(eng.spawned).toEqual([])
})

const PANE = {
  plugin: 'godot-kit',
  component: 'Pane',
  requestId: 'godot-run',
  props: {
    title: 'Godot run',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the pane shows state, Stop and coloured lines, on every surface', { ...OPTIONS, timeoutMs: 20000 }, async ($, on) => {
  const eng = engine(on, world({ isHanging: true }))
  await boot($)
  await drive(eng.clock, start($))

  // While it runs: state, Stop, the error line; then Stop from the pane.
  const live = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await live.find({ type: 'Text', text: /Running/ })).toBeDefined()
  expect(await live.find({ type: 'Text', text: /^ERROR: enemy spawn failed$/ })).toBeDefined()
  expect(await live.find({ type: 'Text', text: /1 error/ })).toBeDefined()
  await drive(eng.clock, live.press({ key: 'stop' }))
  for (let i = 0; i < 60; i++) await eng.clock.advance(100)
  await live.unmount()
  expect(await output($)).toContain('Stopped')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^Godot run$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Stopped$/ })).toBeDefined()
    expect(await ui.find({ key: 'stop' })).toBe(undefined)
    expect(await ui.find({ key: 'restart' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^WARNING: low ammo$/ })).toBeDefined()
    await ui.unmount()
  }
})
