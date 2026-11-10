import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { rankGodot } from '../hooks/shared/config'
import { fileKey, gdPathsIn, toRes } from '../hooks/shared/paths'
import { EMPTY_CHECK, byFile, contextFor, parseGodotOutput, statusText } from '../hooks/script-check/logic'

const GODOT = 'C:/Godot/Godot_v4.6.3-stable_win64_console.exe'
const PROJECT = 'C:/game'
const OPTIONS = { options: { godotPath: GODOT } }

/** Real Godot 4.6.3 output for a script with two errors (trimmed). */
const TWO_ERRORS = [
  'Godot Engine v4.6.3.stable.official.7d41c59c4 - https://godotengine.org',
  '',
  'SCRIPT ERROR: Parse Error: Cannot assign a value of type "String" as "int".',
  '   at: GDScript::reload (res://player.gd:4)',
  '   GDScript backtrace (most recent call first):',
  '       [0] _init (C:/mods/godot-kit/godot/check_many.gd:5)',
  'SCRIPT ERROR: Parse Error: Function "undefined_fn()" not found in base self.',
  '   at: GDScript::reload (res://player.gd:5)',
  'SCRIPT ERROR: Parse Error: Function "undefined_fn()" not found in base self.',
  '   at: GDScript::reload (res://player.gd:5)',
  'ERROR: Failed to load script "res://player.gd" with error "Parse error".',
  '   at: load (modules/gdscript/gdscript.cpp:2907)',
].join('\n')

describe('logic', () => {
  test('parses Godot 4 output, deduplicated', async () => {
    const errors = parseGodotOutput(TWO_ERRORS, PROJECT)
    expect(errors).toEqual([
      { file: 'C:/game/player.gd', res: 'res://player.gd', line: 4, message: 'Cannot assign a value of type "String" as "int".' },
      { file: 'C:/game/player.gd', res: 'res://player.gd', line: 5, message: 'Function "undefined_fn()" not found in base self.' },
    ])
  })

  test('parses Godot 3 output', async () => {
    const out = 'SCRIPT ERROR: GDScript::reload: Parse Error: Unexpected token\n   At: res://a/b.gd:7.'
    expect(parseGodotOutput(out, PROJECT)).toEqual([
      { file: 'C:/game/a/b.gd', res: 'res://a/b.gd', line: 7, message: 'Unexpected token' },
    ])
  })

  test('status line text', async () => {
    expect(statusText(EMPTY_CHECK)).toBe(undefined)
    expect(statusText({ ...EMPTY_CHECK, checkedAt: 1 })).toBe('✓ GDScript ok')
    const bad = byFile(parseGodotOutput(TWO_ERRORS, PROJECT))
    expect(statusText({ ...EMPTY_CHECK, checkedAt: 1, files: Object.fromEntries(bad) })).toBe('✗ 2 script errors')
    expect(statusText({ ...EMPTY_CHECK, note: 'missing' })).toBe('⚠ Godot not found · set godotPath')
  })

  test('what Claude reads', async () => {
    const found = byFile(parseGodotOutput(TWO_ERRORS, PROJECT))
    const note = contextFor(['C:\\game\\player.gd'], found, new Set())
    expect(note).toContain('2 GDScript errors in res://player.gd')
    expect(note).toContain('res://player.gd:4: Cannot assign')
    expect(contextFor(['C:/game/player.gd'], new Map(), new Set([fileKey('C:/game/player.gd')]))).toContain('now passes')
    expect(contextFor(['C:/game/player.gd'], new Map(), new Set())).toBe(undefined)
  })

  test('paths', async () => {
    expect(toRes('C:\\game\\scripts\\p.gd', 'C:/game')).toBe('res://scripts/p.gd')
    expect(gdPathsIn('cat > scripts/enemy.gd <<EOF\nx\nEOF; cp "C:\\g\\a.gd" b.gd; ls res://x.gd *.gd')).toEqual([
      'scripts/enemy.gd',
      'C:\\g\\a.gd',
      'b.gd',
    ])
    expect(rankGodot(['Godot_v4.2-stable_win64.exe', 'Godot_v4.6.3-stable_win64.exe', 'Godot_v4.6.3-stable_win64_console.exe', 'notes.txt'])[0]).toBe(
      'Godot_v4.6.3-stable_win64_console.exe',
    )
  })
})

// ---- The mod in the engine -------------------------------------------------

type World = {
  /** Files that exist, by key. */
  files: Set<string>
  /** What the next Godot check prints. */
  output: string
  /** When set, Godot cannot start. */
  isBroken: boolean
}

