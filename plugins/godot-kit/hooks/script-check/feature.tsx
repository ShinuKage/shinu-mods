// Feature 1: the script check. After Claude writes a .gd file inside a Godot
// project, Godot loads it headless; the result goes to the status line, the
// /godot-errors pane, and (when it found errors) the tool result Claude reads.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, ToolCallResult, RenderInput } from 'claude-code'

import type { CheckNote, CheckState, GdError } from '../../types'

import { findGodot, findProject, forgetGodot, forgetProjects } from '../shared/config'
import type { KitConfig } from '../shared/config'
import { runGodot } from '../shared/godot'
import { fileKey, gdPathsIn, isAbsolute, isGdScript, join, norm, toRes } from '../shared/paths'
import {
  EMPTY_CHECK,
  byFile,
  contextFor,
  declaredClasses,
  errorCount,
  parseGodotOutput,
  statusText,
  unknownClasses,
} from './logic'

// Change the tag when CheckState's fields change: it declines what an older
// version stored, which outlives a reload.
const check = atom({ plugin: 'godot-kit', key: 'check' } as const, EMPTY_CHECK, { shape: 'check-1' })

export const PANE_ID = 'godot-errors'
export const COMMAND = 'godot-errors'
/** How long a check waits for more edits before Godot starts. */
export const GATHER_MS = 150
/** A fallback class-cache refresh is skipped this soon after the last one. */
const IMPORT_COOLDOWN_MS = 30_000

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

const ORANGE = '#F97316'
const GREEN = '#22C55E'
const RED = '#EF4444'
const AMBER = '#F59E0B'

// ---- Module state (a reload starts it over; nothing here must survive) ----

let config: KitConfig = { godotPath: '', projectPath: '', checkTimeoutMs: 20_000 }

type BatchResult = { kind: 'done'; found: Map<string, GdError[]> } | { kind: 'soft' }
type Batch = { project: string; files: Map<string, string>; result: Promise<BatchResult> }

/** One gathering batch per project; edits made while it waits join it. */
const pending = new Map<string, Batch>()
/** The Godot run in flight per project; the next batch waits for it. */
const running = new Map<string, Promise<BatchResult>>()
const lastImport = new Map<string, number>()
/** Files checked lately (key -> path), for Re-check. */
const recent = new Map<string, string>()

// ---- Checking ------------------------------------------------------------

function checkerScript($: EngineInterface): string {
  return join($.plugin.root, 'godot/check_many.gd')
}

async function setRunning($: EngineInterface, isRunning: boolean): Promise<void> {
  await update($, check, state => ({ ...state, isRunning }))
}

async function writeNote($: EngineInterface, note: CheckNote, noteDetail: string): Promise<void> {
  const now = await $.clock.now()
  await update($, check, state => ({ ...state, note, noteDetail, isRunning: false, checkedAt: now }))
  showStatus($, await read($, check))
}

function showStatus($: EngineInterface, state: CheckState): void {
  $.ui.status(statusText(state))
}

/** A new `class_name` the project's global class cache does not list yet. */
async function needsImport($: EngineInterface, project: string, files: readonly string[]): Promise<boolean> {
  const declared: string[] = []
  for (const file of files) {
    const source = await $.fs.read(file).catch(() => '')
    declared.push(...declaredClasses(source))
  }
  if (declared.length === 0) return false
  const cache = await $.fs.read(join(project, '.godot/global_script_class_cache.cfg')).catch(() => '')
  return declared.some(name => !cache.includes(`"${name}"`))
}

/** Refreshes .godot/ (the class cache) the way the editor's scan does. */
async function importProject($: EngineInterface, godot: string, project: string): Promise<void> {
  lastImport.set(fileKey(project), await $.clock.now())
  await runGodot($, godot, ['--headless', '--path', project, '--import'], Math.max(60_000, config.checkTimeoutMs * 3))
}

async function runChecker($: EngineInterface, godot: string, project: string, files: readonly string[]) {
  const args = ['--headless', '--path', project, '--script', checkerScript($), '--', ...files.map(f => toRes(f, project))]
  return runGodot($, godot, args, config.checkTimeoutMs)
}

/** One Godot run over `files` (all in `project`); updates state and the status line. */
async function checkFiles($: EngineInterface, project: string, files: readonly string[]): Promise<BatchResult> {
  await setRunning($, true)
  const godot = await findGodot($, config)
  if (godot === undefined) {
    await writeNote($, 'missing', config.godotPath === '' ? 'No Godot executable was found. Set godotPath in the plugin settings.' : `Not found: ${config.godotPath}`)
    return { kind: 'soft' }
  }

  const present: string[] = []
  for (const file of files) if (await $.fs.exists(file)) present.push(file)

  let found = new Map<string, GdError[]>()
  if (present.length > 0) {
    let isImported = false
    if (await needsImport($, project, present)) {
      await importProject($, godot, project)
      isImported = true
    }
    let run = await runChecker($, godot, project, present)
    if (run.kind === 'ran' && !isImported) {
      const errors = parseGodotOutput(run.output, project)
      const since = (await $.clock.now()) - (lastImport.get(fileKey(project)) ?? -Infinity)
      if (unknownClasses(errors).length > 0 && since > IMPORT_COOLDOWN_MS) {
        await importProject($, godot, project)
        run = await runChecker($, godot, project, present)
      }
    }
    if (run.kind !== 'ran') {
      if (run.kind === 'missing') forgetGodot()
      await writeNote($, run.kind, run.detail)
      return { kind: 'soft' }
    }
    found = byFile(parseGodotOutput(run.output, project))
  }

  const now = await $.clock.now()
  await update($, check, state => {
    const next: Record<string, GdError[]> = { ...state.files }
    for (const file of files) delete next[fileKey(file)]
    for (const [key, list] of found) next[key] = list
    return { files: next, note: null, noteDetail: '', isRunning: false, checkedAt: now, lastCount: files.length }
  })
  showStatus($, await read($, check))
  return { kind: 'done', found }
}

async function runBatch($: EngineInterface, key: string, batch: Batch): Promise<BatchResult> {
  try {
    await $.clock.sleep(GATHER_MS)
    const before = running.get(key)
    if (before !== undefined) await before
    if (pending.get(key) === batch) pending.delete(key)
    const work = checkFiles($, batch.project, [...batch.files.values()])
    running.set(key, work)
    try {
      return await work
    } finally {
      if (running.get(key) === work) running.delete(key)
    }
  } catch {
    if (pending.get(key) === batch) pending.delete(key)
    await setRunning($, false).catch(() => undefined)
    return { kind: 'soft' }
  }
}

/** Adds `file` to its project's gathering batch and resolves with that batch's result. */
function queueCheck($: EngineInterface, project: string, file: string): Promise<BatchResult> {
  const key = fileKey(project)
  recent.set(fileKey(file), file)
  if (recent.size > 50) recent.delete(recent.keys().next().value as string)
  let batch = pending.get(key)
  if (batch === undefined) {
    const created: Batch = { project, files: new Map(), result: Promise.resolve({ kind: 'soft' }) }
    pending.set(key, created)
    created.result = runBatch($, key, created)
    batch = created
  }
  batch.files.set(fileKey(file), file)
  return batch.result
}

/** Checks `files`, then adds what Claude should read to the tool's result. */
async function withCheck($: EngineInterface, ran: ToolCallResult, files: readonly string[]): Promise<ToolCallResult> {
  const waits: Promise<BatchResult>[] = []
  const touched: string[] = []
  for (const file of files) {
    const project = await findProject($, config, file)
    if (project === undefined) continue
    touched.push(file)
    waits.push(queueCheck($, project, file))
  }
  if (waits.length === 0) return ran

  const wasBad = new Set(Object.keys((await read($, check)).files))
  const found = new Map<string, GdError[]>()
  for (const result of await Promise.all([...new Set(waits)])) {
    if (result.kind === 'done') for (const [key, list] of result.found) found.set(key, list)
  }
  const note = contextFor(touched, found, wasBad)
  if (note === undefined) return ran
  const withNote = ran as ToolCallResult & { context?: readonly string[] }
  return { ...withNote, context: [...(withNote.context ?? []), note] } as ToolCallResult
}

async function mtimes($: EngineInterface, files: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const file of files) {
    const stat = await $.fs.stat(file).catch(() => undefined)
    out.set(file, stat === undefined ? -1 : stat.mtimeMs)
  }
  return out
}

export type ToolInput = { tool: unknown; file_path?: unknown; command?: unknown }
export type ToolNext = (e: never) => Promise<ToolCallResult>