/** The engine beneath the mod: a tiny file system, a scripted Godot, the status line. */
function engine(on: On, world: World) {
  const statuses: (string | undefined)[] = []
  const runs: (readonly string[])[] = []
  let mtime = 1
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'godot-errors' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: PROJECT }))
  on('fs.exists', (_, e) => ({ value: world.files.has(fileKey(e.path)) }))
  on('fs.read', () => ({ value: 'extends Node\n' }))
  on('fs.stat', (_, e) =>
    world.files.has(fileKey(e.path))
      ? { value: { kind: 'file', size: 1, mtimeMs: mtime++, isLink: false } }
      : { value: undefined as never },
  )
  on('process.run', (_, e) => {
    runs.push(e.argv)
    if (world.isBroken) throw new Error('spawn ENOENT')
    return { value: { exitCode: world.output === '' ? 0 : 1, stdout: '', stderr: world.output, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // Typed loosely: the full tool union (MCP tools included) is too deep to infer.
  on('tool.call', (() => ({ result: {} })) as never)
  return { statuses, runs, clock, last: () => statuses[statuses.length - 1] }
}

/** Moves the mocked clock until the call settles (the check waits a moment for more edits). */
async function drive<T>(clock: MockClock, call: Promise<T>): Promise<T> {
  let isDone = false
  void call.then(() => (isDone = true), () => (isDone = true))
  for (let i = 0; i < 100 && !isDone; i++) await clock.advance(50)
  return call
}

type Loose = { tool: { call: (input: unknown) => Promise<{ context?: readonly string[] }> } }
const edit = ($: Engine, file_path: string) =>
  ($ as unknown as Loose).tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })

function world(output = TWO_ERRORS): World {
  return {
    files: new Set([GODOT, `${PROJECT}/project.godot`, `${PROJECT}/player.gd`, `${PROJECT}/enemy.gd`].map(fileKey)),
    output,
    isBroken: false,
  }
}

const checks = (runs: readonly (readonly string[])[]) => runs.filter(argv => argv.includes('--script'))

test('a .gd edit runs one Godot check, shows ✗ and tells Claude', OPTIONS, async ($, on) => {
  const w = world()
  const eng = engine(on, w)
  const ran = await drive(eng.clock, edit($, 'C:\\game\\player.gd'))

  const [argv] = checks(eng.runs)
  expect(argv?.[0]).toBe(GODOT)
  expect(argv).toContain('--headless')
  expect(argv?.slice(-1)).toEqual(['res://player.gd'])
  expect(eng.last()).toBe('✗ 2 script errors')
  expect(ran.context?.join('\n')).toContain('res://player.gd:4: Cannot assign')

  // Claude fixes it: the next check is clean.
  w.output = ''
  const fixed = await drive(eng.clock, edit($, 'C:/game/player.gd'))
  expect(eng.last()).toBe('✓ GDScript ok')
  expect(fixed.context?.join('\n')).toContain('now passes')
})

test('non-.gd edits and scripts outside a Godot project are ignored', OPTIONS, async ($, on) => {
  const w = world()
  w.files.add(fileKey('C:/other/tool.gd'))
  const eng = engine(on, w)
  await drive(eng.clock, edit($, 'C:/game/README.md'))
  await drive(eng.clock, edit($, 'C:/other/tool.gd'))
  expect(eng.runs).toEqual([])
  expect(eng.statuses).toEqual([])
})

test('a missing Godot fails softly', OPTIONS, async ($, on) => {
  const w = world()
  w.files.delete(fileKey(GODOT))
  const eng = engine(on, w)
  const ran = await drive(eng.clock, edit($, 'C:/game/player.gd'))
  expect(eng.runs).toEqual([])
  expect(ran.context ?? []).toEqual([])
  expect(eng.last()).toBe('⚠ Godot not found · set godotPath')
})

test('a Godot that cannot start fails softly', OPTIONS, async ($, on) => {
  const w = world()
  w.isBroken = true
  const eng = engine(on, w)
  const ran = await drive(eng.clock, edit($, 'C:/game/player.gd'))
  expect(ran.context ?? []).toEqual([])
  expect(eng.last()).toBe('⚠ Godot not found · set godotPath')
})

test('edits made together share one Godot run', OPTIONS, async ($, on) => {
  const eng = engine(on, world())
  const [a, b] = await drive(eng.clock, Promise.all([edit($, 'C:/game/player.gd'), edit($, 'C:/game/enemy.gd')]))
  const runs = checks(eng.runs)
  expect(runs.length).toBe(1)
  expect(runs[0]).toContain('res://player.gd')
  expect(runs[0]).toContain('res://enemy.gd')
  expect(a.context?.join('\n')).toContain('res://player.gd')
  expect(b.context ?? []).toEqual([])
})

test('a shell command that writes a .gd file is checked', OPTIONS, async ($, on) => {
  const eng = engine(on, world())
  await drive(eng.clock, ($ as unknown as Loose).tool.call({ tool: 'Bash', command: "printf 'x' > player.gd" }))
  expect(checks(eng.runs)[0]).toContain('res://player.gd')
  await drive(eng.clock, ($ as unknown as Loose).tool.call({ tool: 'Bash', command: 'ls' }))
  expect(checks(eng.runs).length).toBe(1)
})

const PANE = {
  plugin: 'godot-kit',
  component: 'Pane',
  requestId: 'godot-errors',
  props: {
    title: 'Godot errors',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('the /godot-errors pane lists the errors, on every surface', OPTIONS, async ($, on) => {
  const eng = engine(on, world())
  await drive(eng.clock, edit($, 'C:/game/player.gd'))
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /script errors in/ }))?.text).toBe('✗ 2 script errors in 1 file')
    expect(await ui.find({ type: 'Text', text: /^res:\/\/player\.gd$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Cannot assign/ }))?.text).toContain('4')
    await ui.unmount()
  }
})