/** The tool.call hook: never blocks or breaks the call itself. */
export async function onToolCall($: EngineInterface, e: ToolInput, next: ToolNext): Promise<ToolCallResult> {
  const call = next as unknown as (e: ToolInput) => Promise<ToolCallResult>
  const tool = String(e.tool)

  if (EDIT_TOOLS.has(tool)) {
    const file = typeof e.file_path === 'string' ? e.file_path : ''
    if (/(^|[\\/])project\.godot$/i.test(file)) forgetProjects()
    if (!isGdScript(file)) return call(e)
    const ran = await call(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    return withCheck($, ran, [norm(file)])
  }

  if (SHELL_TOOLS.has(tool) && typeof e.command === 'string') {
    const named = gdPathsIn(e.command)
    if (named.length === 0) return call(e)
    const root = await $.session.root()
    const files = named.map(p => (isAbsolute(p) ? norm(p) : join(root, p)))
    const before = await mtimes($, files)
    const ran = await call(e)
    if (ran.deny !== undefined) return ran
    const after = await mtimes($, files)
    const changed = files.filter(f => before.get(f) !== after.get(f))
    if (changed.length === 0) return ran
    return withCheck($, ran, changed)
  }

  return call(e)
}

/** Re-checks every file with errors and the ones checked lately. */
export async function recheckAll($: EngineInterface): Promise<void> {
  const files = new Map(recent)
  for (const list of Object.values((await read($, check)).files)) {
    for (const error of list) files.set(fileKey(error.file), error.file)
  }
  const waits: Promise<BatchResult>[] = []
  for (const file of files.values()) {
    const project = await findProject($, config, file)
    if (project !== undefined) waits.push(queueCheck($, project, file))
  }
  await Promise.all(waits)
}

// ---- Status, command and pane -------------------------------------------

export async function onSessionStart($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'godot-errors', description: 'Show the GDScript errors Godot found' })
  const state = await read($, check)
  if (state.isRunning) await setRunning($, false)
  showStatus($, state)
}

export async function onCommand($: EngineInterface): Promise<{ text: string }> {
  await $.ui.open({ id: PANE_ID, title: 'Godot errors' })
  const state = await read($, check)
  const n = errorCount(state)
  if (state.note !== null) return { text: `godot-kit: ${state.noteDetail}` }
  if (state.checkedAt === 0) return { text: 'godot-kit: no script checked yet.' }
  return { text: n === 0 ? 'godot-kit: GDScript ok.' : `godot-kit: ${n} script error${n === 1 ? '' : 's'}.` }
}

function clock(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export async function renderPane($: EngineInterface, e: RenderInput) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const state = await read($, check)
  const n = errorCount(state)
  const groups = Object.values(state.files)
    .filter(list => list.length > 0)
    .sort((a, b) => (a[0]?.res ?? '').localeCompare(b[0]?.res ?? ''))

  const summary =
    state.note !== null
      ? { text: `⚠ ${state.noteDetail}`, color: AMBER }
      : state.checkedAt === 0
        ? { text: 'No script checked yet. Edit a .gd file in a Godot project.', color: undefined }
        : n === 0
          ? { text: '✓ GDScript ok', color: GREEN }
          : { text: `✗ ${n} script error${n === 1 ? '' : 's'} in ${groups.length} file${groups.length === 1 ? '' : 's'}`, color: RED }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={ORANGE} weight="bold">Godot script check</Text>
        <Button key="recheck" label={state.isRunning ? 'Checking…' : 'Re-check'} onPress={() => void recheckAll($)} />
      </Box>
      <Text color={summary.color} weight="semibold">{summary.text}</Text>
      {groups.map(list => (
        <Box flexDirection="column">
          <Text color={ORANGE} weight="semibold" mono>{list[0]?.res ?? ''}</Text>
          {list.map(error => (
            <Text>
              <Text color={RED}>✗ </Text>
              <Text dimColor tabular mono>{`${error.line}`.padStart(4)}  </Text>
              {error.message}
            </Text>
          ))}
        </Box>
      ))}
      {state.checkedAt > 0 && (
        <Text dimColor>
          Last check {clock(state.checkedAt)} · {state.lastCount} script{state.lastCount === 1 ? '' : 's'}
        </Text>
      )}
    </Box>
  )
}

// ---- Wiring ---------------------------------------------------------------

export function registerScriptCheck(on: On, cfg: KitConfig): void {
  config = cfg
  on('command.run', { command: 'godot-errors' }, async $ => onCommand($))
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => renderPane($, e))
}
